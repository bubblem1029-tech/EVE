/**
 * page-agent/agent.ts — KevePageAgent
 *
 * Re-Act agent for E2E test goal exploration.
 * Refactored from react-loop.ts to follow PageAgentCore patterns:
 *   - MacroTool: merge all tool schemas into one LLM output
 *   - History events: step/observation/error stream
 *   - Reflection-before-action: evaluation + memory + next_goal + action
 *   - Screenshot injected into LLM prompt as multimodal input — LLM self-evaluates visually
 *   - No external verification — LLM sees screenshot each step, judges goal state itself
 *
 * Usage:
 *   const agent = new KevePageAgent(page, { maxSteps: 5 });
 *   const result = await agent.execute(step, expected, { learnedActionsHint, fnResult });
 */

import type { Page } from '@playwright/test';
import { LLM, type Message, type ContentItem, type Tool } from '@kkeve/core/llm';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { /* scriptRefine, */ extractDiagnosticHints } from './hooks';
import { packMacroToolSchema, tools, getZodShape, type MacroToolInput, type ToolContext } from './tools';
import { loadConfig } from '../config';

// ─── System Prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system_prompt.md"), "utf-8");

// ─── Types ──────────────────────────────────────────────────────────────

export interface AgentStepEvent {
    type: 'step';
    stepIndex: number;
    evaluation: string;
    memory: string;
    nextGoal: string;
    toolName: string;
    toolInput: any;
    toolOutput: string;
    toolError?: string;
    snapshot: string;
    screenshotPath?: string;
}

export interface AgentObservationEvent {
    type: 'observation';
    content: string;
}

export interface AgentErrorEvent {
    type: 'error';
    message: string;
}

export type AgentEvent = AgentStepEvent | AgentObservationEvent | AgentErrorEvent;

export interface AgentResult {
    success: boolean;
    data: string;
    events: AgentEvent[];
    finalSnapshot: string;
    // refinePatch?: string; // 已注释：scriptRefine 已禁用
    agentScreenshots?: string[];
    diagnosticHints?: string[];
}

export interface AgentHooks {
    /** Called before task execution starts. */
    onBeforeTask?: (agent: KevePageAgent) => Promise<void> | void;
    /** Called after task execution completes. Return partial result to override fields. */
    onAfterTask?: (agent: KevePageAgent, result: AgentResult) => Promise<Partial<AgentResult> | void> | Partial<AgentResult> | void;
    /** Called before each step execution. */
    onBeforeStep?: (agent: KevePageAgent, stepCount: number) => Promise<void> | void;
    /** Called after each step execution (in finally block). */
    onAfterStep?: (agent: KevePageAgent, events: AgentEvent[]) => Promise<void> | void;
}

export interface AgentOptions {
    maxSteps?: number;
    learnedActionsHint?: string;
    customSystemPrompt?: string;
    specFilePath?: string;
    fnSource?: string;
    fnResult?: { error?: string; success?: boolean };
    hooks?: AgentHooks;
    /** External abort signal (e.g. per-goal timeout). When aborted, internal abortController is also triggered. */
    signal?: AbortSignal;
}

// ─── KevePageAgent ──────────────────────────────────────────────────────

export class KevePageAgent {
    readonly page: Page;
    readonly maxSteps: number;

    readonly llm: LLM;
    events: AgentEvent[] = [];
    private abortController = new AbortController();
    private systemPrompt: string;

    /** Current execute options (set at start of execute(), accessible from hooks) */
    options?: AgentOptions;

    private hooks?: AgentHooks;

    constructor(page: Page, options?: { maxSteps?: number; customSystemPrompt?: string; hooks?: AgentHooks }) {
        this.page = page;
        this.maxSteps = options?.maxSteps ?? 8;
        this.systemPrompt = options?.customSystemPrompt || SYSTEM_PROMPT;
        this.hooks = options?.hooks;

        const cfg = loadConfig();
        this.llm = new LLM({
            baseURL: cfg.llm.base_url,
            model: cfg.llm.model,
            apiKey: cfg.llm.api_key || '',
            temperature: 0.1,
            maxRetries: 3,
        });
    }

