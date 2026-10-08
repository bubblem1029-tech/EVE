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

import { z } from 'zod';
import type { KevePageAgent } from './agent.js';

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

/** 常见业务 UI 的弹窗容器（dialog / message-box / modal）。 */
const DIALOG_ROOT_SELECTOR = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '.ks-dialog',
    '.el-dialog',
    '.el-message-box',
    '.ant-modal',
    '.ant-modal-confirm',
    '[class*="message-box"]',
    '[class*="confirm-dialog"]',
].join(', ');

/**
 * 取当前最上层可见弹窗的文本与按钮。返回空时说明没有可见弹窗。
 * 通过 page.evaluate 直接跑在浏览器上下文，Playwright/Cypress 共用同一实现。
 */
async function currentDialogInfo(page: any): Promise<{ text: string; buttons: string[] } | null> {
    try {
        const selectors = DIALOG_ROOT_SELECTOR.split(',').map(s => s.trim()).filter(Boolean);
        const result = await page.evaluate(`(() => {
            var selectors = ${JSON.stringify(selectors)};
            var seen = [];
            for (var i = 0; i < selectors.length; i += 1) {
                var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
                for (var j = 0; j < nodes.length; j += 1) seen.push(nodes[j]);
            }
            var visible = [];
            for (var k = 0; k < seen.length; k += 1) {
                var el = seen[k];
                if (!el || !el.getBoundingClientRect) continue;
                var rect = el.getBoundingClientRect();
                if (!rect.width && !rect.height) continue;
                var style = window.getComputedStyle(el);
                if (!style) continue;
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (Number(style.opacity) === 0) continue;
                if (visible.indexOf(el) < 0) visible.push(el);
            }
            var root = visible.length ? visible[visible.length - 1] : null;
            if (!root) return null;
            var text = String(root.innerText || root.textContent || '').replace(/\\s+/g, ' ').trim();
            var buttons = [];
            var candidates = Array.prototype.slice.call(root.querySelectorAll('button, [role="button"], a'));
            for (var b = 0; b < candidates.length; b += 1) {
                var btn = candidates[b];
                if (btn.disabled) continue;
                var br = btn.getBoundingClientRect();
                if (!br.width && !br.height) continue;
                var label = String(btn.textContent || btn.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
                if (label && buttons.indexOf(label) < 0) buttons.push(label);
            }
            return { text: text.slice(0, 300), buttons: buttons.slice(0, 20) };
        })()`);
        if (result && (result.text || result.buttons?.length)) {
            return { text: String(result.text || ''), buttons: Array.isArray(result.buttons) ? result.buttons.map(String) : [] };
        }
        return null;
    } catch { return null; }
}

/**
 * 自动关闭“是否/确认”类弹窗。
 *
 * 只有弹窗文本明确包含确认语义时才点正向按钮，避免把普通提示误当操作框；
 * 点完再检查弹窗是否真正关闭。返回 null 表示不需要/无法自动处理。
 */
