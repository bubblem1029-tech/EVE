/**
 * page-agent/agent.ts — KevePageAgent
 *
 * Re-Act agent for E2E test goal exploration.
 * Refactored from react-loop.ts to follow PageAgentCore patterns:
 *   - MacroTool: merge all tool schemas into one LLM output
 *   - History events: step/observation/error stream
 *   - Reflection-before-action: evaluation + memory + next_goal + action
 *   - Per-step: ariaSnapshot text only (no screenshot) — Option C
 *   - Initial screenshots (goal-before + fn-after) injected on step 0 as multimodal context
 *   - Done-time screenshot captured as goal-after evidence
 *   - On-demand screenshots via visual_locate tool (when element needs visual identification)
 *
 * Usage:
 *   const agent = new KevePageAgent(page, { maxSteps: 5 });
 *   const result = await agent.execute(step, expected, { learnedActionsHint, fnResult });
 */

import { LLM, type Message, type ContentItem, type Tool } from '@kkeve/core/llm';
import { z } from 'zod';
import { /* scriptRefine, */ extractDiagnosticHints } from './hooks.js';
import { packMacroToolSchema, tools, getZodShape, type MacroToolInput, type ToolContext } from './tools.js';
import type { AgentInitialImageLoader, AgentPage, AgentScreenshotSaver } from './page-like.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { toAgentPage } from './playwright-page.js';
import {
    buildRuntimeDiagnostics,
    clipDiagnosticText,
    isStaticUrl,
    pagePerformanceProbeSource,
    type PagePerformanceMetrics,
    type RawAiUsageRecord,
    type RawConsoleRecord,
    type RawNetworkRecord,
    type RuntimeDiagnostics,
} from './diagnostics.js';

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
    /** 工具执行耗时（ms）；LLM 调度异常时缺省 */
    duration?: number;
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
    /** 运行诊断：性能、网络、浏览器错误与质量信号 */
    diagnostics?: RuntimeDiagnostics;
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
    /** goal-before 截图路径（相对 taskDir）— fn 执行前的页面原始状态 */
    goalScreenshotBefore?: string;
    /** fn-after 截图路径（相对 taskDir）— fn 执行后的页面状态 */
    fnAfterScreenshot?: string;
}

/**
 * Agent 的宿主能力注入点。
 *
 * `page-agent` 现在同时服务 Playwright 与 Cypress（浏览器 bundle），因此不能再
 * 直接持有 Node API。所有原本写死的 Node 能力（读 prompt / 落盘截图 / 读本地
 * 图片 / 读环境变量 / LLM 传输）都改为构造时注入；Playwright 侧给 Node 实现，
 * Cypress 侧给 HTTP 桥实现。
 */
export interface AgentHostOptions {
    /** system prompt 文本（缺省用编译期内联的 SYSTEM_PROMPT） */
    systemPrompt?: string;
    /** 目标应用 URL（原 process.env.KEVE_TARGET_URL） */
    targetUrl?: string;
    /** 环境变量读取（原 process.env.X），缺省返回空串 */
    getEnv?: (name: string) => string;
    /** 截图落盘，返回相对 taskDir 的路径（原 saveScreenshotBuffer 的 fs 部分） */
    saveScreenshot?: AgentScreenshotSaver;
    /** 读取初始多模态截图（原 loadInitialScreenshots 的 fs 部分） */
    loadInitialImages?: AgentInitialImageLoader;
    /** LLM 配置；缺省从注入的环境变量拼装 */
    llm?: {
        baseURL: string;
        model: string;
        apiKey?: string;
        temperature?: number;
        maxRetries?: number;
        /** 浏览器侧经桥转发；Node 侧缺省走原生 fetch */
        customFetch?: typeof globalThis.fetch;
    };
}

// ─── Snapshot diff helpers (used by assembleUserPrompt to add Page Change to history) ───

/** Find the snapshot string of the previous step event before index `i`. */
function findPrevStepSnapshot(events: any[], currentIdx: number): string | undefined {
    for (let j = currentIdx - 1; j >= 0; j--) {
        if (events[j].type === 'step' && events[j].snapshot) return events[j].snapshot;
    }
    return undefined;
}