    /** Stop the current execution */
    stop(): void {
        this.abortController.abort();
    }

    /** Main Re-Act execute loop */
    async execute(step: string, expected: string, options?: AgentOptions): Promise<AgentResult> {
        // Reset state
        this.events = [];
        this.abortController = new AbortController();
        this.options = options;
        const hooks = options?.hooks ?? this.hooks;

        // Link external signal (e.g. per-goal timeout) to internal abort controller
        const externalSignal = options?.signal;
        if (externalSignal) {
            if (externalSignal.aborted) {
                throw new Error('Agent aborted before execution (external signal already aborted)');
            }
            externalSignal.addEventListener('abort', () => {
                this.abortController.abort();
            }, { once: true });
        }

        const maxSteps = options?.maxSteps ?? this.maxSteps;
        const systemPrompt = options?.customSystemPrompt || this.systemPrompt;

        // Inject context/learned hints as initial observations
        const targetUrl = process.env.KEVE_TARGET_URL || '';
        if (targetUrl) {
            this.pushObservation(`Target application URL: ${targetUrl}. Use this URL for navigation. Do NOT construct URLs yourself — use the navigate tool with this URL or read process.env.KEVE_TARGET_URL.`);
        }
        if (options?.learnedActionsHint) {
            this.pushObservation(`Previous discoveries for similar steps:\n${options.learnedActionsHint}`);
        }

        // Step limit warning
        if (maxSteps <= 3) {
            this.pushObservation(`⚠️ Only ${maxSteps} steps allowed. Be efficient.`);
        }

        // ── onBeforeTask hook ──
        await hooks?.onBeforeTask?.(this);

        let stepCount = 0;
        let taskResult: AgentResult;

        try {
            while (true) {
                if (this.abortController.signal.aborted) {
                    taskResult = this.buildResult(false, 'Agent stopped', stepCount);
                    break;
                }

                // ── onBeforeStep hook ──
                await hooks?.onBeforeStep?.(this, stepCount);

                try {
                    console.group(`step: ${stepCount}`);

                    // ── Observe: get browser state ──
                    console.log('\x1b[34m\x1b[1m👀 Observing...\x1b[0m');
                    const snapshot = await this.page.ariaSnapshot({ mode: 'ai' });
                    const url = this.page.url();
                    console.log(`  url: ${url.slice(0, 120)} | step ${stepCount + 1}/${maxSteps}`);

                    // ── Capture screenshot (used for both LLM multimodal input and artifact save) ──
                    let screenshotBuf: Buffer | undefined;
                    let screenshotBase64: string | undefined;
                    try {
                        screenshotBuf = await this.page.screenshot({ type: 'png', timeout: 10000 });
                        screenshotBase64 = screenshotBuf.toString('base64');
                    } catch (e: any) {
                        // Retry once with longer timeout (font loading can be slow on some pages)
                        try {
                            await new Promise(r => setTimeout(r, 500));
                            screenshotBuf = await this.page.screenshot({ type: 'png', timeout: 15000 });
                            screenshotBase64 = screenshotBuf.toString('base64');
                        } catch (e2: any) {
                            console.log(`[agent] screenshot capture failed (non-critical): ${e2.message}`);
                        }
                    }

                    // ── Assemble messages (multimodal: text + screenshot) ──
                    const userText = this.assembleUserPrompt(step, expected, snapshot, url, stepCount, maxSteps, !!screenshotBase64);
                    let userContent: string | ContentItem[];
                    if (screenshotBase64) {
                        userContent = [
                            { type: 'text', text: userText },
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'high' } },
                        ];
                    } else {
                        userContent = userText;
                    }
                    const messages: Message[] = [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent },
                    ];

                    // ── Think + Act: LLM decides ──
                    console.log('\x1b[34m\x1b[1m🧠 Thinking...\x1b[0m');
                    const macroTool = this.buildMacroTool();

                    const llmResult = await this.llm.invoke(
                        messages,
                        macroTool,
                        this.abortController.signal,
                        { toolChoiceName: 'AgentOutput' },
                    );

                    const macroInput = llmResult.toolCall.args as MacroToolInput;
                    const execResult = llmResult.toolResult as { toolName: string; output: string; error?: string; duration?: number };

                    const reflection = {
                        evaluation: macroInput.evaluation_previous_goal || '',
                        memory: macroInput.memory || '',
                        nextGoal: macroInput.next_goal || '',
                    };

                    // Print reflection
                    if (reflection.evaluation) console.log(`✅: ${reflection.evaluation.slice(0, 150)}`);
                    if (reflection.memory) console.log(`💾: ${reflection.memory.slice(0, 150)}`);
                    if (reflection.nextGoal) console.log(`🎯: ${reflection.nextGoal.slice(0, 150)}`);

                    const actionName = execResult.toolName;
                    const actionInput = macroInput;

                    // Save screenshot (reuse buffer already captured for LLM)
                    let screenshotPath: string | undefined;
                    if (screenshotBuf) {
                        try {
                            screenshotPath = this.saveScreenshotBuffer(screenshotBuf, stepCount, step);
                        } catch { /* non-critical */ }
                    }

                    // Record step event
                    if (execResult.error) {
                        console.log(`\x1b[31m\x1b[1m${actionName} (error: ${execResult.error.slice(0, 80)})\x1b[0m`);
                    } else if (execResult.duration !== undefined) {
                        console.log(`\x1b[32m\x1b[1m${actionName} executed for ${execResult.duration}ms\x1b[0m ${execResult.output.slice(0, 100)}`);
                    } else {
                        console.log(`\x1b[32m\x1b[1m${actionName}\x1b[0m ${execResult.output.slice(0, 100)}`);
                    }

                    const stepEvent: AgentStepEvent = {
                        type: 'step',
                        stepIndex: stepCount,
                        evaluation: reflection.evaluation,
                        memory: reflection.memory,
                        nextGoal: reflection.nextGoal,
                        toolName: actionName as string,
                        toolInput: actionInput,
                        toolOutput: execResult.output,
                        toolError: execResult.error,
                        snapshot,
                        screenshotPath,
                    };
                    this.events.push(stepEvent);

                    // If execution had error, add observation
                    if (execResult.error) {
                        this.pushObservation(`Action "${actionName}" failed: ${execResult.error}. Try a different approach.`);
                    }

                    // ── Check: if "done", return directly with test conclusion ──
                    if (actionName === 'done') {
                        // Extract conclusion: 4-level backoff
                        let conclusion: 'pass' | 'fail' | 'blocked';
                        const verdictField = actionInput?.verdict as string | undefined;
                        if (verdictField === 'pass' || verdictField === 'fail' || verdictField === 'blocked') {
                            // Level 1: explicit verdict field (preferred, no schema conflict)
                            conclusion = verdictField;
                        } else {
                            const resultField = actionInput?.result as string | undefined;
                            if (resultField === 'pass' || resultField === 'fail' || resultField === 'blocked') {
                                // Level 2: result field (legacy, may collide with other tools via passthrough)
                                conclusion = resultField;
                            } else if (typeof actionInput?.success === 'boolean') {
                                // Level 3: success boolean (legacy)
                                conclusion = actionInput.success ? 'pass' : 'fail';
                            } else {
                                // Level 4: parse text for verdict keyword (LLM often puts verdict in text)
                                // Use includes (not exact match) — text may be a long description
                                // IMPORTANT: Check fail/blocked BEFORE pass to avoid "不通过" hitting "通过"
                                const textVal = String(actionInput?.text || '').trim().toLowerCase();
                                if (textVal.includes('fail') || textVal.includes('failure')
                                    || textVal.includes('失败') || textVal.includes('未通过') || textVal.includes('不通过')) {
                                    conclusion = 'fail';
                                } else if (textVal.includes('blocked') || textVal.includes('阻塞') || textVal.includes('阻止')) {
                                    conclusion = 'blocked';
                                } else if (textVal.includes('pass') || textVal.includes('success') || textVal.includes('ok')
                                    || textVal.includes('完成') || textVal.includes('成功') || textVal.includes('通过')
                                    || textVal.includes('验证通过') || textVal.includes('符合预期') || textVal.includes('一致')
                                    || textVal.includes('匹配') || textVal.includes('确认') || textVal.includes('正确')
                                    || textVal.includes('无误') || textVal.includes('生效')) {
                                    conclusion = 'pass';
                                } else {
                                    // text 非空且无否定词 → LLM 写了一段验证结论，大概率是正面
                                    // text 为空 → 保守判 fail
                                    conclusion = textVal.length > 0 ? 'pass' : 'fail';
                                }
                            }
                        }
                        const data = String(actionInput?.text || { pass: 'Goal achieved', fail: 'Expected not achieved', blocked: 'Blocked' }[conclusion]);
                        const success = conclusion === 'pass';
                        console.log(`\x1b[32m\x1b[1mTask completed\x1b[0m ${conclusion} ${data}`);
                        taskResult = this.buildResult(success, data, stepCount, snapshot);
                        // Attach conclusion for downstream consumers (keve-report, keve-test)
                        (taskResult as any).conclusion = conclusion;
                        break;
                    }

                } catch (err: any) {
                    // LLM call or action failed — record error and continue
                    const isAbort = err?.name === 'AbortError' || err?.rawError?.name === 'AbortError';
                    if (!isAbort) console.error('\x1b[31mTask failed\x1b[0m', err);
                    const message = isAbort ? 'Agent stopped' : String(err);
                    this.events.push({ type: 'error', message });
                    if (!isAbort) this.pushObservation(`Error occurred: ${err.message}. Trying to recover.`);
                    if (isAbort) {
                        taskResult = this.buildResult(false, message, stepCount);
                        break;
                    }
                } finally {
                    console.groupEnd();
                    // ── onAfterStep hook (runs even on error/abort) ──
                    await hooks?.onAfterStep?.(this, this.events);
                }