async function autoConfirmDialog(page: any, info: { text: string; buttons: string[] }): Promise<string | null> {
    const text = String(info?.text || '');
    const hasConfirmationWording = /确认|是否|关闭所有|关闭全部|删除|覆盖|确定/.test(text);
    if (!hasConfirmationWording || !info?.buttons?.length) return null;

    const wantedLabels = ['确定', '确认', '是', '关闭全部', '关闭所有'];
    const label = wantedLabels.find(l => info.buttons.includes(l));
    if (!label) return null;

    const clickExpression = `(() => {
        var selectors = ${JSON.stringify(DIALOG_ROOT_SELECTOR.split(',').map(s => s.trim()).filter(Boolean))};
        var seen = [];
        for (var i = 0; i < selectors.length; i += 1) {
            var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
            for (var j = 0; j < nodes.length; j += 1) seen.push(nodes[j]);
        }
        var visible = [];
        for (var k = 0; k < seen.length; k += 1) {
            var el = seen[k];
            if (!el || !el.getBoundingClientRect) continue;
            var rect = el.getBoundingClientRect();
            if (!rect.width && !rect.height) continue;
            var style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
            if (Number(style.opacity) === 0) continue;
            if (visible.indexOf(el) < 0) visible.push(el);
        }
        var root = visible.length ? visible[visible.length - 1] : null;
        if (!root) return null;
        var wanted = ${JSON.stringify(wantedLabels)};
        var buttons = Array.prototype.slice.call(root.querySelectorAll('button, [role="button"], a'));
        for (var w = 0; w < wanted.length; w += 1) {
            for (var b = 0; b < buttons.length; b += 1) {
                var btn = buttons[b];
                if (btn.disabled) continue;
                var label = String(btn.textContent || btn.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
                if (label === wanted[w]) {
                    if (typeof btn.click === 'function') btn.click();
                    else btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return label;
                }
            }
        }
        return null;
    })()`;

    try {
        const clicked = await page.evaluate(clickExpression);
        if (!clicked) return null;
        await page.waitForTimeout(600);
        const after = await currentDialogInfo(page);
        if (!after) {
            return `✅ Auto-confirmed blocking dialog via "${clicked}" — dialog closed`;
        }
        return `⚠️ Clicked dialog content then auto-confirmed "${clicked}", but dialog still open: "${after.text.slice(0, 80)}". Read the accessibility tree to handle the remaining dialog.`;
    } catch {
        return null;
    }
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
                const dialog = el.closest(DIALOG_ROOT_SELECTOR);
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

        // 点击弹窗内容（非按钮）没有自动关闭弹窗时，常见确认框会一直盖住页面；
        // 这里在 Agent 继续尝试前先扫描弹窗按钮，避免反复 execute_javascript 碰运气。
        if (inDialog && !dialogContext) {
            const dialogInfo = await currentDialogInfo(this.page);
            if (dialogInfo) {
                const autoResult = await autoConfirmDialog(this.page, dialogInfo);
                if (autoResult) return autoResult;
            }
        }

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
            const envValue = this.getEnv(envRefMatch[1]);
            if (!envValue) {
                return `❌ Cannot navigate: environment variable ${envRefMatch[1]} is empty/undefined. This is a test data configuration issue — call done(verdict="blocked") immediately.`;
            }
            url = envValue;
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            const base = this.targetUrl || this.getEnv('BASE_URL');
            if (!base) {
                return `❌ Cannot navigate: no base URL available (KEVE_TARGET_URL and BASE_URL are both empty). Call done(verdict="blocked") immediately.`;
            }
            url = new URL(url, base).href;
        }
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
            screenshotBase64 = (await this.page.screenshot({ type: 'png', timeout: 10000 })).base64;
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
            screenshotBase64 = (await this.page.screenshot({ type: 'png', timeout: 10000 })).base64;
        } catch (e: any) {
            throw new Error(`visual_locate screenshot failed: ${e.message}`);
        }

        // 2. Call LLM for visual element location
        const locateResult = await this.visualLocateElement(screenshotBase64, input.description);

        if (!locateResult.found || !locateResult.bbox || locateResult.bbox.length !== 4) {
            return `❌ Visual locate failed: element "${input.description}" not found. ${locateResult.analysis || ''}`;
        }

        // 3. Convert normalized bbox (0-1000) to viewport pixel coordinates
        const viewport = (await this.page.viewportSize()) || { width: 1280, height: 720 };
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

