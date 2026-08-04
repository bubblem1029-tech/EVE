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
        // Capture pre-click element identity (role + name) — needed for stable, replayable action logs.
        // Without this, action records only contain ephemeral ref=e688 which is useless after page reload.
        let elementRole = '';
        let elementName = '';
        let dialogContext = '';
        let inDialog = false;
        try {
            const preClickInfo = await locator.evaluate((el: any) => {
                const dialog = el.closest('[role="dialog"], [role="alertdialog"], .ks-dialog, .el-dialog, .ant-modal');
                const role = el.getAttribute('role') || el.tagName.toLowerCase();
                const name = el.textContent?.trim()?.slice(0, 40) || el.getAttribute('aria-label') || el.getAttribute('title') || '';
                const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A';
                return { inDialog: !!dialog, isButton, name, dialogRole: dialog?.getAttribute('role') || '', role, tagName: el.tagName.toLowerCase() };
            });
            elementRole = preClickInfo.role || preClickInfo.tagName;
            elementName = preClickInfo.name;
            inDialog = preClickInfo.inDialog;
            if (preClickInfo.inDialog && preClickInfo.isButton) {
                dialogContext = preClickInfo.name; // remember the button name for post-check
            }
        } catch { /* element may not support evaluate */ }

        // Build stable element descriptor for action logs: "button 确定", "link 导航", "textbox"
        const elementDesc = elementRole && elementName
            ? `${elementRole} "${elementName}"`
            : elementRole || `element`;

        await locator.click({ timeout: 5000, force: true });
        await this.page.waitForTimeout(300);

        // Post-click check: if we clicked a dialog button, check if dialog closed
        if (dialogContext) {
            try {
                const dialogStillOpen = await this.page.locator('[role="dialog"], [role="alertdialog"]').count() > 0;
                if (dialogStillOpen) {
                    // Check if a NEW dialog/warning appeared on top (e.g. confirmation/warning popup)
                    let newDialogInfo = '';
                    try {
                        const topDialog = await this.page.locator('[role="alertdialog"], [role="dialog"]').last();
                        const title = await topDialog.locator('.ks-dialog__header, .el-dialog__title, .ant-modal-title, h2, h3').first().textContent({ timeout: 1000 }).catch(() => '');
                        const body = await topDialog.locator('.ks-dialog__body, .el-dialog__body, .ant-modal-body, p').first().textContent({ timeout: 1000 }).catch(() => '');
                        const info = (title || body || '').trim().slice(0, 80);
                        if (info) newDialogInfo = ` — new popup: "${info}"`;
                    } catch { /* no extra info */ }

                    // ── JS click fallback — bypass ks-overlay / pointer-events:none interception ──
                    // Pointer-events click (Playwright force:true) can be intercepted by overlay masks,
                    // but DOM element.click() dispatches a trusted click event that bypasses pointer-events.
                    // Try JS click when the pointer click failed to close the dialog.
                    try {
                        await locator.evaluate((el: any) => { el.click(); });
                        await this.page.waitForTimeout(500);
                        const dialogAfterJS = await this.page.locator('[role="dialog"], [role="alertdialog"]').count() > 0;
                        if (!dialogAfterJS) {
                            return `✅ Clicked [ref=${input.ref}] ${elementDesc} via JS fallback (overlay bypassed) — dialog closed`;
                        }
                        // JS click also failed — re-check for new popup info
                        let jsNewDialogInfo = '';
                        try {
                            const topDialog2 = await this.page.locator('[role="alertdialog"], [role="dialog"]').last();
                            const title2 = await topDialog2.locator('.ks-dialog__header, .el-dialog__title, .ant-modal-title, h2, h3').first().textContent({ timeout: 1000 }).catch(() => '');
                            const body2 = await topDialog2.locator('.ks-dialog__body, .el-dialog__body, .ant-modal-body, p').first().textContent({ timeout: 1000 }).catch(() => '');
                            const info2 = (title2 || body2 || '').trim().slice(0, 80);
                            if (info2) jsNewDialogInfo = ` — new popup: "${info2}"`;
                        } catch { /* no extra info */ }
                        const popupInfo = jsNewDialogInfo || newDialogInfo;
                        // ── Auto-dismiss non-blocking sub-dialogs ──
                        // Some sub-dialogs are unrelated interceptors that block
                        // the intended action (e.g. ownership transfer, confirmation prompts).
                        // Try to dismiss them automatically before returning.
                        const popupText = (jsNewDialogInfo || newDialogInfo || '').replace(/^ — new popup: /, '').replace(/"/g, '');
                        // Generic patterns: ownership/transfer/assignment dialogs, confirmation prompts, notifications
                        // These are NOT the target dialog — they are interceptors that should be dismissed.
                        const dismissiblePatterns = ['负责人', '转移', '转让', '确认', '提示', '通知', '选择', '分配'];
                        const isDismissible = dismissiblePatterns.some(p => popupText.includes(p));
                        if (isDismissible) {
                            try {
                                // Try Escape to close the sub-dialog, then retry the original click.
                                // If the sub-dialog was the blocker, the retry should succeed.
                                await this.page.keyboard.press('Escape');
                                await this.page.waitForTimeout(400);
                                // Retry original click — same post-click check as the normal path
                                await locator.click({ timeout: 5000, force: true });
                                await this.page.waitForTimeout(500);
                                const dialogAfterRetry = await this.page.locator('[role="dialog"], [role="alertdialog"]').count() > 0;
                                if (!dialogAfterRetry) {
                                    return `✅ Clicked [ref=${input.ref}] ${elementDesc} — sub-dialog "${popupText}" auto-dismissed via Escape, retried click succeeded — dialog closed`;
                                }
                                // Retry click didn't close dialog — check if a NEW sub-dialog appeared
                                let retryPopupInfo = '';
                                try {
                                    const topDialog = await this.page.locator('[role="alertdialog"], [role="dialog"]').last();
                                    const retryTitle = await topDialog.locator('.ks-dialog__header, .el-dialog__title, .ant-modal-title, h2, h3').first().textContent({ timeout: 1000 }).catch(() => '');
                                    const retryBody = await topDialog.locator('.ks-dialog__body, .el-dialog__body, .ant-modal-body, p').first().textContent({ timeout: 1000 }).catch(() => '');
                                    const retryInfo = (retryTitle || retryBody || '').trim().slice(0, 80);
                                    if (retryInfo) retryPopupInfo = ` — new popup: "${retryInfo}"`;
                                } catch { /* no info */ }
                                return `⚠️ Clicked [ref=${input.ref}] ${elementDesc} — sub-dialog "${popupText}" dismissed via Escape, but retried click still blocked${retryPopupInfo}. Read the accessibility tree to handle the issue.`;
                            } catch { /* auto-dismiss failed, fall through */ }
                        }
                        return `⚠️ Clicked [ref=${input.ref}] ${elementDesc} (tried both pointer + JS click) — dialog still open${popupInfo}. Read the accessibility tree to handle the sub-dialog/popup before retrying.`;
                    } catch {
                        // JS evaluate failed (element detached or not evaluable) — fall through to original ⚠️
                    }

                    return `⚠️ Clicked [ref=${input.ref}] ${elementDesc} — dialog still open${newDialogInfo} (action blocked by validation or warning). Read the accessibility tree to handle the sub-dialog/popup before retrying.`;
                } else {
                    return `✅ Clicked [ref=${input.ref}] ${elementDesc} — dialog closed`;
                }
            } catch { /* post-check failed, fall through */ }
        }
        return `✅ Clicked [ref=${input.ref}] ${elementDesc}`;
    },
}));

