import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { AgentResult, AgentStepEvent } from './agent';

/* scriptRefine \u5df2\u6ce8\u91ca \u2014 \u4ea7\u51fa\u65e0\u4e0b\u6e38\u6d88\u8d39\u4e14\u4e0d\u53d7 keveGoal \u8d85\u65f6\u63a7\u5236\uff0c\u8be6\u89c1 WW-02 \u6839\u56e0\u5206\u6790
const REFINE_OUTPUT_SCHEMA = z.object({
    analysis: z.string().describe('Brief analysis of what was missing in the original fn'),
    patch: z.string().describe('Unified diff patch to fix the fn. Use standard git diff format.'),
    confidence: z.number().min(0).max(100).describe('Confidence 0-100'),
});

const REFINE_SYSTEM_PROMPT = `You are a test script refinement assistant. You analyze test execution logs and generate git diff patches to improve test scripts.

Given:
1. The original test script file content
2. The fn source code that was executed
3. The gap description (what was missing)
4. The Re-Act exploration actions (what AI did to fill the gap)

Generate a unified diff patch that modifies the .keve.ts file to include the missing steps.
Rules:
- Only modify the fn body (the async () => { ... } callback inside keveGoal)
- Add the operations that Re-Act discovered (scroll, click, waitFor, etc.)
- Preserve the existing fn operations
- Use Playwright native API (page.getByRole, page.locator, etc.)
- Output standard unified diff format`;

export interface RefineInput {
    specFilePath: string;
    step: string;
    expected: string;
    testTitle: string;
    order: number;
    fnSource: string;
    gap: string;
    reactActions: Array<{ tool: string; role?: string; name?: string; url?: string; text?: string; key?: string; evaluation?: string }>;
}

export async function scriptRefine(llm: any, input: RefineInput): Promise<string | null> {
    if (!input.specFilePath || !fs.existsSync(input.specFilePath)) return null;
    if (!input.reactActions?.length) return null;

    const specContent = fs.readFileSync(input.specFilePath, 'utf-8');

    const userMessage = `## Test Script File: ${input.specFilePath}

\`\`\`typescript
${specContent}
\`\`\`

## Executed fn:
\`\`\`typescript
${input.fnSource}
\`\`\`

## Gap (what was missing):
${input.gap}

## Re-Act Actions (what AI did to achieve the expected state):
${JSON.stringify(input.reactActions, null, 2)}

Generate a unified diff patch to fix the fn. Add the missing operations that Re-Act discovered.`;

    const refineTool = {
        RefineOutput: {
            description: 'Output your script refinement as a unified diff patch.',
            inputSchema: REFINE_OUTPUT_SCHEMA,
            execute: async (args: any) => args,
        },
    };

    try {
        const llmResult = await llm.invoke(
            [{ role: 'system', content: REFINE_SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
            refineTool,
            new AbortController().signal,
            { toolChoiceName: 'RefineOutput' },
        );

        const parsed = REFINE_OUTPUT_SCHEMA.parse(llmResult.toolCall.args);

        // Save patch file
        const taskDir = process.env.KEVE_TASK_DIR || '.keve';
        const round = process.env.KEVE_ROUND || 'latest';
        const refineDir = path.join(taskDir, 'test-artifacts', `round-${round}`, 'refine');
        fs.mkdirSync(refineDir, { recursive: true });
        const safeName = input.testTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').slice(0, 40);
        const patchFile = path.join(refineDir, `refine-${safeName}-step${input.order}.patch`);
        fs.writeFileSync(patchFile, [
            `# script-refine for: ${input.testTitle} / ${input.step}`,
            `# Gap: ${input.gap.slice(0, 200)}`,
            `# Analysis: ${parsed.analysis}`,
            `# Confidence: ${parsed.confidence}%`,
            ``,
            parsed.patch,
        ].join('\n'), 'utf-8');

        console.log(`[script-refine] Generated patch: ${path.relative(taskDir, patchFile)}`);
        console.log(`[script-refine] Analysis: ${parsed.analysis}`);
        console.log(`[script-refine] Confidence: ${parsed.confidence}%`);

        return patchFile;
    } catch (err: any) {
        console.warn(`[script-refine] Failed to generate patch: ${err.message}`);
        return null;
    }
}
// \u2500\u2500 scriptRefine \u6ce8\u91ca\u7ed3\u675f \u2500\u2500 */

/**
 * diagnostic.ts — Extract diagnostic hints from agent result + page state
 *
 * Called in onAfterTask hook to generate human-readable failure reasons.
 * Inspects the agent's action history, final snapshot, and live page DOM
 * to produce actionable diagnostic hints.
 */

/**
 * Extract diagnostic hints from agent result and current page state.
 * Only meaningful when result.success === false.
 */