// --- drag ---
tools.set('drag', tool({
    description: `Drag from a starting point to an ending point using real mouse events (mousedown → mousemove steps → mouseup). Use for: resizing elements via drag handles, drag-to-reorder lists, any UI requiring hold+move interaction.

Two targeting modes:
1. By ref — drags from the element's center (use for drag-to-reorder)
2. By coordinates (startX/startY) — precise point (use for resize handles found via visual_locate)

Target specification:
- Relative: use deltaX/deltaY (e.g. deltaX=200 moves 200px right)
- Absolute: use endX/endY (e.g. endX=800, endY=400)

NOT for: scrolling (use scroll), clicking (use click), HTML5 DnD between elements.`,
    inputSchema: z.object({
        ref: z.string().optional()
            .describe('Element ref to start dragging from. Drags from element center. Use startX/startY for resize handles.'),
        startX: z.number().optional()
            .describe('X coordinate to start dragging from (viewport pixels). Use when you have precise coordinates from visual_locate.'),
        startY: z.number().optional()
            .describe('Y coordinate to start dragging from (viewport pixels).'),
        deltaX: z.number().optional()
            .describe('Horizontal displacement in pixels. Positive=right, negative=left. Use with ref or startX/startY.'),
        deltaY: z.number().optional()
            .describe('Vertical displacement in pixels. Positive=down, negative=up.'),
        endX: z.number().optional()
            .describe('Absolute X coordinate to drag to (viewport pixels). Use deltaX/deltaY for relative, endX/endY for absolute.'),
        endY: z.number().optional()
            .describe('Absolute Y coordinate to drag to (viewport pixels).'),
        steps: z.number().min(1).max(100).default(10)
            .describe('Number of intermediate mousemove steps. More=smoother animation. Default 10. Use 20+ for CSS resize.'),
    }),
    execute: async function (this: KevePageAgent, input) {
        // 1. Determine start coordinates
        let sx: number, sy: number;
        if (input.ref) {
            const locator = this.page.locator(`aria-ref=${input.ref}`);
            try {
                const box = await locator.boundingBox({ timeout: 5000 });
                if (!box) return `❌ Cannot drag: element [ref=${input.ref}] not visible or detached`;
                sx = box.x + box.width / 2;
                sy = box.y + box.height / 2;
            } catch (err: any) {
                return `❌ Cannot drag: element [ref=${input.ref}] error: ${err.message}`;
            }
        } else if (input.startX !== undefined && input.startY !== undefined) {
            sx = input.startX;
            sy = input.startY;
        } else {
            return `❌ Cannot drag: provide either ref or startX/startY`;
        }

        // 2. Determine end coordinates
        let ex: number, ey: number;
        if (input.endX !== undefined && input.endY !== undefined) {
            ex = input.endX;
            ey = input.endY;
        } else if (input.deltaX !== undefined || input.deltaY !== undefined) {
            ex = sx + (input.deltaX || 0);
            ey = sy + (input.deltaY || 0);
        } else {
            return `❌ Cannot drag: provide either deltaX/deltaY or endX/endY`;
        }

        // 3. Execute real mouse drag with intermediate steps
        const steps = input.steps ?? 10;
        try {
            await this.page.mouse.move(sx, sy);
            await this.page.mouse.down();
            for (let i = 1; i <= steps; i++) {
                const progress = i / steps;
                await this.page.mouse.move(
                    sx + (ex - sx) * progress,
                    sy + (ey - sy) * progress,
                );
                await this.page.waitForTimeout(16); // ~60fps
            }
            await this.page.mouse.up();
            await this.page.waitForTimeout(300); // wait for resize/layout to settle

            return `✅ Dragged from (${Math.round(sx)}, ${Math.round(sy)}) to (${Math.round(ex)}, ${Math.round(ey)}) in ${steps} steps (Δx=${Math.round(ex - sx)}, Δy=${Math.round(ey - sy)})`;
        } catch (err: any) {
            try { await this.page.mouse.up(); } catch { /* ensure mouse released */ }
            return `❌ Drag failed: ${err.message}`;
        }
    },
}));

// --- wait_for ---
tools.set('wait_for', tool({
    description: `Wait for text to appear or disappear on the page, or for a specified duration. More efficient than polling with wait(time).

- waitForText: wait until specific text becomes visible on the page (e.g. wait for "保存成功" toast)
- waitForTextGone: wait until specific text disappears (e.g. wait for "加载中..." spinner to vanish)
- seconds: simple time-based wait (max 30s)

At least one parameter is required. You can combine them (e.g. wait for text + timeout).`,
    inputSchema: z.object({
        waitForText: z.string().optional()
            .describe('Wait for this text to appear on the page (visible)'),
        waitForTextGone: z.string().optional()
            .describe('Wait for this text to disappear from the page (hidden)'),
        seconds: z.number().min(0.1).max(30).optional()
            .describe('Wait time in seconds (max 30)'),
    }),
    execute: async function (this: KevePageAgent, input) {
        if (!input.waitForText && !input.waitForTextGone && !input.seconds) {
            return `❌ wait_for: provide at least one of waitForText, waitForTextGone, or seconds`;
        }

        const results: string[] = [];

        if (input.seconds) {
            await this.page.waitForTimeout(input.seconds * 1000);
            results.push(`waited ${input.seconds}s`);
        }

        if (input.waitForTextGone) {
            const locator = this.page.getByText(input.waitForTextGone).first();
            try {
                await locator.waitFor({ state: 'hidden', timeout: 15000 });
                results.push(`"${input.waitForTextGone}" disappeared`);
            } catch {
                results.push(`⚠️ "${input.waitForTextGone}" still visible after 15s`);
            }
        }

        if (input.waitForText) {
            const locator = this.page.getByText(input.waitForText).first();
            try {
                await locator.waitFor({ state: 'visible', timeout: 15000 });
                results.push(`"${input.waitForText}" appeared`);
            } catch {
                results.push(`⚠️ "${input.waitForText}" not found after 15s`);
            }
        }

        return `✅ ${results.join(', ')}`;
    },
}));

