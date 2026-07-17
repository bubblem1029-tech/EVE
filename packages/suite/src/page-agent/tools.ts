/**
 * page-agent tools — Playwright-native action tools
 *
 * Design: Each tool has independent inputSchema + execute.
 * Tools are registered in a Map, then packed into a MacroTool for LLM invocation.
 *
 * Element targeting: aria-ref via page.locator('aria-ref=xxx')
 * - mode:'ai' snapshot provides [ref=f5e13] identifiers
 * - aria-ref selector automatically penetrates iframe boundaries
 */

import type { Page } from '@playwright/test';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KevePageAgent } from './agent';

// ─── Tool Definition ──────────────────────────────────────────────────

export interface ToolContext {
    signal: AbortSignal;
}

export interface PageAgentTool<TParams = any> {
    description: string;
    inputSchema: z.ZodType<TParams>;
    execute: (this: KevePageAgent, args: TParams, ctx: ToolContext) => Promise<string>;
}

export function tool<TParams>(options: PageAgentTool<TParams>): PageAgentTool<TParams> {
    return options;
}

// ─── Tool Registry ────────────────────────────────────────────────────

export const tools = new Map<string, PageAgentTool>();

// --- done ---
tools.set('done', tool({
    description: 'Complete the task with a test conclusion. Use this when the expected state is achieved, not achieved, or you are blocked. When the page shows a permission-denied / no-access message (e.g. "您没有...编辑权限", "无访问权限", "暂无数据") that is NOT caused by an application bug but by the test account lacking the required permission, use verdict="blocked" — this is a precondition issue, not a code defect. Only use verdict="fail" when the page IS accessible/functional but the expected UI state is not met.',
    inputSchema: z.object({
        verdict: z.enum(['pass', 'fail', 'blocked']).describe('Test verdict: "pass"=expected state achieved; "fail"=page accessible but expected not met (code defect); "blocked"=cannot continue — includes SSO redirect, connection refused, AND permission-denied/no-access pages where the test account lacks the required access (precondition not met, NOT a code defect)'),
        text: z.string().describe('Summary of what was achieved, why it failed, or why blocked'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const icons: Record<string, string> = { pass: '✅', fail: '❌', blocked: '🚫' };
        let verdict = input.verdict as string | undefined;
        // 强制校验：verdict 缺失或非法时从 text 推断（MacroTool 扁平化导致 verdict 变 optional）
        if (!icons[verdict as string]) {
            console.warn(`[done] ⚠️ verdict missing or invalid ("${input.verdict}"), inferring from text`);
            const t = String(input.text || '').toLowerCase();
            if (t.includes('fail') || t.includes('failure') || t.includes('失败') || t.includes('不通过') || t.includes('未通过')) {
                verdict = 'fail';
            } else if (t.includes('blocked') || t.includes('阻塞') || t.includes('阻止')) {
                verdict = 'blocked';
            } else {
                verdict = 'pass'; // 有 text 且无否定词 → 默认 pass
            }
        }
        return `${icons[verdict]} Task ${verdict}: ${input.text}`;
    },
}));

// --- click ---
tools.set('click', tool({
    description: 'Click an element by its ref identifier from the accessibility tree. The aria-ref selector automatically penetrates iframe boundaries.',
    inputSchema: z.object({
        ref: z.string().describe('Element ref from the accessibility tree, e.g. "f5e13"'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const locator = this.page.locator(`aria-ref=${input.ref}`);
        await locator.click({ timeout: 5000, force: true });
        return `✅ Clicked element [ref=${input.ref}]`;
    },
}));

// --- type ---
tools.set('type', tool({
    description: 'Type text into an input element by its ref identifier. Clears existing content first. The aria-ref selector automatically penetrates iframe boundaries.',
    inputSchema: z.object({
        ref: z.string().describe('Element ref from the accessibility tree, e.g. "f5e91"'),
        text: z.string().describe('Text to type into the element'),
        submit: z.boolean().optional().describe('Whether to press Enter after typing'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const locator = this.page.locator(`aria-ref=${input.ref}`);
        await locator.fill(input.text, { timeout: 5000, force: true });
        if (input.submit) await this.page.keyboard.press('Enter');
        return `✅ Typed "${input.text.slice(0, 50)}" into element [ref=${input.ref}]${input.submit ? ' + Enter' : ''}`;
    },
}));

// --- hover ---
tools.set('hover', tool({
    description: 'Hover over an element by its ref identifier. The aria-ref selector automatically penetrates iframe boundaries.',
    inputSchema: z.object({
        ref: z.string().describe('Element ref from the accessibility tree, e.g. "f5e13"'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const locator = this.page.locator(`aria-ref=${input.ref}`);
        await locator.hover({ timeout: 5000, force: true });
        return `✅ Hovered over element [ref=${input.ref}]`;
    },
}));

// --- pressKey ---
tools.set('pressKey', tool({
    description: 'Press a keyboard key (Enter, Escape, Tab, ArrowDown, etc.)',
    inputSchema: z.object({
        key: z.string().describe('Key to press: Enter, Escape, Tab, ArrowDown, etc.'),
    }),
    execute: async function (this: KevePageAgent, input) {
        await this.page.keyboard.press(input.key);
        return `✅ Pressed key "${input.key}"`;
    },
}));

// --- scroll ---
tools.set('scroll', tool({
    description: 'Scroll the page vertically. Use when target content is off-screen.',
    inputSchema: z.object({
        direction: z.enum(['down', 'up']).default('down').describe('Scroll direction'),
        amount: z.number().optional().describe('Scroll amount in pixels (default 500)'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const pixels = input.amount ?? 500;
        const dir = input.direction === 'down' ? 1 : -1;
        await this.page.mouse.wheel(0, pixels * dir);
        return `✅ Scrolled ${input.direction} ${pixels}px`;
    },
}));

// --- wait ---
tools.set('wait', tool({
    description: 'Wait for a specified duration (in milliseconds). Use when page is loading.',
    inputSchema: z.object({
        time: z.number().min(100).max(10000).describe('Wait time in milliseconds'),
    }),
    execute: async function (this: KevePageAgent, input) {
        await this.page.waitForTimeout(input.time);
        return `✅ Waited ${input.time}ms`;
    },
}));

// --- navigate ---
tools.set('navigate', tool({
    description: 'Navigate to a URL. Use KEVE_TARGET_URL (from test-cases.yaml principle) for the main application page. For other pages, use URLs from envVars (e.g., process.env.PAGE_KNOWLEDGE). Do NOT construct or guess URLs yourself.',
    inputSchema: z.object({
        url: z.string().describe('URL to navigate to. Use process.env.KEVE_TARGET_URL for the main page, or envVars for other declared pages. Supports absolute URLs or relative paths starting with /'),
    }),
    execute: async function (this: KevePageAgent, input) {
        let url = input.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            const base = process.env.KEVE_TARGET_URL || process.env.BASE_URL || '';
            url = new URL(url, base).href;
        }
        await this.page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        return `✅ Navigated to ${url}`;
    },
}));

// --- execute_javascript ---
tools.set('execute_javascript', tool({
    description: 'READ-ONLY query tool: execute JavaScript in the BROWSER DOM context to retrieve precise values that screenshots and accessibility trees CANNOT provide — such as computed CSS styles (getComputedStyle), DOM measurements (offsetWidth, getBoundingClientRect), or element properties (checked, disabled, value).\n\n⚠️ EXECUTION CONTEXT: This runs inside the browser page via page.evaluate — it is a plain browser JavaScript sandbox. There is NO `page` object, NO Playwright API, NO `locator`, NO top-level `await`. Using `page.locator(...)`, `page.evaluate(...)`, `await`, or `async () => {}` wrappers will cause SyntaxError or return undefined.\n\nDo NOT use for: clicking, typing, navigating, form filling, or any page interaction — use click/type/navigate tools instead. Do NOT use for: assertions or logical checks — just return the raw value, you judge the result yourself. Do NOT use for: modifying page state (setting styles, cookies, localStorage, DOM mutations).',
    inputSchema: z.object({
        script: z.string().describe("JavaScript code to execute inside the browser DOM. MUST start with `return` to capture the result. Use `var` for variable declarations (NOT `const`/`let` — they cause SyntaxError in some evaluate contexts). Only browser DOM APIs: document.querySelector, window.getComputedStyle, etc.\n\n✅ Correct: 'return document.querySelector(\".x\").innerText'\n✅ Correct: 'var el = document.querySelector(\".x\"); return window.getComputedStyle(el).backgroundColor'\n❌ Wrong: 'page.locator(\".x\")' — no Playwright `page` object in browser context\n❌ Wrong: 'await page.locator(...)' — no `await` or `async`\n❌ Wrong: 'const el = ...' — use `var` instead of `const`/`let`\n❌ Wrong: 'async () => { ... }' — do NOT wrap in async function, returns undefined\n\nRead-only queries only."),
    }),
    execute: async function (this: KevePageAgent, input) {
        try {
            let script = input.script.trim();

            // Auto-unwrap arrow function wrappers that Agent frequently generates:
            //   async () => { ... return ... }  →  ... return ...
            //   () => { ... return ... }        →  ... return ...
            //   (async () => { ... })()        →  ... return ...
            // These wrappers cause page.evaluate to return undefined because the
            // arrow function is created but never invoked inside the IIFE.
            const arrowMatch = script.match(/^(?:async\s+)?(?:\(\s*\)\s*|)\s*=>\s*\{([\s\S]*)\}\s*;?\s*$/);
            if (arrowMatch) {
                script = arrowMatch[1].trim();
            }
            // Also strip IIFE self-call: (async () => { ... })()
            const iifeMatch = script.match(/^\(\s*(?:async\s+)?\(\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/);
            if (iifeMatch) {
                script = iifeMatch[1].trim();
            }

            // Read-only guard: block DOM mutation APIs to prevent Agent from altering page state.
            const writePatterns = [
                /\b(?:document|element|el|node)\.\s*(?:remove|appendChild|insertBefore|replaceChild|removeChild|appendChild)\s*\(/,
                /\b(?:document|element|el|node)\.\s*(?:innerHTML|outerHTML|textContent|innerText)\s*=/,
                /\b(?:document|element|el|node)\.\s*(?:setAttribute|removeAttribute|classList)\s*\./,
                /\b\.style\s*\.\s*\w+\s*=/,
                /\blocation\s*(?:\.href\s*=|\.assign\s*\(|\.replace\s*\()/,
                /\bwindow\s*\.\s*(?:close|stop|open)\s*\(/,
                /\bdocument\.\s*(?:write|writeln|execCommand)\s*\(/,
                /\blocalStorage\s*\.\s*set\s*\(/,
                /\bsessionStorage\s*\.\s*set\s*\(/,
                /\bdocument\.cookie\s*=/,
                /\beval\s*\(/,
            ];
            for (const pattern of writePatterns) {
                if (pattern.test(script)) {
                    return `❌ JS execution blocked: write/mutation API detected. execute_javascript is read-only. Use click/type/navigate tools for interactions.`;
                }
            }

            // Require explicit `return` — no auto-wrapping.
            // Wrap in IIFE so `return` is valid (page.evaluate treats bare strings as expressions).
            if (!/\breturn\b/.test(script)) {
                return `❌ Script must start with 'return' to capture the result. Example: "return window.getComputedStyle(document.body).backgroundColor"`;
            }
            const wrapped = `(function() { ${script} })()`;
            const result = await this.page.evaluate(wrapped);
            const output = typeof result === 'object' && result !== null
                ? JSON.stringify(result, null, 2)
                : String(result ?? 'undefined');
            return `✅ JS executed. Result: ${output}`;
        } catch (err: any) {
            return `❌ JS execution error: ${err.message || String(err)}`;
        }
    },
}));

// --- visual_locate ---
tools.set('visual_locate', tool({
    description: 'Locate and click an element by visual analysis of a screenshot. FALLBACK: only use after `click` fails 2+ times on the same element (non-standard ARIA role, invisible in accessibility tree, or element visible in screenshot but missing from accessibility tree). Provide a concise visual description of the element. It will screenshot the page, send it to a multimodal LLM to locate the element, then click at the predicted coordinates. After clicking, verify the effect on the next screenshot.',
    inputSchema: z.object({
        description: z.string().describe('Visual description of the element to find, e.g. "the dropdown button showing 当前Agent▼"'),
    }),
    execute: async function (this: KevePageAgent, input) {
        // 1. Capture screenshot
        let screenshotBase64: string;
        try {
            const buf = await this.page.screenshot({ type: 'png', timeout: 10000 });
            screenshotBase64 = buf.toString('base64');
        } catch (e: any) {
            throw new Error(`visual_locate screenshot failed: ${e.message}`);
        }

        // 2. Call LLM for visual element location
        const locateResult = await this.visualLocateElement(screenshotBase64, input.description);

        if (!locateResult.found || !locateResult.bbox || locateResult.bbox.length !== 4) {
            return `❌ Visual locate failed: element "${input.description}" not found. ${locateResult.analysis || ''}`;
        }

        // 3. Convert normalized bbox (0-1000) to viewport pixel coordinates
        const viewport = this.page.viewportSize() || { width: 1280, height: 720 };
        const [x1, y1, x2, y2] = locateResult.bbox;
        const centerX = Math.round(((x1 + x2) / 2) * viewport.width / 1000);
        const centerY = Math.round(((y1 + y2) / 2) * viewport.height / 1000);

        // 4. Click at coordinates (bypasses iframe boundaries)
        await this.page.mouse.click(centerX, centerY);

        return `✅ Visual locate & click: "${input.description}" at (${centerX}, ${centerY})`;
    },
}));

// ── verify_expected fully removed (Phase 6) ──
// LLM now sees screenshots via multimodal prompt and self-evaluates.
// No separate verification tool or function needed — each step's screenshot
// is injected into the LLM prompt directly, so LLM judges goal state itself.

// ─── Zod schema helper (used by packMacroToolSchema & MacroTool execute) ──

export function getZodShape(schema: any): Record<string, any> {
    const def = schema?._def;
    if (!def) return schema?.shape || {};
    const s = def.shape;
    return typeof s === 'function' ? s() : (s || schema?.shape || {});
}

// ─── Pack tools into MacroTool schema for LLM ────────────────────────
// Auto-derive flat schema from tools Map (like page-agent's #packMacroTool).
// Key insight: z.union() is UNSTABLE with keve-core's safeParse.
// Solution: merge all tool inputSchema fields into one flat object with `tool` enum.

export function packMacroToolSchema() {
    // Collect tool names for enum
    const toolNames = Array.from(tools.keys()) as [string, ...string[]];

    // Collect all unique fields from all tool schemas
    const fieldMap = new Map<string, { schema: z.ZodTypeAny; description: string }>();

    for (const [name, t] of tools.entries()) {
        // Unwrap ZodObject to get its shape
        const shape = getZodShape(t.inputSchema);
        for (const [key, val] of Object.entries(shape)) {
            if (!fieldMap.has(key)) {
                // First encounter — store the schema and add tool names to description
                const zodField = val as z.ZodTypeAny;
                const desc = (zodField as any)._def?.description || '';
                fieldMap.set(key, { schema: zodField.optional(), description: desc });
            }
            // If field already exists, just ensure description mentions both tools
        }
    }

    // Build the flat schema
    const reflectionFields = {
        evaluation_previous_goal: z.string().optional()
            .describe('Concise one-sentence analysis of your last action. State success, failure, or uncertain.'),
        memory: z.string().optional()
            .describe('1-3 concise sentences of key observations that will help in future steps.'),
        next_goal: z.string().optional()
            .describe('State the next immediate goal and action to achieve it.'),
    };

    const actionFields: Record<string, any> = {
        tool: z.enum(toolNames).describe('The action tool to use'),
    };

    // Add all tool fields as optional
    for (const [key, { schema, description }] of fieldMap.entries()) {
        // Make all fields optional + add which tools use this field
        const usedBy = Array.from(tools.entries())
            .filter(([_, t]) => {
                const shape = getZodShape(t.inputSchema);
                return key in shape;
            })
            .map(([name]) => name);

        const enrichedDesc = usedBy.length > 1
            ? `${description} (for ${usedBy.join('/')})`
            : description;

        actionFields[key] = (schema as any).describe(enrichedDesc);
    }

    return z.object({
        ...reflectionFields,
        ...actionFields,
    }).passthrough(); // Allow extra LLM fields for stability
}

export type MacroToolInput = z.infer<ReturnType<typeof packMacroToolSchema>>;