export async function extractDiagnosticHints(
    page: import('@playwright/test').Page,
    result: AgentResult,
): Promise<string[]> {
    const hints: string[] = [];

    // 1. From done action's text — AI's own failure reason
    const doneEvent = result.events
        .filter((e): e is AgentStepEvent => e.type === 'step')
        .find(e => e.toolName === 'done');
    if (doneEvent?.toolOutput) {
        hints.push(doneEvent.toolOutput);
    }

    // 2. From finalSnapshot — key page state signals
    if (result.finalSnapshot) {
        const snapshot = String(result.finalSnapshot);
        const disabledButtons = snapshot.match(/button\s+"[^"]+"\s+\[disabled\]/g);
        if (disabledButtons) {
            for (const db of disabledButtons) {
                const label = db.match(/button\s+"([^"]+)"/)?.[1] || '';
                hints.push(`按钮「${label}」为禁用(disabled)状态，当前用户可能无操作权限`);
            }
        }
        if (/login|auth|signin|sso|cas/i.test(snapshot)) {
            hints.push('页面被重定向到登录页，当前浏览器未登录或登录已过期');
        }
    }

    // 3. Inspect live page DOM
    try {
        const currentUrl = page.url();
        console.log(`[diagnostic] page.url() = ${currentUrl}`);
        if (currentUrl === 'about:blank' || currentUrl === '') {
            hints.push('Playwright 页面对象停留在 about:blank，AI 探索未导航到目标页面（LLM 不可用或未配置）');
        } else {
            // 3a. Check disabled buttons
            const disabledButtons = await page.locator('button[disabled], button.ant-btn-disabled, button[class*="disabled"]').allInnerTexts();
            console.log(`[diagnostic] disabledButtons=${JSON.stringify(disabledButtons)}`);
            if (disabledButtons.length) {
                for (const text of disabledButtons) {
                    const label = text.trim();
                    if (label && !hints.some(h => h.includes(label))) {
                        hints.push(`按钮「${label}」为禁用(disabled)状态，当前用户可能无操作权限`);
                    }
                }
            }
            // 3b. Check login redirect
            if ((currentUrl.includes('sso') || currentUrl.includes('cas/login') || /login|auth|signin/i.test(currentUrl))
                && !hints.some(h => h.includes('登录页'))) {
                hints.push('页面被重定向到登录页，当前浏览器未登录或登录已过期');
            }
            // 3c. Overlay/modal/alert text
            const overlaySelectors = [
                '.ant-modal-body', '.ant-modal-confirm-content', '.ant-alert-message', '.ant-alert-description',
                '.ant-notification-notice-message', '.ant-notification-notice-description',
                '.ant-result-title', '.ant-result-subtitle', '.ant-empty-description',
                '[class*="overlay"]', '[class*="mask"]', '[class*="forbidden"]', '[class*="ban-edit"]',
                '[class*="disabled-mask"]', '[role="dialog"]', '[role="alert"]', '[role="alertdialog"]',
                '.ant-modal-mask + .ant-modal-wrap',
            ].join(', ');
            const overlayTexts = await page.locator(overlaySelectors).allInnerTexts();
            if (overlayTexts.length) {
                for (const text of overlayTexts) {
                    const t = text.trim();
                    if (t && !hints.some(h => h.includes(t))) {
                        hints.push(`页面显示提示: 「${t}」`);
                    }
                }
            }
            // 3d. Fallback: key lines from body
            if (hints.length === 0 || !hints.some(h => h.includes('页面显示提示'))) {
                try {
                    const bodyText = await page.locator('body').innerText({ timeout: 3000 });
                    const keyLines = bodyText.split('\n')
                        .map(l => l.trim())
                        .filter(l => l.length > 4 && l.length < 200 &&
                            (l.includes('禁止') || l.includes('下线') || l.includes('无权') || l.includes('无法') ||
                                l.includes('不存在') || l.includes('已删除') || l.includes('过期') || l.includes('失败') ||
                                l.includes('错误') || l.includes('异常') || l.includes('提醒') || l.includes('通知')));
                    for (const line of keyLines.slice(0, 3)) {
                        if (!hints.some(h => h.includes(line))) {
                            hints.push(`页面实际显示: 「${line}」`);
                        }
                    }
                } catch { /* ignore */ }
            }
            // 3e. Last resort: report page title
            if (hints.length === 0) {
                try {
                    const pageTitle = await page.title();
                    if (pageTitle) {
                        hints.push(`当前页面标题: 「${pageTitle}」(URL: ${currentUrl})`);
                    }
                } catch { /* ignore */ }
            }
        }
    } catch (e: any) {
        console.log(`[diagnostic] page inspection failed: ${e.message}`);
    }

    return hints;
}