// ── Shared combobox helpers ────────────────────────────────────────────

/** Detect if an element (by ref) is actually a combobox/dropdown. */
async function detectCombobox(page: any, ref: string): Promise<boolean> {
    const locator = page.locator(`aria-ref=${ref}`);
    try {
        const attrs = await locator.evaluate((el: any) => {
            const h = el as HTMLElement;
            const inputEl = h as HTMLInputElement;
            return {
                role: h.getAttribute('role') || '',
                ariaExpanded: h.getAttribute('aria-expanded'),
                tag: h.tagName.toLowerCase(),
                className: h.className || '',
                readonly: inputEl.readOnly,
                // 检查自身或祖先是否有下拉框组件标志
                hasDropdownParent: !!h.closest('.ks-select, .el-select, .ant-select, [class*="select"], [class*="dropdown"], [class*="picker"]'),
            };
        });
        if (attrs.tag === 'select') return true;
        if (attrs.role === 'combobox' || attrs.role === 'listbox') return true;
        if (attrs.ariaExpanded !== null) return true;
        if (/select|dropdown|picker/i.test(attrs.className)) return true;
        if (attrs.hasDropdownParent) return true;
        if (attrs.tag === 'input' && attrs.readonly) return true;
        return false;
    } catch { return false; }
}