/**
 * Summarize key differences between two a11y snapshots.
 * Returns a short human-readable string or '' if nothing notable changed.
 *
 * Detects: dialog/modal appearance/disappearance, new/removed elements,
 * value changes in inputs, and repeated identical snapshots (no change).
 */
function summarizeSnapshotDiff(prev: string, curr: string): string {
    if (prev === curr) return 'no visible change on page';

    const prevLines = prev.split('\n');
    const currLines = curr.split('\n');

    const changes: string[] = [];

    // 1. Detect dialog/modal appearance or disappearance
    const prevDialogs = prevLines.filter(l => /dialog|modal|alertdialog/i.test(l) && /\[ref=/.test(l));
    const currDialogs = currLines.filter(l => /dialog|modal|alertdialog/i.test(l) && /\[ref=/.test(l));
    if (currDialogs.length > prevDialogs.length) {
        const newDialog = currDialogs.find(cd => !prevDialogs.some(pd => pd === cd));
        if (newDialog) {
            const nameMatch = newDialog.match(/"([^"]+)"/);
            changes.push(`dialog "${nameMatch?.[1] || '?'}" appeared`);
        }
    } else if (currDialogs.length < prevDialogs.length) {
        changes.push('dialog closed');
    }

    // 2. Detect new warning/error text nodes (e.g. validation errors)
    const prevWarnings = prevLines.filter(l => /warning|error|alert|⚠|❌/i.test(l) && /\[ref=/.test(l));
    const currWarnings = currLines.filter(l => /warning|error|alert|⚠|❌/i.test(l) && /\[ref=/.test(l));
    for (const w of currWarnings) {
        if (!prevWarnings.some(pw => pw === w)) {
            const textMatch = w.match(/"([^"]+)"/);
            changes.push(`new warning/error: "${textMatch?.[1] || '?'}"`);
        }
    }

    // 3. Count added/removed interactive elements (simplified: lines with [ref=])
    const prevRefs = new Set(prevLines.filter(l => /\[ref=/.test(l)).map(l => {
        const m = l.match(/\[ref=([a-f0-9]+)\]/);
        return m?.[1] || '';
    }));
    const currRefs = new Set(currLines.filter(l => /\[ref=/.test(l)).map(l => {
        const m = l.match(/\[ref=([a-f0-9]+)\]/);
        return m?.[1] || '';
    }));
    const added = [...currRefs].filter(r => r && !prevRefs.has(r));
    const removed = [...prevRefs].filter(r => r && !currRefs.has(r));
    if (added.length > 0) changes.push(`${added.length} new element(s) appeared`);
    if (removed.length > 0) changes.push(`${removed.length} element(s) removed`);

    // 4. Detect value changes in textboxes (content after colon on same line)
    const prevValues = new Map<string, string>();
    for (const l of prevLines) {
        const refM = l.match(/\[ref=([a-f0-9]+)\]/);
        if (refM) {
            // Value is text after the last colon on the same line
            const valM = l.match(/: (.+)$/);
            if (valM) prevValues.set(refM[1], valM[1].trim());
        }
    }
    for (const l of currLines) {
        const refM = l.match(/\[ref=([a-f0-9]+)\]/);
        if (refM) {
            const valM = l.match(/: (.+)$/);
            if (valM && prevValues.has(refM[1])) {
                const prevVal = prevValues.get(refM[1])!;
                const currVal = valM[1].trim();
                if (prevVal !== currVal && currVal) {
                    changes.push(`[ref=${refM[1]}] value changed: "${prevVal}" → "${currVal}"`);
                }
            }
        }
    }

    return changes.length > 0 ? changes.join('; ') : 'page content changed';
}

// ─── KevePageAgent ──────────────────────────────────────────────────────

export class KevePageAgent {
    readonly page: AgentPage;
    readonly maxSteps: number;

    readonly llm: LLM;
    events: AgentEvent[] = [];
    private abortController = new AbortController();
    private systemPrompt: string;

    /** 目标应用 URL（原 process.env.KEVE_TARGET_URL） */
    readonly targetUrl: string;
    private getEnvFn: (name: string) => string;
    private saveScreenshotFn?: AgentScreenshotSaver;
    private loadInitialImagesFn?: AgentInitialImageLoader;

    /** Current execute options (set at start of execute(), accessible from hooks) */
    options?: AgentOptions;

    private hooks?: AgentHooks;

    // Page event listener state (used by handle_dialog, console_messages, file_upload, network_requests)
    _dialogHandler: { accept: boolean; promptText?: string } | null = null;
    _lastDialogInfo: { type: string; message: string; accepted: boolean } | null = null;
    _pendingFileChooser: any = null;
    _consoleMessages: any[] = [];
    _networkRequests: any[] = [];
    _browserDiagnostics: RawConsoleRecord[] = [];
    _networkDiagnostics: RawNetworkRecord[] = [];
    /** 本次 execute 内 LLM 推理累计耗时（ms） */
    _aiReasoningMs = 0;
    /** 本次 execute 内 LLM token 累计用量 */
    _aiUsage: RawAiUsageRecord = { llmCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    /** 本次 execute 内工具操作累计耗时（ms） */
    _actionMs = 0;
    /** 本次 execute 起始时间，用于总耗时诊断 */
    _executeStartedAt = 0;
    _pageListenersSetup = false;
    /** 页面级性能指标（execute 结束时一次性读取；读取失败则留空） */
    private _lastPageMetrics?: PagePerformanceMetrics;

    constructor(
        page: AgentPage,
        options?: { maxSteps?: number; customSystemPrompt?: string; hooks?: AgentHooks } & AgentHostOptions,
    ) {
        this.page = page;
        this.maxSteps = options?.maxSteps ?? 8;
        this.systemPrompt = options?.customSystemPrompt || SYSTEM_PROMPT;
        this.hooks = options?.hooks;

        this.getEnvFn = options?.getEnv || (() => '');
        this.targetUrl = options?.targetUrl || this.getEnvFn('KEVE_TARGET_URL') || '';
        this.saveScreenshotFn = options?.saveScreenshot;
        this.loadInitialImagesFn = options?.loadInitialImages;

        const llmConfig = options?.llm || {
            baseURL: this.getEnvFn('KEVE_LLM_BASE_URL'),
            model: this.getEnvFn('KEVE_LLM_MODEL_NAME'),
            apiKey: this.getEnvFn('KEVE_LLM_API_KEY'),
        };
        this.llm = new LLM({
            baseURL: llmConfig.baseURL,
            model: llmConfig.model,
            apiKey: llmConfig.apiKey || '',
            temperature: 0.1,
            maxRetries: 3,
            customFetch: llmConfig.customFetch,
        });
    }

    /** 读取宿主注入的环境变量（Cypress 侧由 cy.env 转发，Playwright 侧即 process.env） */
    getEnv(name: string): string {
        return this.getEnvFn(name) || '';
    }

    /** Stop the current execution */
    stop(): void {
        this.abortController.abort();
    }

    /** Set up page event listeners for dialog, console, network, and file chooser capture.
     *  Called once per page; subsequent calls are no-ops. */
    private setupPageListeners(): void {
        if (this._pageListenersSetup) return;
        this._pageListenersSetup = true;

        // ── Dialog handler ──
        // Playwright auto-dismisses dialogs unless a handler is registered.
        // Our handler auto-accepts by default, but _dialogHandler can override.
        this.page.on('dialog', async (dialog: any) => {
            const handler = this._dialogHandler;
            const accept = handler?.accept ?? true;
            const promptText = handler?.promptText;

            try {
                if (accept) {
                    await dialog.accept(promptText || '');
                } else {
                    await dialog.dismiss();
                }
            } catch {
                // Fallback: always accept to unblock the page
                try { await dialog.accept(); } catch { /* give up */ }
            }

            this._lastDialogInfo = {
                type: dialog.type(),
                message: dialog.message(),
                accepted: accept,
            };
            this._dialogHandler = null;

            // Notify the Agent so it knows a dialog appeared
            this.pushObservation(`🔔 Native dialog [${dialog.type()}] appeared: "${dialog.message().slice(0, 100)}" — was ${accept ? 'accepted' : 'dismissed'}.`);
        });

        // ── Console messages ──
        this.page.on('console', (msg: any) => {
            const level = msg.type();
            const text = msg.text();
            this._consoleMessages.push({ level, text });
            if (this._consoleMessages.length > 200) this._consoleMessages.shift();
            this._browserDiagnostics.push({ level, text, at: Date.now(), kind: 'console' });
            if (this._browserDiagnostics.length > 500) this._browserDiagnostics.shift();
        });
        this.page.on('pageerror', (err: any) => {
            const text = `Uncaught: ${err?.message || String(err)}`;
            this._consoleMessages.push({ level: 'error', text });
            this._browserDiagnostics.push({ level: 'error', text, at: Date.now(), kind: 'pageerror' });
            if (this._browserDiagnostics.length > 500) this._browserDiagnostics.shift();
        });

        // ── Network requests ──
        this.page.on('request', (req: any) => {
            const url = req.url();
            const isStatic = isStaticUrl(url);
            this._networkRequests.push({
                _req: req,
                method: req.method(),
                url,
                isStatic,
                status: null,
                startedAt: Date.now(),
            });
            if (this._networkRequests.length > 100) this._networkRequests.shift();
        });
        this.page.on('response', (res: any) => {
            const req = res.request();
            // Match by reference identity — Playwright guarantees same Request object
            for (let i = this._networkRequests.length - 1; i >= 0; i--) {
                if (this._networkRequests[i]._req === req) {
                    const item = this._networkRequests[i];
                    const status = res.status();
                    const durationMs = item.startedAt ? Date.now() - item.startedAt : undefined;
                    item.status = status;
                    item.durationMs = durationMs;
                    this._networkDiagnostics.push({
                        url: item.url,
                        method: item.method,
                        status,
                        durationMs,
                        isStatic: item.isStatic,
                        at: item.startedAt,
                    });
                    if (this._networkDiagnostics.length > 500) this._networkDiagnostics.shift();
                    break;
                }
            }
        });
        // 请求失败（DNS/超时/连接重置等）没有 response 事件，必须在 requestfailed 记录。
        const onRequestFailed = (req: any) => {
            const failure = req.failure?.();
            const error = failure?.errorText || 'request failed';
            let item: any;
            for (let i = this._networkRequests.length - 1; i >= 0; i--) {
                if (this._networkRequests[i]._req === req) {
                    item = this._networkRequests[i];
                    break;
                }
            }
            const url = item?.url || req.url();
            const durationMs = item?.startedAt ? Date.now() - item.startedAt : undefined;
            this._networkDiagnostics.push({
                url,
                method: item?.method || req.method(),
                status: 0,
                durationMs,
                error: clipDiagnosticText(error),
                isStatic: item?.isStatic ?? isStaticUrl(url),
                at: item?.startedAt,
            });
            if (this._networkDiagnostics.length > 500) this._networkDiagnostics.shift();
        };
        // Playwright 的 AgentPage 契约只保证 on/emit，requestfailed 是原生事件。
        // 用可选探测，避免 Cypress 占位实现或其他 AgentPage 实现因未知事件报错。
        try { this.page.on('requestfailed', onRequestFailed); } catch { /* 非 Playwright 实现可忽略 */ }

        // ── File chooser ──
        this.page.on('filechooser', (fileChooser: any) => {
            this._pendingFileChooser = fileChooser;
        });
    }

    /** Main Re-Act execute loop */
    async execute(step: string, expected: string, options?: AgentOptions): Promise<AgentResult> {
        // Reset state
        this.events = [];
        this.abortController = new AbortController();
        this.options = options;
        // Reset page event listener state
        this._dialogHandler = null;
        this._lastDialogInfo = null;
        this._pendingFileChooser = null;
        this._consoleMessages = [];
        this._networkRequests = [];
        this._browserDiagnostics = [];
        this._networkDiagnostics = [];
        this._aiReasoningMs = 0;
        this._aiUsage = { llmCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        this._actionMs = 0;
        this._executeStartedAt = Date.now();
        this._lastPageMetrics = undefined;
        // Set up page event listeners (idempotent — only runs once per page)
        this.setupPageListeners();
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
        const targetUrl = this.targetUrl;
        if (targetUrl) {
            this.pushObservation(`Target application URL: ${targetUrl}. Use this URL for navigation. Do NOT construct URLs yourself — use the navigate tool with this URL or read process.env.KEVE_TARGET_URL.`);
        }
        if (options?.learnedActionsHint) {
            this.pushObservation(`Previous discoveries for similar steps:\n${options.learnedActionsHint}\nUse these discoveries to avoid repeating failed approaches. If a previous step found a working way to fill a form field (especially combobox/dropdown), reuse that approach instead of trial-and-error.`);
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

                    // ── Observe: get browser state (ariaSnapshot only — no per-step screenshot) ──
                    console.log('\x1b[34m\x1b[1m👀 Observing...\x1b[0m');
                    const snapshot = await this.page.ariaSnapshot({ mode: 'ai' });
                    const url = await this.page.url();
                    console.log(`  url: ${url.slice(0, 120)} | step ${stepCount + 1}/${maxSteps}`);

                    // ── Assemble messages (text-only per step; initial screenshots on step 0) ──
                    const userText = this.assembleUserPrompt(step, expected, snapshot, url, stepCount, maxSteps);
                    let userContent: string | ContentItem[];
                    if (stepCount === 0) {
                        const initialImages = await this.loadInitialScreenshots(options);
                        userContent = initialImages.length > 0
                            ? [{ type: 'text', text: userText }, ...initialImages]
                            : userText;
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

                    const llmStartedAt = Date.now();
                    let llmResult: Awaited<ReturnType<typeof this.llm.invoke>>;
                    try {
                        llmResult = await this.llm.invoke(
                            messages,
                            macroTool,
                            this.abortController.signal,
                            { toolChoiceName: 'AgentOutput' },
                        );
                        this.recordAiUsage(llmResult.usage);
                    } finally {
                        this._aiReasoningMs += Date.now() - llmStartedAt;
                    }

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

                    // Record step event (screenshotPath set later for done actions)
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
                        screenshotPath: undefined,
                        duration: execResult.duration,
                    };
                    if (execResult.duration !== undefined) this._actionMs += execResult.duration;
                    this.events.push(stepEvent);

                    // If execution had error, add observation
                    if (execResult.error) {
                        this.pushObservation(`Action "${actionName}" failed: ${execResult.error}. Try a different approach.`);
                    }

                    // If execute_javascript returned a business-level rejection (❌ prefix),
                    // re-inject the core rules so the LLM corrects its next attempt.
                    if (actionName === 'execute_javascript' && execResult.output && execResult.output.startsWith('❌')) {
                        const jsRulesHint = [
                            'execute_javascript rules — fix your script:',
                            '1. Include `return` for multi-statement code. Single expressions are auto-wrapped.',
                            '2. const/let are auto-converted to var — no need to write var manually.',
                            '3. NO top-level `await` or `async () => {}` wrappers — they return undefined.',
                            '4. NO Playwright APIs (`page`, `locator`) — only browser DOM APIs.',
                            '5. FORM INTERACTION allowed: input.value=, dispatchEvent().',
                            '6. FORBIDDEN: style mutation (style.xxx=, style.setProperty), classList mutation, className=, innerHTML=.',
                        ].join('\n');
                        this.pushObservation(jsRulesHint);
                    }

                    // ── Check: if "done", capture done-time screenshot + return with test conclusion ──
                    if (actionName === 'done') {
                        // Capture done-time screenshot as goal-after evidence
                        try {
                            const doneShot = await this.page.screenshot({ type: 'png', timeout: 15000 });
                            stepEvent.screenshotPath = await this.saveScreenshotBuffer(doneShot.base64, stepCount, step);
                        } catch { /* non-critical */ }

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

                // ── Stuck detection: break retry loops early ──
                // When the last 3 steps produce identical toolOutput (no page progress),
                // inject a forceful observation to break the loop.
                // Also detects oscillation patterns (e.g. A→B→A→B cycling between two states).
                const recentSteps = this.events
                    .filter((e): e is AgentStepEvent => e.type === 'step')
                    .slice(-4);
                if (recentSteps.length >= 3) {
                    const last3 = recentSteps.slice(-3);
                    const normalize = (s: string) => (s || '').replace(/executed for \d+ms/, '').slice(0, 80);
                    const outputs = last3.map(s => normalize(s.toolOutput));
                    const allSame = outputs.every(o => o === outputs[0]);
                    if (allSame) {
                        const stuckMsg = [
                            `⚠️ STUCK DETECTED: The last 3 actions all produced the same result: "${outputs[0].slice(0, 60)}"`,
                            `This means the page is NOT responding to your actions. You MUST change strategy:`,
                            `- Try a different tool (e.g. select_option instead of fill_form, execute_javascript instead of click)`,
                            `- Try a different element or value`,
                            `- If a dialog blocks submission, handle the sub-dialog/popup first or dismiss it with Escape`,
                            `- If stuck after 2 more attempts: call done(verdict="fail") honestly`,
                        ].join('\n');
                        this.pushObservation(stuckMsg);
                    }

                    // ── Oscillation detection: check if last 6 steps cycle between 2-3 states ──
                    // E.g. click确定→ownership popup → click返回→conflict warning → click确定→ownership popup
                    const recent6 = this.events
                        .filter((e): e is AgentStepEvent => e.type === 'step')
                        .slice(-6);
                    if (recent6.length >= 5 && !allSame) {
                        const norm6 = recent6.map(s => normalize(s.toolOutput));
                        // Extract the set of unique outputs (ignoring minor variations)
                        const uniqueOutputs = [...new Set(norm6)];
                        if (uniqueOutputs.length <= 2) {
                            // All recent steps cycle between ≤2 distinct outputs → oscillation
                            const oscMsg = [
                                `⚠️ OSCILLATION DETECTED: The last ${recent6.length} actions cycle between ${uniqueOutputs.length} states without progress:`,
                                ...uniqueOutputs.map(o => `  - "${o.slice(0, 50)}"`),
                                `You are going back and forth without advancing. You MUST break the cycle:`,
                                `- If clicking 确定 triggers a repeated warning, change the FORM VALUES (not just the name) to resolve the warning`,
                                `- If "口径重复" blocks submission, change the DATASET or INDICATOR (not just the indicator name)`,
                                `- If a sub-dialog keeps appearing, dismiss it with Escape or handle it first`,
                                `- Call done(verdict="fail") honestly if the conflict cannot be resolved within current steps`,
                            ].join('\n');
                            this.pushObservation(oscMsg);
                        }
                    }
                }

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
            // 页面级性能只能在用例收敛后读一次（LCP/longtask 需要缓冲已完成）
            await this.capturePageMetrics();
            if (taskResult!) {
                // 用完整诊断（含页面性能）覆盖此前构建的结果
                taskResult!.diagnostics = this.buildDiagnostics();
            }
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

    /**
     * 读取页面级性能指标。
     *
     * Playwright 与 Cypress 都走同一段探针源码：Playwright 在真实页面上下文，
     * Cypress 在 AUT 的 isolated world（navigation timing / performance entries
     * 与主世界共享同一份 Performance 数据）。
     */
    private async capturePageMetrics(): Promise<void> {
        try {
            const raw = await this.page.evaluate(pagePerformanceProbeSource());
            if (raw && typeof raw === 'object') {
                this._lastPageMetrics = raw as PagePerformanceMetrics;
            }
        } catch {
            // 性能指标是增强信息，读取失败不影响用例结论
        }
    }

    /**
     * 汇总当前执行期的运行诊断（含页面性能与质量信号）。
     * 公开给 reactLoop 的异常兜底分支复用，避免中断时丢失已采集数据。
     */
    buildDiagnostics(): RuntimeDiagnostics {
        const stepEvents = this.events.filter((e): e is AgentStepEvent => e.type === 'step');
        const actionRecords = stepEvents.map(e => ({
            name: e.toolName || 'unknown',
            durationMs: e.duration,
            error: !!e.toolError,
        }));

        // 重复动作：连续两个以上步骤产生相同工具输出时，累计重复次数。
        let repeatedActionCount = 0;
        let repeatRun = 0;
        let prevOutput = '';
        for (const event of stepEvents) {
            const output = String(event.toolOutput || '').slice(0, 200);
            if (output && output === prevOutput) repeatRun += 1;
            else repeatRun = 0;
            repeatedActionCount += repeatRun;
            prevOutput = output;
        }

        return buildRuntimeDiagnostics({
            totalMs: this._executeStartedAt ? Date.now() - this._executeStartedAt : 0,
            aiReasoningMs: this._aiReasoningMs,
            actionMs: this._actionMs,
            actions: actionRecords,
            consoleRecords: this._browserDiagnostics,
            networkRecords: this._networkDiagnostics,
            repeatedActionCount,
            pageMetrics: this._lastPageMetrics,
            aiUsage: this._aiUsage,
        });
    }

    /** 累加单次 LLM 调用的 token 用量（重试中的失败请求不在返回结果里，无法计量） */
    private recordAiUsage(usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number; reasoningTokens?: number }): void {
        if (!usage) return;
        this._aiUsage.llmCalls = (this._aiUsage.llmCalls || 0) + 1;
        this._aiUsage.promptTokens = (this._aiUsage.promptTokens || 0) + (usage.promptTokens || 0);
        this._aiUsage.completionTokens = (this._aiUsage.completionTokens || 0) + (usage.completionTokens || 0);
        this._aiUsage.totalTokens = (this._aiUsage.totalTokens || 0) + (usage.totalTokens || 0);
        if (usage.cachedTokens !== undefined) {
            this._aiUsage.cachedTokens = (this._aiUsage.cachedTokens || 0) + usage.cachedTokens;
        }
        if (usage.reasoningTokens !== undefined) {
            this._aiUsage.reasoningTokens = (this._aiUsage.reasoningTokens || 0) + usage.reasoningTokens;
        }
    }

    private assembleUserPrompt(
        step: string,
        expected: string,
        snapshot: string,
        url: string,
        stepIndex: number,
        maxSteps: number,
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
        // <initial_screenshots>: only on first step, describe the before/after fn screenshots
        if (stepIndex === 0 && (this.options?.goalScreenshotBefore || this.options?.fnAfterScreenshot)) {
            prompt += '<initial_screenshots>\n';
            if (this.options?.goalScreenshotBefore) {
                prompt += 'goal-before: Screenshot of the page state BEFORE any test action (fn执行前的页面原始状态).\n';
            }
            if (this.options?.fnAfterScreenshot) {
                prompt += 'fn-after: Screenshot of the page state AFTER the deterministic fn script executed (fn执行后的页面状态). Compare with goal-before to understand what fn changed.\n';
            }
            prompt += 'These screenshots are attached as images to give you visual context of the pre/post fn execution state. Use them to understand what fn did, then rely on the accessibility tree (ariaSnapshot) for per-step decisions.\n';
            prompt += '</initial_screenshots>\n';
        }
        prompt += '<step_info>\n';
        prompt += `Step ${stepIndex + 1} of ${maxSteps} max steps\n`;
        prompt += `Current URL: ${url}\n`;
        prompt += `Current time: ${new Date().toLocaleString()}\n`;
        prompt += '</step_info>\n';
        prompt += '</agent_state>\n\n';

        // <agent_history>
        prompt += '<agent_history>\n';
        for (let i = 0; i < this.events.length; i++) {
            const event = this.events[i];
            if (event.type === 'step') {
                prompt += `<step_${event.stepIndex + 1}>\n`;
                prompt += `Evaluation of Previous Step: ${event.evaluation}\n`;
                prompt += `Memory: ${event.memory}\n`;
                prompt += `Next Goal: ${event.nextGoal}\n`;
                prompt += `Action: ${event.toolName} → ${event.toolOutput || event.toolError || 'unknown'}\n`;
                // Add snapshot diff summary: compare this step's snapshot with the previous step's
                const prevStep = i > 0 ? findPrevStepSnapshot(this.events, i) : undefined;
                if (prevStep !== undefined) {
                    const diff = summarizeSnapshotDiff(prevStep, event.snapshot);
                    if (diff) prompt += `Page Change: ${diff}\n`;
                }
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

    /**
     * Save screenshot base64 to test artifacts.
     *
     * 落盘能力由宿主注入：Playwright 侧写本地文件系统，Cypress 侧经 HTTP 桥落盘。
     */
    private async saveScreenshotBuffer(
        pngBase64: string,
        stepIndex: number,
        stepName: string,
    ): Promise<string | undefined> {
        if (!this.saveScreenshotFn) return undefined;
        try {
            return await this.saveScreenshotFn(pngBase64, stepIndex, stepName);
        } catch {
            return undefined;
        }
    }

    /** Load initial screenshots (goal-before + fn-after) as ContentItem[] for step 0 multimodal input */
    private async loadInitialScreenshots(options?: AgentOptions): Promise<ContentItem[]> {
        if (!this.loadInitialImagesFn) return [];
        try {
            return (await this.loadInitialImagesFn({
                goalScreenshotBefore: options?.goalScreenshotBefore,
                fnAfterScreenshot: options?.fnAfterScreenshot,
            })) as ContentItem[];
        } catch {
            return [];
        }
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
            this.recordAiUsage(result.usage);

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

    /** Visual assertion: check a visual condition without interacting with the page */
    async visualAssertElement(
        screenshotBase64: string,
        assertion: string,
    ): Promise<{ passed: boolean; reasoning: string }> {
        const assertToolSchema = z.object({
            passed: z.boolean().describe('Whether the assertion is true based on the screenshot'),
            reasoning: z.string().describe('Brief explanation of why the assertion passed or failed'),
        });

        const messages: Message[] = [
            {
                role: 'system',
                content: `You are a UI visual assertion checker. Given a screenshot and an assertion statement, determine whether the assertion is TRUE based on what you see.

Output JSON with:
- passed: true if the assertion holds, false otherwise
- reasoning: brief explanation of your judgment

IMPORTANT:
- Only judge what you can SEE in the screenshot — do not infer hidden states
- Be strict: if the visual evidence is ambiguous, return passed=false
- Respond in Chinese for reasoning`,
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `请判断以下断言是否为真：${assertion}\n\n返回 passed (布尔值) 和 reasoning (中文说明)。` },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'high' } },
                ] as ContentItem[],
            },
        ];

        try {
            const result = await this.llm.invoke(messages, {
                AssertResult: {
                    description: 'Return the visual assertion result',
                    inputSchema: assertToolSchema,
                    execute: async (args: any) => args,
                },
            }, this.abortController.signal, { toolChoiceName: 'AssertResult' });
            this.recordAiUsage(result.usage);

            const parsed = result.toolCall.args as { passed: boolean; reasoning: string };
            return {
                passed: typeof parsed.passed === 'boolean' ? parsed.passed : false,
                reasoning: parsed.reasoning || 'No reasoning provided',
            };
        } catch (e: any) {
            return { passed: false, reasoning: `LLM invoke error: ${e.message}` };
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

        const diagnostics = this.buildDiagnostics();

        return {
            success,
            data,
            events: this.events,
            finalSnapshot: snapshot,
            diagnostics,
            /* refinePatch, */
            agentScreenshots: screenshotPaths.length ? screenshotPaths : undefined,
        };
    }
}


/**
 * @deprecated Use `new KevePageAgent(page).execute(step, expected, options)` directly.
 * Drop-in replacement for the old reactLoop function.
 * Creates a KevePageAgent, runs it, and maps the result.
 */
export async function reactLoop(
    // 接受原生 Playwright Page 或任意 AgentPage 实现（用 toAgentPage 的参数类型
    // 表达，避免在浏览器安全模块里引入 @playwright/test 的类型依赖）
    page: Parameters<typeof toAgentPage>[0],
    step: string,
    expected: string,
    options: {
        maxSteps?: number;
        learnedActionsHint?: string;
        specFilePath?: string;
        fnSource?: string;
        fnResult?: { error?: string; success?: boolean };
        signal?: AbortSignal;
        goalScreenshotBefore?: string;
        fnAfterScreenshot?: string;
    } & AgentHostOptions = {},
): Promise<{
    actions: any[];
    expectedMet: boolean;
    conclusion?: 'pass' | 'fail' | 'blocked';
    finalSnapshot: string;
    diagnostics?: RuntimeDiagnostics;
    // refinePatch?: string; // 已注释：scriptRefine 已禁用
    agentScreenshots?: string[];
}> {
    const agent = new KevePageAgent(toAgentPage(page), {
        maxSteps: options.maxSteps ?? 20,
        systemPrompt: options.systemPrompt,
        targetUrl: options.targetUrl,
        getEnv: options.getEnv,
        saveScreenshot: options.saveScreenshot,
        loadInitialImages: options.loadInitialImages,
        llm: options.llm,
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
            goalScreenshotBefore: options.goalScreenshotBefore,
            fnAfterScreenshot: options.fnAfterScreenshot,
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
            diagnostics: agent.buildDiagnostics(),
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
        diagnostics: result.diagnostics,
        // refinePatch: result.refinePatch, // 已注释：scriptRefine 已禁用
        agentScreenshots: result.agentScreenshots,
    };
}