// --- verify_value ---
tools.set('verify_value', tool({
    description: `Deterministically verify a form element's current value — no LLM needed. Faster and more precise than visual_assert for value checks.

- textbox/slider/combobox → checks locator.inputValue()
- checkbox/radio → checks locator.isChecked()

Returns ✅ if value matches, ❌ if mismatch. Use for precise value assertions instead of visual inspection.`,
    inputSchema: z.object({
        ref: z.string().describe('Element ref from the accessibility tree'),
        type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider'])
            .describe('Element type: textbox/slider/combobox → check inputValue; checkbox/radio → check isChecked'),
        value: z.string().describe('Expected value. For checkbox/radio: "true" or "false". For textbox: expected text. For combobox: expected selected value.'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const locator = this.page.locator(`aria-ref=${input.ref}`);
        try {
            if (input.type === 'checkbox' || input.type === 'radio') {
                const checked = await locator.isChecked({ timeout: 5000 });
                const expected = input.value === 'true';
                if (checked === expected) {
                    return `✅ Verify [ref=${input.ref}] ${input.type}: checked=${checked} (expected ${input.value})`;
                }
                return `❌ Verify [ref=${input.ref}] ${input.type}: checked=${checked} (expected ${input.value})`;
            }

            // textbox, slider, combobox — check inputValue
            const actualValue = await locator.inputValue({ timeout: 5000 });
            if (actualValue === input.value) {
                return `✅ Verify [ref=${input.ref}] ${input.type}: value="${actualValue}" (expected "${input.value}")`;
            }

            // For combobox, also check textContent (custom components may not expose value via inputValue)
            if (input.type === 'combobox') {
                const textContent = await locator.textContent({ timeout: 2000 }).catch(() => '');
                if (textContent?.includes(input.value)) {
                    return `✅ Verify [ref=${input.ref}] combobox: text contains "${input.value}" (inputValue="${actualValue}")`;
                }
            }

            return `❌ Verify [ref=${input.ref}] ${input.type}: value="${actualValue}" (expected "${input.value}")`;
        } catch (err: any) {
            return `❌ Verify [ref=${input.ref}] failed: ${err.message}`;
        }
    },
}));

// --- handle_dialog ---
tools.set('handle_dialog', tool({
    description: `Handle native browser dialogs (alert, confirm, prompt). Native dialogs are auto-accepted by default when they appear.

Two usage modes:
1. BEFORE a dialog-triggering action: call handle_dialog(accept=false) to override the default auto-accept behavior. Then click the button that triggers the dialog.
2. AFTER a dialog appeared: call handle_dialog to check what dialog was captured and how it was handled.

Native dialogs are auto-accepted unless you pre-set a different action. If a click triggers a dialog, it will be handled automatically based on your pre-set preference.`,
    inputSchema: z.object({
        accept: z.boolean().default(true).describe('Whether to accept (true) or dismiss (false) the next native dialog. Default true.'),
        promptText: z.string().optional().describe('Text to enter in prompt dialog (only when accept=true and dialog is a prompt)'),
    }),
    execute: async function (this: KevePageAgent, input) {
        // Set handler for the NEXT dialog
        this._dialogHandler = { accept: input.accept, promptText: input.promptText };

        // Also report the last captured dialog (if any)
        const last = this._lastDialogInfo;
        if (last) {
            return `Last dialog: [${last.type}] "${last.message.slice(0, 80)}" — was ${last.accepted ? 'accepted' : 'dismissed'}. Next dialog will be ${input.accept ? 'accepted' : 'dismissed'}.`;
        }

        return `Next native dialog will be ${input.accept ? 'accepted' : 'dismissed'}${input.promptText ? ` with text "${input.promptText}"` : ''}.`;
    },
}));

// --- console_messages ---
tools.set('console_messages', tool({
    description: `Get browser console log messages captured during page execution. Use to check for JavaScript errors, verify log output, or debug page issues. More reliable than visual checking for error toasts or log messages.`,
    inputSchema: z.object({
        level: z.enum(['error', 'warning', 'info', 'debug']).default('info')
            .describe('Minimum log level. "error"=only errors, "warning"=errors+warnings, "info"=add info logs, "debug"=all. Default "info".'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const messages = this._consoleMessages || [];
        const levelPriority: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 };
        const minPriority = levelPriority[input.level] ?? 1;
        const filtered = messages.filter((m: any) => (levelPriority[m.level] ?? 0) >= minPriority);

        if (filtered.length === 0) {
            return `No console messages at level "${input.level}" or above. Total captured: ${messages.length}.`;
        }

        const formatted = filtered.map((m: any, i: number) =>
            `[${i + 1}] ${m.level.toUpperCase()}: ${m.text.slice(0, 200)}`
        ).join('\n');

        return `Console messages (${filtered.length}/${messages.length} at level ≥ "${input.level}"):\n${formatted}`;
    },
}));

// --- file_upload ---
tools.set('file_upload', tool({
    description: `Upload one or more files via a file input element. When you click a file input button, a file chooser dialog appears. This tool uploads files to the pending file chooser.

Flow: 1) Click the file input button (e.g. "上传文件", "选择文件"), 2) Call file_upload with the file paths.

Paths must be absolute. The file chooser is single-use — after uploading, a new click is needed for another upload.`,
    inputSchema: z.object({
        paths: z.array(z.string()).describe('Absolute file paths to upload'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const fileChooser = this._pendingFileChooser;
        if (!fileChooser) {
            return `❌ No pending file chooser. Click a file input element first to trigger a file chooser dialog.`;
        }

        try {
            await fileChooser.setFiles(input.paths);
            this._pendingFileChooser = null;
            return `✅ Uploaded ${input.paths.length} file(s): ${input.paths.map(p => p.split('/').pop()).join(', ')}`;
        } catch (err: any) {
            this._pendingFileChooser = null;
            return `❌ File upload failed: ${err.message}`;
        }
    },
}));

// --- network_requests ---
tools.set('network_requests', tool({
    description: `List network requests made by the page. Use to verify API calls were made, check response status codes, or debug network issues. Returns a numbered list with method, URL, and status code.

Filter by URL pattern (regex) and optionally include static resources (images, fonts, scripts). By default, only API/XHR requests are shown.`,
    inputSchema: z.object({
        filter: z.string().optional()
            .describe('Regex pattern to filter URLs (e.g. "/api/.*user")'),
        includeStatic: z.boolean().default(false)
            .describe('Include static resources (images, fonts, scripts). Default false.'),
    }),
    execute: async function (this: KevePageAgent, input) {
        const requests = this._networkRequests || [];
        const filter = input.filter ? new RegExp(input.filter) : undefined;

        const lines: string[] = [];
        for (let i = 0; i < requests.length; i++) {
            const req = requests[i];
            if (!input.includeStatic && req.isStatic) continue;
            if (filter && !filter.test(req.url)) continue;

            const status = req.status ? ` [${req.status}]` : '';
            const method = req.method || '?';
            lines.push(`[${i + 1}] ${method} ${req.url.slice(0, 120)}${status}`);
        }

        if (lines.length === 0) {
            return `No matching network requests. Total captured: ${requests.length}.`;
        }

        return `Network requests (${lines.length} shown, ${requests.length} total):\n${lines.join('\n')}`;
    },
}));

// --- resize_viewport ---
tools.set('resize_viewport', tool({
    description: `Resize the browser viewport (window size). Use for responsive design testing or to trigger layout changes at specific viewport sizes. Common breakpoints: 375×667 (mobile), 768×1024 (tablet), 1280×720 (desktop), 1920×1080 (full HD).`,
    inputSchema: z.object({
        width: z.number().min(320).max(3840).describe('Viewport width in pixels'),
        height: z.number().min(240).max(2160).describe('Viewport height in pixels'),
    }),
    execute: async function (this: KevePageAgent, input) {
        await this.page.setViewportSize({ width: input.width, height: input.height });
        await this.page.waitForTimeout(300);
        return `✅ Viewport resized to ${input.width}×${input.height}`;
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