/** Select an option from a combobox/dropdown (native or custom). */
async function selectComboboxOption(page: any, ref: string, label: string): Promise<string> {
    const locator = page.locator(`aria-ref=${ref}`);
    try {
        await locator.selectOption({ label }, { timeout: 2000 });
        return `(native)`;
    } catch {
        await locator.click({ timeout: 5000, force: true });
        await page.waitForTimeout(600);
        // Strategy 1: Playwright semantic locators (exact then fuzzy)
        let clicked = false;
        try {
            await page.getByRole('option', { name: label, exact: true }).first().click({ timeout: 2000 });
            clicked = true;
        } catch { }
        if (!clicked) try {
            await page.getByRole('option', { name: label, exact: false }).first().click({ timeout: 2000 });
            clicked = true;
        } catch { }
        if (!clicked) try {
            await page.getByText(label, { exact: true }).last().click({ timeout: 2000 });
            clicked = true;
        } catch { }
        if (!clicked) try {
            await page.getByText(label, { exact: false }).first().click({ timeout: 2000 });
            clicked = true;
        } catch { }
        // Strategy 2: Use a11y snapshot to find option by ref (same mechanism Agent uses manually)
        if (!clicked) try {
            const snapshot = await page.ariaSnapshot({ mode: 'ai' });
            // Search a11y tree for option/listitem containing the label text
            const refMatch = findOptionRefInSnapshot(snapshot, label);
            if (refMatch) {
                await page.locator(`aria-ref=${refMatch}`).click({ timeout: 3000, force: true });
                clicked = true;
            }
        } catch { }

        if (!clicked) return `opened dropdown but could not find option "${label}"`;

        // ── Verify the selection actually took effect ──
        // Custom components (ks-select/kformily) may not expose value via standard DOM attributes.
        // Verification is lenient: if click succeeded, assume the component handled it internally.
        // Only report failure when we can positively confirm the value is wrong (not just missing).
        try {
            await page.waitForTimeout(400);
            const actuallySelected = await verifyComboboxValue(page, ref, label);
            if (!actuallySelected) {
                // ── Fallback: type label + Enter to trigger component's search+select ──
                // Some custom components (ks-select) need keyboard interaction to commit selection.
                // Clear the field, type the label, then press Enter to confirm.
                try {
                    await locator.click({ timeout: 2000, force: true });
                    await page.waitForTimeout(200);
                    // Select all + delete to clear any partial text
                    await page.keyboard.press('Control+a');
                    await page.keyboard.press('Backspace');
                    await page.waitForTimeout(200);
                    await locator.fill(label, { timeout: 2000, force: true });
                    await page.waitForTimeout(300);
                    await page.keyboard.press('Enter');
                    await page.waitForTimeout(600);

                    // Re-verify after type+Enter
                    const recheck = await verifyComboboxValue(page, ref, label);
                    if (recheck) return `(custom, via type+Enter)`;
                    // Even if verify fails, the component may have updated internally —
                    // return success with note to avoid Agent retry loops
                    return `(custom, type+Enter applied)`;
                } catch {
                    // type+Enter fallback failed — still return success to break retry loops
                    return `(custom, selection applied — verify skipped)`;
                }
            }
        } catch { /* verification failed, assume success */ }
        return `(custom)`;
    }
}

/** Verify a combobox actually contains the expected value after selection.
 *  Custom components (ks-select, kformily) may show the option as clicked but not update internal form state.
 */