                stepCount++;
                if (stepCount >= maxSteps) {
                    console.error(`\x1b[31mStep count exceeded maximum limit (${maxSteps})\x1b[0m`);
                    const finalSnapshot = await this.page.ariaSnapshot();
                    taskResult = this.buildResult(false, `Max steps (${maxSteps}) exceeded`, stepCount, finalSnapshot);
                    break;
                }

                // Small delay between steps for page stability
                await new Promise(r => setTimeout(r, 300));
            }
        } finally {
            // ── onAfterTask hook — may return partial overrides ──
            const hookResult = await hooks?.onAfterTask?.(this, taskResult!);
            if (hookResult && taskResult) {
                Object.assign(taskResult, hookResult);
            }
        }

        return taskResult!;
    }

    // ─── Internal helpers ──────────────────────────────────────────────

    private pushObservation(content: string): void {
        this.events.push({ type: 'observation', content });
    }

    private assembleUserPrompt(
        step: string,
        expected: string,
        snapshot: string,
        url: string,
        stepIndex: number,
        maxSteps: number,
        hasScreenshot: boolean,
    ): string {
        let prompt = '';

        // <agent_state>
        prompt += '<agent_state>\n';
        prompt += '<user_request>\n';
        prompt += `Step: ${step}\n`;
        prompt += `Expected: ${expected}\n`;
        prompt += '</user_request>\n';
        // <prior_execution>: deterministic fn script result (if fn was provided)
        if (this.options?.fnResult && (this.options.fnResult.success || this.options.fnResult.error)) {
            const resultLine = this.options.fnResult.success
                ? 'Result: success — all assertions passed'
                : `Result: error — ${this.options.fnResult.error}`;
            const sourceLine = this.options.fnSource
                ? `\nSource: ${this.options.fnSource}`
                : '';
            prompt += `<prior_execution>\nA deterministic script was executed BEFORE your Re-Act loop.\n${resultLine}${sourceLine}\n</prior_execution>\n`;
        }
        prompt += '<step_info>\n';
        prompt += `Step ${stepIndex + 1} of ${maxSteps} max steps\n`;
        prompt += `Current URL: ${url}\n`;
        prompt += `Current time: ${new Date().toLocaleString()}\n`;
        prompt += '</step_info>\n';
        prompt += '</agent_state>\n\n';

        // <agent_history>
        prompt += '<agent_history>\n';
        for (const event of this.events) {
            if (event.type === 'step') {
                prompt += `<step_${event.stepIndex + 1}>\n`;
                prompt += `Evaluation of Previous Step: ${event.evaluation}\n`;
                prompt += `Memory: ${event.memory}\n`;
                prompt += `Next Goal: ${event.nextGoal}\n`;
                prompt += `Action: ${event.toolName} → ${event.toolOutput || event.toolError || 'unknown'}\n`;
                prompt += `</step_${event.stepIndex + 1}>\n`;
            } else if (event.type === 'observation') {
                prompt += `<sys>${event.content}</sys>\n`;
            }
            // Skip error events in prompt to avoid polluting reasoning
        }
        prompt += '</agent_history>\n\n';

        // <browser_state>
        prompt += '<browser_state>\n';
        prompt += `Current URL: ${url}\n\n`;
        prompt += `Accessibility Tree (YAML):\n\`\`\`yaml\n${snapshot}\n\`\`\`\n`;
        if (hasScreenshot) {
            prompt += '\n<page_screenshot>\nA screenshot of the current page is provided as an image attached to this message. Use it as the primary visual source of truth for what is actually visible on the page. Cross-reference the screenshot with the accessibility tree to make accurate judgments — especially before calling done(success=true) to verify the expected state is truly achieved.\n</page_screenshot>\n';
        }
        prompt += '</browser_state>\n\n';

        return prompt;
    }

    private buildMacroTool(): Record<string, Tool> {
        const schema = packMacroToolSchema();
        const signal = this.abortController.signal;

        return {
            AgentOutput: {
                description: 'You MUST call this tool every step! Output your reflection and action.',
                inputSchema: schema,
                execute: async (input: MacroToolInput): Promise<{ toolName: string; output: string; error?: string; duration?: number }> => {
                    signal.throwIfAborted();

                    const toolName = String(input.tool || 'done');
                    const toolDef = tools.get(toolName);
                    if (!toolDef) {
                        return { toolName, output: '', error: `Unknown tool: ${toolName}` };
                    }

                    // Extract only the fields this tool needs from the flat input
                    const shape = getZodShape(toolDef.inputSchema);
                    const toolInput: Record<string, any> = {};
                    for (const key of Object.keys(shape)) {
                        if ((input as any)[key] !== undefined) {
                            toolInput[key] = (input as any)[key];
                        }
                    }

                    console.log(`\x1b[34m\x1b[1mExecuting tool: ${toolName}\x1b[0m`, toolInput);

                    try {
                        const ctx: ToolContext = { signal };
                        const startTime = Date.now();
                        const output = await toolDef.execute.bind(this)(toolInput, ctx);
                        signal.throwIfAborted();
                        const duration = Date.now() - startTime;
                        return { toolName, output, duration };
                    } catch (err: any) {
                        return { toolName, output: '', error: err.message || String(err) };
                    }
                },
            },
        };
    }

    /** Save screenshot buffer to test artifacts (reuses already-captured buffer) */
    private saveScreenshotBuffer(buf: Buffer, stepIndex: number, stepName: string): string | undefined {
        const taskDir = process.env.KEVE_TASK_DIR || '.keve';
        const round = process.env.KEVE_ROUND || 'latest';
        const screenshotsDir = path.join(taskDir, 'test-artifacts', `round-${round}`, 'screenshots');
        fs.mkdirSync(screenshotsDir, { recursive: true });
        const safeName = stepName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').slice(0, 30);
        const file = path.join(screenshotsDir, `agent-step${stepIndex}-${safeName}-${Date.now()}.png`);
        fs.writeFileSync(file, buf);
        return path.relative(taskDir, file);
    }

    /**
     * Visual element location: uses LLM multimodal to identify element bbox in screenshot.
     * Returns normalized bbox (0-1000 scale) for coordinate-based clicking.
     */
    async visualLocateElement(
        screenshotBase64: string,
        description: string,
    ): Promise<{ found: boolean; bbox?: number[]; analysis?: string }> {
        const locateToolSchema = z.object({
            bbox: z.array(z.number()).describe('Bounding box [x1, y1, x2, y2] in 0-1000 normalized coordinates'),
            analysis: z.string().describe('Brief description of what was found'),
        });

        const messages: Message[] = [
            {
                role: 'system',
                content: `You are a UI element locator. Find the described element in the screenshot and return its bounding box.

Output JSON with:
- bbox: [x1, y1, x2, y2] in 0-1000 scale (relative to screenshot size)
- analysis: brief description

If element not found, return empty bbox: [] and explain in analysis.

IMPORTANT: Respond in Chinese.`,
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `\u8bf7\u5728\u622a\u56fe\u4e2d\u627e\u5230\u4ee5\u4e0b\u5143\u7d20\uff1a${description}\n\n\u8fd4\u56de bbox [x1, y1, x2, y2]\uff0c\u5750\u6807\u8303\u56f4 0-1000\u3002` },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'high' } },
                ] as ContentItem[],
            },
        ];

        try {
            const result = await this.llm.invoke(messages, {
                LocateResult: {
                    description: 'Return the bounding box of the located element',
                    inputSchema: locateToolSchema,
                    execute: async (args: any) => args,
                },
            }, this.abortController.signal, { toolChoiceName: 'LocateResult' });

            const parsed = result.toolCall.args as { bbox: number[]; analysis: string };
            const bbox = parsed.bbox || [];

            if (bbox.length === 4 && bbox.every(v => typeof v === 'number' && !isNaN(v) && v >= 0 && v <= 1000) && bbox[2] > bbox[0] && bbox[3] > bbox[1]) {
                return { found: true, bbox, analysis: parsed.analysis };
            }

            return { found: false, analysis: parsed.analysis || 'LLM returned invalid bbox' };
        } catch (e: any) {
            return { found: false, analysis: `LLM invoke error: ${e.message}` };
        }
    }

    /** Build final result */
    private buildResult(
        success: boolean,
        data: string,
        stepCount: number,
        finalSnapshot?: string,
        // refinePatch?: string, // 已注释：scriptRefine 已禁用
    ): AgentResult {
        const snapshot = finalSnapshot || '';
        if (!success) {
            this.events.push({ type: 'error', message: data });
        }
        // Collect screenshot paths from step events
        const screenshotPaths = this.events
            .filter((e): e is AgentStepEvent => e.type === 'step')
            .filter(e => e.screenshotPath)
            .map(e => e.screenshotPath!);
        return { success, data, events: this.events, finalSnapshot: snapshot, /* refinePatch, */ agentScreenshots: screenshotPaths.length ? screenshotPaths : undefined };
    }
}