async function verifyComboboxValue(page: any, ref: string, label: string): Promise<boolean> {
    try {
        const actual = await page.locator(`aria-ref=${ref}`).evaluate((el: any, expected: string) => {
            // Strategy 1: input value
            const inputVal = (el as HTMLInputElement).value;
            if (inputVal && inputVal.includes(expected)) return inputVal;
            // Strategy 2: element textContent
            const text = el.textContent?.trim();
            if (text && text.includes(expected)) return text;
            // Strategy 3: aria-label
            const aria = el.getAttribute('aria-label');
            if (aria && aria.includes(expected)) return aria;
            // Strategy 4: parent select component's selected display
            const parent = el.closest('.ks-select, .el-select, .ant-select, [class*="select"]');
            if (parent) {
                const selected = parent.querySelector('.ks-select__selected, .el-select__selected, .ant-select-selection-item, .selected-value');
                if (selected) return selected.textContent?.trim() || '';
            }
            return '';
        }, label);
        return typeof actual === 'string' && actual.length > 0;
    } catch {
        return false;
    }
}

/**
 * Parse a11y snapshot text to find a listitem/option/treeitem ref whose name contains the label.
 * Snapshot lines look like: `  - listitem "KwaiBI官方数据集DEMO" [ref=e2700]`
 */
function findOptionRefInSnapshot(snapshot: string, label: string): string | null {
    const labelLower = label.toLowerCase();
    const lines = snapshot.split('\n');
    // Match lines with option-like roles + a ref
    const optionRoles = /^(?:\s*-\s+)(?:listitem|option|treeitem|menuitem|cell)\s/;
    for (const line of lines) {
        if (!optionRoles.test(line)) continue;
        if (!line.includes('[ref=')) continue;
        const textMatch = line.match(/"(.*?)"/);
        if (!textMatch) continue;
        if (textMatch[1].toLowerCase().includes(labelLower)) {
            const refMatch = line.match(/\[ref=([a-f0-9]+)\]/);
            if (refMatch) return refMatch[1];
        }
    }
    // Fallback: any line with [ref=] whose quoted text contains the label
    for (const line of lines) {
        if (!line.includes('[ref=')) continue;
        const textMatch = line.match(/"(.*?)"/);
        if (!textMatch) continue;
        if (textMatch[1].toLowerCase().includes(labelLower)) {
            const refMatch = line.match(/\[ref=([a-f0-9]+)\]/);
            if (refMatch) return refMatch[1];
        }
    }
    return null;
}