/**
 * @deprecated Use `new KevePageAgent(page).execute(step, expected, options)` directly.
 * Drop-in replacement for the old reactLoop function.
 * Creates a KevePageAgent, runs it, and maps the result.
 */
export async function reactLoop(
    page: Page,
    step: string,
    expected: string,
    options: {
        maxSteps?: number;
        learnedActionsHint?: string;
        specFilePath?: string;
        fnSource?: string;
        fnResult?: { error?: string; success?: boolean };
        signal?: AbortSignal;
    } = {},
): Promise<{
    actions: any[];
    expectedMet: boolean;
    conclusion?: 'pass' | 'fail' | 'blocked';
    finalSnapshot: string;
    // refinePatch?: string; // 已注释：scriptRefine 已禁用
    agentScreenshots?: string[];
}> {
    const agent = new KevePageAgent(page, {
        maxSteps: options.maxSteps ?? 20,
        hooks: {
            onAfterTask: async (_agent, result) => {
                const partial: Partial<AgentResult> = {};
                // 1. Diagnostic hints for failures
                if (!result.success) {
                    try {
                        partial.diagnosticHints = await extractDiagnosticHints(_agent.page, result);
                    } catch { /* non-critical */ }
                }
                // 2. Script refine for successes — 已注释：产出无下游消费且不受 keveGoal 超时控制
                // if (result.success) {
                //     const opts = _agent.options;
                //     if (opts?.specFilePath && opts?.fnSource) {
                //         try {
                //             const reactActions = result.events
                //                 .filter((e): e is AgentStepEvent => e.type === 'step')
                //                 .filter(e => e.toolName !== 'done')
                //                 .map(e => ({ tool: e.toolName, role: e.toolInput?.role, name: e.toolInput?.name, url: e.toolInput?.url, text: e.toolInput?.text, key: e.toolInput?.key, evaluation: e.evaluation }));
                //             const patch = await scriptRefine(_agent.llm, {
                //                 specFilePath: opts.specFilePath,
                //                 step, expected,
                //                 testTitle: step,
                //                 order: result.events.filter((e): e is AgentStepEvent => e.type === 'step').length,
                //                 fnSource: opts.fnSource,
                //                 gap: opts.contextHint || '',
                //                 reactActions,
                //             });
                //             if (patch) partial.refinePatch = patch;
                //         } catch { /* non-critical */ }
                //     }
                // }
                return Object.keys(partial).length ? partial : undefined;
            },
        },
    });
    let result: Awaited<ReturnType<typeof agent.execute>>;
    try {
        result = await agent.execute(step, expected, {
            learnedActionsHint: options.learnedActionsHint,
            specFilePath: options.specFilePath,
            fnSource: options.fnSource,
            fnResult: options.fnResult,
            signal: options.signal,
        });
    } catch (execErr: any) {
        const msg = execErr?.message || String(execErr);
        console.log(`[agent] execute interrupted: ${msg.slice(0, 200)}`);
        const partialEvents = agent.events.filter((e): e is AgentStepEvent => e.type === 'step');
        result = {
            success: false,
            message: `Agent interrupted: ${msg.slice(0, 100)}`,
            stepCount: partialEvents.length,
            finalSnapshot: '',
            events: agent.events,
            agentScreenshots: agent.events
                .filter((e): e is AgentStepEvent => e.type === 'step')
                .filter(e => e.screenshotPath)
                .map(e => e.screenshotPath!),
        } as any;
    }

    const actions = result.events
        .filter((e): e is AgentStepEvent => e.type === 'step')
        .map(e => ({
            step: e.stepIndex,
            action: { tool: e.toolName, ...e.toolInput },
            toolOutput: e.toolOutput,
            snapshot: e.snapshot,
            evaluation: e.evaluation,
            memory: e.memory,
            nextGoal: e.nextGoal,
            result: e.toolError ? 'error' as const : 'ok' as const,
            error: e.toolError,
            source: 'react' as const,
            screenshotPath: e.screenshotPath,
        }));

    return {
        actions,
        expectedMet: result.success,
        conclusion: (result as any).conclusion,
        finalSnapshot: result.finalSnapshot,
        // refinePatch: result.refinePatch, // 已注释：scriptRefine 已禁用
        agentScreenshots: result.agentScreenshots,
    };
}