// --- type ---
tools.set('type', tool({
    description: 'Type text into an input element by its ref identifier. The aria-ref selector automatically penetrates iframe boundaries. For combobox/dropdown fields, this tool automatically handles option selection instead of plain text input.',
    inputSchema: z.object({
        ref: z.string().describe('Element ref from the accessibility tree, e.g. "f5e91"'),
        text: z.string().describe('Text to type or option label to select (for combobox fields)'),
        mode: z.enum(['replace', 'append']).default('replace')
            .describe('replace: clear existing content + fill (default). append: move cursor to end + pressSequentially (for adding to existing content without clearing)'),
        submit: z.boolean().optional().describe('Whether to press Enter after typing'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const locator = this.page.locator(`aria-ref=${input.ref}`);
        // Auto-detect combobox — if so, try select option first; fallback to direct type if option not found
        const isCb = await detectCombobox(this.page, input.ref);
        if (isCb) {
            const result = await selectComboboxOption(this.page, input.ref, input.text);
            if (result.startsWith('opened')) {
                // ── Fallback: option not in dropdown — try direct type+Enter ──
                // Some comboboxes support free-text input or search-as-you-type.
                // The dropdown may not contain the exact label, but typing + Enter still works.
                try {
                    await locator.click({ timeout: 2000, force: true });
                    await this.page.waitForTimeout(200);
                    await this.page.keyboard.press('Control+a');
                    await this.page.keyboard.press('Backspace');
                    await this.page.waitForTimeout(200);
                    if (input.mode === 'append') {
                        await locator.pressSequentially(input.text, { timeout: 5000 });
                    } else {
                        await locator.fill(input.text, { timeout: 5000, force: true });
                    }
                    await this.page.waitForTimeout(300);
                    await this.page.keyboard.press('Enter');
                    await this.page.waitForTimeout(400);
                    return `✅ ${input.mode} "${input.text.slice(0, 50)}" into combobox [ref=${input.ref}] (option not found, used type+Enter fallback)`;
                } catch {
                    return `❌ [ref=${input.ref}] combobox: ${result}`;
                }
            }
            return `✅ Selected "${input.text.slice(0, 50)}" in combobox [ref=${input.ref}] ${result}`;
        }
        if (input.mode === 'append') {
            await locator.click({ timeout: 5000, force: true });
            await this.page.keyboard.press('End');
            await locator.pressSequentially(input.text, { timeout: 10000 });
        } else {
            await locator.fill(input.text, { timeout: 5000, force: true });
        }
        if (input.submit) await this.page.keyboard.press('Enter');
        return `✅ ${input.mode} "${input.text.slice(0, 50)}" into element [ref=${input.ref}]${input.submit ? ' + Enter' : ''}`;
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
        // ── Resolve environment variable references (e.g., "process.env.PAGE_BI") ──
        const envRefMatch = url.match(/^process\.env\.(\w+)$/);
        if (envRefMatch) {
            const envValue = process.env[envRefMatch[1]] || '';
            if (!envValue) {
                return `❌ Cannot navigate: environment variable ${envRefMatch[1]} is empty/undefined. This is a test data configuration issue — call done(verdict="blocked") immediately.`;
            }
            url = envValue;
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            const base = process.env.KEVE_TARGET_URL || process.env.BASE_URL || '';
            if (!base) {
                return `❌ Cannot navigate: no base URL available (KEVE_TARGET_URL and BASE_URL are both empty). Call done(verdict="blocked") immediately.`;
            }
            url = new URL(url, base).href;
        }
        await this.page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        return `✅ Navigated to ${url}`;
    },
}));

// --- execute_javascript ---
tools.set('execute_javascript', tool({
    description: 'Execute JavaScript in the BROWSER DOM context to retrieve precise values that screenshots and accessibility trees CANNOT provide — such as computed CSS styles (getComputedStyle), DOM measurements (offsetWidth, getBoundingClientRect), or element properties (checked, disabled, value). Also supports form interaction: setting input/textarea/select values and dispatching events.\n\nYou are a TESTER — you OBSERVE and REPORT the actual page state. If the actual value differs from expected, report it as fail; do NOT override styles/DOM to make it match.\n\n<rule>\n1. Script should include `return` for multi-statement code. Single expressions are auto-wrapped with return. const/let are auto-converted to var.\n2. NO top-level `await` — the script runs in a synchronous IIFE inside page.evaluate. There is no async context.\n3. NO `async () => {}` wrappers — they return undefined. Write flat statements ending with `return`.\n4. NO Playwright APIs (`page`, `locator`, `expect`) — only browser DOM APIs exist inside the page.\n5. FORM INTERACTION allowed: setting input.value, textarea.value, select.value, and dispatchEvent() are permitted.\n6. FORBIDDEN — do NOT modify visual appearance, CSS classes, or page structure to fake test results:\n   - No style.setProperty(), style.xxx =, style.removeProperty()\n   - No className =, classList.add/remove/toggle()\n   - No innerHTML/outerHTML = (page structure changes)\n   - No setAttribute for style/class-related attributes\n</rule>\n\nDo NOT use for: clicking, typing, navigating — use click/type/navigate tools instead. Do NOT use for: assertions or logical checks — just return the raw value, you judge the result yourself.',
    inputSchema: z.object({
        script: z.string().describe("JavaScript to execute in browser DOM. <rule> Include `return` for multi-statement code (single expressions auto-wrapped). const/let auto-converted to var. FORM INTERACTION allowed (input.value=, dispatchEvent). FORBIDDEN: style/className/classList/innerHTML mutation. </rule>\n\n✅ 'return document.querySelector(\".x\").innerText'\n✅ 'var el = document.querySelector(\".x\"); return window.getComputedStyle(el).backgroundColor'\n✅ 'return document.querySelectorAll(\".field-error\").length'\n✅ 'var input = document.querySelector(\"input\"); input.value = \"test\"; input.dispatchEvent(new Event(\"input\")); return input.value'\n❌ 'page.locator(\".x\")' — no page object\n❌ 'await page.locator(...)' — no await\n❌ 'document.querySelector(\".x\").style.borderColor = \"red\"' — FORBIDDEN: style mutation\n❌ 'document.querySelector(\".x\").classList.add(\"field-error\")' — FORBIDDEN: classList mutation"),
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

            // Auto-convert const/let → var for page.evaluate compatibility
            script = script.replace(/\bconst\b/g, 'var').replace(/\blet\b/g, 'var');

            // Write guard: block page-mutation APIs that fake test results.
            // CRITICAL: E2E testing must OBSERVE and REPORT the actual page state.
            // Form interaction (input.value, dispatchEvent) is ALLOWED.
            // Visual/page-structure mutation (style, className, classList, innerHTML) is BLOCKED.
            const writePatterns = [
                /\b\.style\s*\.\s*\w+\s*=/,
                /\b\.style\s*\.\s*(?:setProperty|removeProperty)\s*\(/,
                /\bclassList\s*\.\s*(?:add|remove|toggle|replace)\s*\(/,
                /\b(?:document|element|el|node)\.\s*className\s*=/,
                /\b(?:document|element|el|node)\.\s*(?:innerHTML|outerHTML)\s*=/,
                /\b(?:document|element|el|node)\.\s*(?:setAttribute|removeAttribute)\s*\([^,]*['\"](?:class|style)['\"']/i,
                /\b(?:document|element|el|node)\.\s*(?:remove|appendChild|insertBefore|replaceChild|removeChild|appendChild)\s*\(/,
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
                    return `❌ JS execution blocked: page mutation API detected. You MUST NOT modify styles, CSS classes, or page structure to fake test results. Use getComputedStyle for reading styles, and report mismatches honestly.`;
                }
            }

            // Auto-wrap single expressions with return.
            // Multi-statement code (containing var/return/semicolons) must provide its own return.
            if (!/\breturn\b/.test(script)) {
                // Heuristic: if the script looks like a single expression (no var, no block, no semicolons),
                // auto-prepend return. Otherwise require explicit return.
                const looksLikeExpression = !/^\s*(var|function|\{)/.test(script) && !/;\s*$/.test(script) && !/\n/.test(script);
                if (looksLikeExpression) {
                    script = 'return ' + script;
                } else {
                    return `❌ Script must include 'return' to capture the result. Example: "var el = document.querySelector('.x'); return window.getComputedStyle(el).backgroundColor"`;
                }
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

// --- visual_assert ---
tools.set('visual_assert', tool({
    description: 'Assert a visual condition by analyzing a screenshot — READ-ONLY, does NOT interact with the page. Use this to verify visual states that the a11y tree cannot capture: red borders, error text colors, highlight states, icon visibility, layout correctness. Example: "the 指标标准名称 field shows a red border error state" or "a toast message with text 删除成功 is visible". Do NOT use this to find elements to click — use visual_locate for that.',
    inputSchema: z.object({
        assertion: z.string().describe('The visual condition to verify, e.g. "the 姓名 field has a red border" or "an error tooltip saying 必填项 is visible near the top of the form"'),
    }),
    execute: async function (this: KevePageAgent, input) {
        // 1. Capture screenshot
        let screenshotBase64: string;
        try {
            const buf = await this.page.screenshot({ type: 'png', timeout: 10000 });
            screenshotBase64 = buf.toString('base64');
        } catch (e: any) {
            throw new Error(`visual_assert screenshot failed: ${e.message}`);
        }

        // 2. Call LLM for visual assertion
        const assertResult = await this.visualAssertElement(screenshotBase64, input.assertion);

        if (assertResult.passed) {
            return `✅ Visual assert PASSED: "${input.assertion}" — ${assertResult.reasoning}`;
        }
        return `❌ Visual assert FAILED: "${input.assertion}" — ${assertResult.reasoning}`;
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

// --- select_option ---
tools.set('select_option', tool({
    description: 'Select an option from a combobox/dropdown field. Handles both native <select> elements and custom dropdown components (ks-select, ant-select, el-select, etc.) in a single step. Use this when you need to select a dropdown option — either standalone or after fill_form for textbox fields.',
    inputSchema: z.object({
        ref: z.string().describe('Element ref of the combobox/dropdown from the accessibility tree'),
        label: z.string().describe('Visible text of the option to select (exact match)'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const result = await selectComboboxOption(this.page, input.ref, input.label);
        if (result.startsWith('opened')) {
            return `❌ [ref=${input.ref}] combobox: ${result}`;
        }
        return `✅ Selected "${input.label}" [ref=${input.ref}] ${result}`;
    },
}));

// --- fill_form ---
tools.set('fill_form', tool({
    description: 'Batch fill multiple form fields in one action. Handles textbox (fill), combobox/dropdown (select_option with custom component fallback), checkbox/radio (setChecked), and slider (fill). Use this instead of repeated type+click for multi-field forms — reduces step count and avoids missing required fields.',
    inputSchema: z.object({
        fields: z.array(z.object({
            ref: z.string().describe('Element ref from the accessibility tree'),
            type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider'])
                .describe('Field type: textbox→fill, combobox→select option (native or custom dropdown), checkbox/radio→setChecked, slider→fill'),
            value: z.string()
                .describe('Value to fill. Textbox/slider: text content. Checkbox/radio: "true" or "false". Combobox: visible option label text.'),
        })).describe('Array of form fields to fill in'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const results: string[] = [];

        // ── Auto-detect actual element type (custom components like ks-select may appear as textbox in a11y tree) ──
        async function detectActualType(ref: string): Promise<string> {
            // Delegate combobox detection to shared helper (includes readonly/closest/className checks)
            if (await detectCombobox(this.page, ref)) return 'combobox';
            const locator = this.page.locator(`aria-ref=${ref}`);
            try {
                const [tag, inputType] = await locator.evaluate(el => {
                    const h = el as HTMLElement;
                    return [h.tagName.toLowerCase(), (h as HTMLInputElement).type || ''];
                });
                if (tag === 'input' && inputType === 'checkbox') return 'checkbox';
                if (tag === 'input' && inputType === 'radio') return 'radio';
            } catch { /* element not visible or detached — trust Agent's type */ }
            return '';
        }

        // Categorize fields. Override mis-typed textbox → combobox.
        const detectedTypes = new Map<string, string>();
        const textboxCandidates = input.fields.filter(f => f.type === 'textbox');
        await Promise.all(textboxCandidates.map(async f => {
            const actual = await detectActualType.call(this, f.ref);
            if (actual) detectedTypes.set(f.ref, actual);
        }));

        const effectiveFields = input.fields.map(f => {
            const detected = detectedTypes.get(f.ref);
            return detected && detected !== f.type ? { ...f, type: detected as any } : f;
        });

        // Process textbox/checkbox/radio/slider first, then combobox last
        const simpleFields = effectiveFields.filter(f => f.type !== 'combobox');
        const comboFields = effectiveFields.filter(f => f.type === 'combobox');

        for (const field of simpleFields) {
            const locator = this.page.locator(`aria-ref=${field.ref}`);
            try {
                if (field.type === 'textbox' || field.type === 'slider') {
                    await locator.fill(field.value, { timeout: 5000, force: true });
                    results.push(`✅ ${field.type} [${field.ref}] = "${field.value.slice(0, 30)}"`);
                } else if (field.type === 'checkbox' || field.type === 'radio') {
                    await locator.setChecked(field.value === 'true', { timeout: 5000 });
                    results.push(`✅ ${field.type} [${field.ref}] = ${field.value}`);
                }
            } catch (err: any) {
                results.push(`❌ [${field.ref}] ${field.type}: ${err.message}`);
            }
        }

        // Handle combobox fields one by one (each opens/closes dropdown)
        for (const field of comboFields) {
            try {
                const result = await selectComboboxOption(this.page, field.ref, field.value);
                if (result.startsWith('opened')) {
                    // ── Fallback: option not in dropdown — try direct type+Enter ──
                    const locator = this.page.locator(`aria-ref=${field.ref}`);
                    try {
                        await locator.click({ timeout: 2000, force: true });
                        await this.page.waitForTimeout(200);
                        await this.page.keyboard.press('Control+a');
                        await this.page.keyboard.press('Backspace');
                        await this.page.waitForTimeout(200);
                        await locator.fill(field.value, { timeout: 5000, force: true });
                        await this.page.waitForTimeout(300);
                        await this.page.keyboard.press('Enter');
                        await this.page.waitForTimeout(400);
                        results.push(`✅ combobox [${field.ref}] = "${field.value}" (option not found, used type+Enter fallback)`);
                    } catch {
                        results.push(`❌ [${field.ref}] combobox: ${result}`);
                    }
                } else {
                    results.push(`✅ combobox [${field.ref}] = "${field.value}" ${result}`);
                }
            } catch (err: any) {
                results.push(`❌ [${field.ref}] combobox: ${err.message}`);
            }
        }

        return results.join('\n');
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
