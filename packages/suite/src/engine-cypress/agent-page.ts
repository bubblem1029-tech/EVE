/**
 * agent-page — Cypress 侧的 AgentPage 实现（CDP + 页内 agentDom）
 *
 * 与 Playwright 侧的 `page-agent/playwright-page.ts` 一一对应：同一个 Re-Act
 * 循环吃同一份 `AgentPage` 契约，差异只在这层：
 *   - DOM 读写全部经 CDP 在 AUT isolated world 内求值（绝不碰 runner 顶层页）
 *   - 键盘/鼠标走 CDP Input 域，坐标需叠加 AUT iframe 在 runner 里的偏移
 *   - 截图统一裁剪到 AUT iframe，元素截图在此基础上再按 boundingBox 裁一次
 *
 * 本模块零 Node 依赖，也不得 import '@playwright/test'（连类型都不需要）。
 */

import type {
  AgentBoundingBox,
  AgentKeyboard,
  AgentLocator,
  AgentMouse,
  AgentPage,
  AgentScreenshot,
} from '../page-agent/page-like.js';
import { isRunnerFrameUrl, type Cdp } from './cdp.js';
import { agentBootstrapSource } from './agentDom.js';
import {
  buildRuntimeDiagnostics,
  type PagePerformanceMetrics,
  type RawConsoleRecord,
  type RawNetworkRecord,
} from '../page-agent/diagnostics.js';

/** 主世界诊断采集写入 DOM 的快照形态 */
interface CypressDiagnosticsSnapshot {
  browser?: RawConsoleRecord[];
  network?: RawNetworkRecord[];
  page?: PagePerformanceMetrics;
}

function maxPageMetric(values: Array<number | undefined>): number | undefined {
  let max = 0;
  for (const value of values) {
    if (value !== undefined && Number(value) > max) max = Number(value);
  }
  return max > 0 ? max : undefined;
}

/**
 * 合并多个 frame 的主世界诊断快照。
 *
 * 业务页面（如 kwaibi）可能把主要内容放在同源/跨域 iframe 内；单个 frame
 * 的 dataset 只包含自己上下文里发生的 console/网络/性能事件，不能只看 AUT
 * 顶层 frame。计数类网络/console 记录直接拼接，页面性能只有 longtask 是
 * 可累加阻塞量，其余指标取各 frame 的最大值。
 */
export function mergeFrameDiagnostics(
  snaps: Array<CypressDiagnosticsSnapshot | undefined>,
): CypressDiagnosticsSnapshot | undefined {
  const valid = snaps.filter(Boolean) as CypressDiagnosticsSnapshot[];
  if (!valid.length) return undefined;

  const browser: RawConsoleRecord[] = [];
  const network: RawNetworkRecord[] = [];
  const page: PagePerformanceMetrics = {};
  const longTaskCount: number[] = [];
  const longTaskMs: number[] = [];

  for (const snap of valid) {
    if (snap.browser?.length) browser.push(...snap.browser);
    if (snap.network?.length) network.push(...snap.network);
    if (!snap.page) continue;
    const current = snap.page;
    page.domContentLoadedMs = maxPageMetric([page.domContentLoadedMs, current.domContentLoadedMs]);
    page.loadMs = maxPageMetric([page.loadMs, current.loadMs]);
    page.lcpMs = maxPageMetric([page.lcpMs, current.lcpMs]);
    page.heapUsedMb = maxPageMetric([page.heapUsedMb, current.heapUsedMb]);
    if (current.longTaskCount !== undefined) longTaskCount.push(current.longTaskCount);
    if (current.longTaskMs !== undefined) longTaskMs.push(current.longTaskMs);
  }

  if (longTaskCount.length) {
    page.longTaskCount = longTaskCount.reduce((sum, value) => sum + value, 0);
  }
  if (longTaskMs.length) {
    page.longTaskMs = longTaskMs.reduce((sum, value) => sum + value, 0);
  }

  return {
    browser,
    network,
    page: Object.keys(page).length ? page : undefined,
  };
}

/** locator 链的一跳：与 agentDom.resolve() 的 op 结构一一对应 */
type LocOp =
  | { t: 'css'; selector: string }
  | { t: 'ariaRef'; ref: string }
  | { t: 'text'; text: string; exact: boolean }
  | { t: 'role'; role: string; name?: string; exact: boolean }
  | { t: 'filterHasText'; text: string }
  | { t: 'filterVisible' };

/** `aria-ref=e12` / Playwright 风格的 `text=`、`role=` 选择器解析 */
function parseSelector(selector: string): LocOp {
  const raw = String(selector || '').trim();
  const ariaRef = raw.match(/^aria-ref=(.+)$/);
  if (ariaRef) return { t: 'ariaRef', ref: ariaRef[1].trim() };
  const textPrefix = raw.match(/^text=(.+)$/s);
  if (textPrefix) {
    const body = textPrefix[1].trim();
    const quoted = body.match(/^(["'])([\s\S]*)\1$/);
    return { t: 'text', text: quoted ? quoted[2] : body, exact: !!quoted };
  }
  return { t: 'css', selector: raw };
}

/** CSS 转义，用于把字符串安全塞进 Runtime.evaluate 表达式 */
function js(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** Playwright 的 `Control+a` 形式 → CDP modifiers 位掩码 */
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** 特殊键 → (key, code, windowsVirtualKeyCode) */
const SPECIAL_KEYS: Record<string, [string, string, number]> = {
  Enter: ['Enter', 'Enter', 13],
  NumpadEnter: ['Enter', 'NumpadEnter', 13],
  Escape: ['Escape', 'Escape', 27],
  Tab: ['Tab', 'Tab', 9],
  Backspace: ['Backspace', 'Backspace', 8],
  Delete: ['Delete', 'Delete', 46],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  Home: ['Home', 'Home', 36],
  End: ['End', 'End', 35],
  PageUp: ['PageUp', 'PageUp', 33],
  PageDown: ['PageDown', 'PageDown', 34],
  Space: [' ', 'Space', 32],
};

export class CyAgentLocator implements AgentLocator {
  constructor(
    private readonly page: CyAgentPage,
    private readonly ops: LocOp[],
    /** null = 集合本身（count/allInnerTexts 用全部）；数字 = 选中项，-1 = last */
    private readonly index: number | null = null,
  ) {}

  private extend(op: LocOp, index = this.index): CyAgentLocator {
    return new CyAgentLocator(this.page, [...this.ops, op], index);
  }

  private withIndex(index: number | null): CyAgentLocator {
    return new CyAgentLocator(this.page, this.ops, index);
  }

  /** 集合语义的索引：null（未约束）在执行动作时按 Playwright 的「首个匹配」处理 */
  private pickIndex(): number | null {
    return this.index === null ? 0 : this.index;
  }

  private resolveExpr(): string {
    return `window.__keveAgent.resolve(${js(this.ops)})`;
  }

  async click(options?: any): Promise<void> {
    await this.page.callAgent('act', [this.ops, this.pickIndex(), 'click'], options);
  }

  async dblclick(options?: any): Promise<void> {
    await this.page.callAgent('act', [this.ops, this.pickIndex(), 'dblclick'], options);
  }

  async fill(value: string, options?: any): Promise<void> {
    await this.page.callAgent('act', [this.ops, this.pickIndex(), 'fill', { value }], options);
  }

  async hover(options?: any): Promise<void> {
    await this.page.callAgent('act', [this.ops, this.pickIndex(), 'hover'], options);
  }

  async pressSequentially(text: string, _options?: any): Promise<void> {
    await this.focus();
    await this.page.keyboard.type(text);
  }

  async focus(): Promise<void> {
    await this.page.callAgent('focus', [this.ops, this.pickIndex()]);
  }

  async evaluate(fn: any, arg?: any): Promise<any> {
    const src = typeof fn === 'string' ? fn : String(fn);
    return await this.page.callAgent('read', [this.ops, this.pickIndex(), 'eval', { fn: src, arg }]);
  }

  async textContent(_options?: any): Promise<string | null> {
    return await this.page.callAgent('read', [this.ops, this.pickIndex(), 'text']);
  }

  async innerText(_options?: any): Promise<string> {
    return (await this.page.callAgent('read', [this.ops, this.pickIndex(), 'innerText'])) ?? '';
  }

  async inputValue(_options?: any): Promise<string> {
    return (await this.page.callAgent('read', [this.ops, this.pickIndex(), 'value'])) ?? '';
  }

  async isChecked(_options?: any): Promise<boolean> {
    return !!await this.page.callAgent('read', [this.ops, this.pickIndex(), 'checked']);
  }

  async setChecked(checked: boolean, _options?: any): Promise<void> {
    await this.page.callAgent('act', [this.ops, this.pickIndex(), 'setChecked', { checked }]);
  }

  async selectOption(values: any, _options?: any): Promise<any> {
    const spec = typeof values === 'string'
      ? { value: values }
      : Array.isArray(values)
        ? { value: values[0] }
        : { value: values?.value, label: values?.label };
    await this.page.callAgent('act', [this.ops, this.pickIndex(), 'selectOption', spec]);
    return [spec.value ?? spec.label];
  }

  async waitFor(options?: any): Promise<void> {
    const state = String(options?.state || 'visible');
    const timeout = Number(options?.timeout ?? 30_000);
    const deadline = Date.now() + timeout;
    for (;;) {
      let ok = false;
      if (state === 'detached') {
        ok = !(await this.page.callAgent('exists', [this.ops, this.pickIndex()]).catch(() => false));
      } else if (state === 'hidden') {
        const exists = await this.page.callAgent('exists', [this.ops, this.pickIndex()]).catch(() => false);
        ok = !exists || !(await this.page.callAgent('visible', [this.ops, this.pickIndex()]).catch(() => false));
      } else if (state === 'attached') {
        ok = await this.page.callAgent('exists', [this.ops, this.pickIndex()]).catch(() => false);
      } else {
        ok = await this.page.callAgent('visible', [this.ops, this.pickIndex()]).catch(() => false);
      }
      if (ok) return;
      if (Date.now() >= deadline) {
        throw new Error(`[keve] locator.waitFor(${state}) 超时（${timeout}ms）: ${JSON.stringify(this.ops)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async boundingBox(_options?: any): Promise<AgentBoundingBox | null> {
    return await this.page.callAgent('read', [this.ops, this.pickIndex(), 'box']);
  }

  async getAttribute(name: string, _options?: any): Promise<string | null> {
    return await this.page.callAgent('read', [this.ops, this.pickIndex(), 'attr', name]);
  }

  async count(): Promise<number> {
    // count() 语义是「整个集合」，不受 first/last/nth 影响
    return await this.page.callAgent('count', [this.ops, null]);
  }

  async allInnerTexts(): Promise<string[]> {
    return (await this.page.callAgent('texts', [this.ops, null])) || [];
  }

  async isVisible(_options?: any): Promise<boolean> {
    return !!await this.page.callAgent('visible', [this.ops, this.pickIndex()]);
  }

  async screenshot(_options?: any): Promise<AgentScreenshot> {
    const box = await this.boundingBox();
    if (box) {
      return { base64: await this.page.cdp.screenshotClip(box) };
    }
    return await this.page.screenshot();
  }

  first(): AgentLocator {
    return this.withIndex(0);
  }

  last(): AgentLocator {
    return this.withIndex(-1);
  }

  nth(index: number): AgentLocator {
    return this.withIndex(Number(index));
  }

  filter(options?: any): AgentLocator {
    if (options?.hasText !== undefined) {
      return this.extend({ t: 'filterHasText', text: String(options.hasText) });
    }
    if (options?.visible !== undefined) {
      return this.extend({ t: 'filterVisible' });
    }
    return this;
  }

  locator(selector: string): AgentLocator {
    return this.extend(parseSelector(selector));
  }

  /** 仅调试用：暴露定位链 */
  toOps(): LocOp[] {
    return [...this.ops];
  }

  /** 供 page.evaluate 之外的诊断使用 */
  resolveHandleExpr(): string {
    return this.resolveExpr();
  }
}

export class CyAgentPage implements AgentPage {
  private dialogHandler: ((dialog: any) => any) | null = null;
  private dialogPreference: { accept: boolean; promptText?: string } | null = null;
  private readonly listeners = new Map<string, Array<(...args: any[]) => any>>();

  constructor(public readonly cdp: Cdp) {
    this.mouse = this.createMouse();
  }

  // ── 页内 agent 能力注入 ────────────────────────────────────────────

  private async ensureAgent(): Promise<void> {
    const ready = await this.cdp
      .evaluateInAut<boolean>('Boolean(window.__keveAgentSource === "v1")')
      .catch(() => false);
    if (ready) return;
    const { locatorSource } = await import('../dsl/locatorSource.js');
    await this.cdp.evaluateInAut(agentBootstrapSource(locatorSource()));
  }

  /**
   * 调用页内 `window.__keveAgent` 的某个方法。
   *
   * 刻意不走 `Runtime.callFunctionOn`：isolated world 里每次求值都是独立表达式，
   * 用 JSON 组装调用最简单，且 agentDom 的入参全是可序列化的 ops/字面量。
   */
  async callAgent<T = any>(method: string, args: any[], _options?: any): Promise<T> {
    await this.ensureAgent();
    const expr = `window.__keveAgent.${method}(${args.map((a) => js(a)).join(', ')})`;
    try {
      return await this.cdp.evaluateInAut<T>(expr);
    } catch (err: any) {
      // 名称/参数顺序错位会让 isolated world 重新注入，重试一次可避开一次性抖动
      const msg = String(err?.message || err);
      throw new Error(msg);
    }
  }

  // ── AgentPage ─────────────────────────────────────────────────────

  locator(selector: string): AgentLocator {
    return new CyAgentLocator(this, [parseSelector(selector)]);
  }

  getByText(text: string, options?: any): AgentLocator {
    return new CyAgentLocator(this, [{
      t: 'text',
      text: String(text),
      exact: options?.exact === true,
    }]);
  }

  getByRole(role: string, options?: any): AgentLocator {
    return new CyAgentLocator(this, [{
      t: 'role',
      role: String(role),
      name: options?.name === undefined ? undefined : String(options.name),
      exact: options?.exact === true,
    }]);
  }

  async ariaSnapshot(_options?: { mode?: string }): Promise<string> {
    await this.ensureAgent();
    return (await this.cdp.evaluateInAut<string>('window.__keveAgent.snapshot(1500)')) || '';
  }

  async url(): Promise<string> {
    return await this.cdp.currentUrl();
  }

  async title(): Promise<string> {
    return (await this.cdp.snapshot()).title || '';
  }

  async goto(url: string, _options?: any): Promise<void> {
    await this.cdp.goto(url);
    // 导航会重建 AUT frame → 注入物一起丢失，下次调用 ensureAgent 时补回来
    this.cdp.invalidateWorld();
  }

  async reload(_options?: any): Promise<void> {
    await this.cdp.reload();
    this.cdp.invalidateWorld();
  }

  async evaluate(fn: any): Promise<any> {
    // tools.ts 传进来的可能是函数，也可能是已拼好的 `(function(){…})()` 字符串
    if (typeof fn === 'string') return await this.cdp.evaluateInAut(fn);
    const src = String(fn);
    return await this.cdp.evaluateInAut(`(${src})()`);
  }

  /**
   * 读取主世界诊断快照。
   *
   * Cypress 的 CDP 通道没有 domain event 订阅，主世界里的 console/网络采集
   * 结果通过 `documentElement.dataset` 暴露给 isolated world —— 两个世界共享
   * DOM，但不共享 JS 全局，这是唯一的稳定只读通道。
   */
  async readDiagnosticsSnapshot(): Promise<CypressDiagnosticsSnapshot | undefined> {
    try {
      const allFrames = await this.cdp.frames().catch(() => []);
      const targets = allFrames.filter((frame) => !isRunnerFrameUrl(frame.url));
      const snaps: Array<CypressDiagnosticsSnapshot | undefined> = [];
      for (const frame of targets) {
        try {
          // 让该 frame 的主世界先把 debounce 中的最后几条记录 flush 进 DOM 再读
          await this.cdp.evaluateInFrame(
            frame.id,
            'window.dispatchEvent(new Event("keve:flush-diagnostics")), "ok"',
          ).catch(() => undefined);
          const raw = await this.cdp.evaluateInFrame<string>(
            frame.id,
            'String((document.documentElement && document.documentElement.dataset.keveDiagnostics) || "")',
          );
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            snaps.push(parsed as CypressDiagnosticsSnapshot);
          }
        } catch {
          // 单个 frame 读取失败不丢弃其他 frame 的采集结果
        }
      }
      return mergeFrameDiagnostics(snaps);
    } catch {
      return undefined;
    }
  }

  async screenshot(_options?: any): Promise<AgentScreenshot> {
    return { base64: await this.cdp.screenshot() };
  }

  async viewportSize(): Promise<{ width: number; height: number } | null> {
    const size = await this.cdp
      .evaluateInAut<{ width: number; height: number }>(
        '({ width: window.innerWidth, height: window.innerHeight })',
      )
      .catch(() => null);
    if (size && size.width > 0 && size.height > 0) return size;
    return null;
  }

  /** 调整 AUT iframe 尺寸（只改 runner 里的 iframe 盒子，不触碰被测页 DOM） */
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    await this.cdp.evaluateInRunner(`(() => {
      var f = document.querySelector('iframe.aut-iframe');
      if (!f) return false;
      f.style.width = ${js(`${size.width}px`)};
      f.style.height = ${js(`${size.height}px`)};
      return true;
    })()`);
  }

  async waitForTimeout(ms: number): Promise<void> {
    const wait = Number(ms);
    if (!Number.isFinite(wait) || wait <= 0) return;
    await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * Cypress 下拿不到 Playwright 的页面事件流（Cypress.automation 只暴露命令，
   * 不暴露 CDP 事件订阅）。这里保留注册表，让 agent 的 setupPageListeners 不炸；
   * dialog 由 `setDialogPreference` + 原生 dialog 自动处理兜底。
   */
  on(event: string, handler: (...args: any[]) => any): void {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
    if (event === 'dialog') this.dialogHandler = handler;
  }

  /** 供未来事件桥接使用；当前仅保证接口存在 */
  emit(event: string, ...args: any[]): void {
    for (const h of this.listeners.get(event) || []) {
      try { h(...args); } catch { /* 监听器异常不影响主流程 */ }
    }
  }

  setDialogPreference(accept: boolean, promptText?: string): void {
    this.dialogPreference = { accept, promptText };
  }

  // ── 键盘 / 鼠标（CDP Input 域） ────────────────────────────────────

  private async dispatchKey(type: string, key: string, modifiers: number): Promise<void> {
    const special = SPECIAL_KEYS[key];
    const isSingle = key.length === 1;
    const params: Record<string, unknown> = {
      type,
      modifiers,
      key: special ? special[0] : key,
      code: special ? special[1] : (isSingle ? `Key${key.toUpperCase()}` : key),
      windowsVirtualKeyCode: special ? special[2] : (isSingle ? key.toUpperCase().charCodeAt(0) : 0),
      nativeVirtualKeyCode: special ? special[2] : (isSingle ? key.toUpperCase().charCodeAt(0) : 0),
    };
    if (type === 'keyDown' && isSingle && modifiers === 0) params.text = key;
    await this.cdp.send('Input.dispatchKeyEvent', params);
  }

  private parseKeyCombo(combo: string): { key: string; modifiers: number } {
    const parts = String(combo || '').split('+').filter(Boolean);
    let modifiers = 0;
    while (parts.length > 1 && MODIFIER_BITS[parts[0]] !== undefined) {
      modifiers |= MODIFIER_BITS[parts.shift() as string];
    }
    return { key: parts.join('+'), modifiers };
  }

  private async topLevelPoint(x: number, y: number): Promise<{ x: number; y: number }> {
    const rect = await this.cdp.autRect().catch(() => null);
    return { x: x + (rect?.x || 0), y: y + (rect?.y || 0) };
  }

  readonly keyboard: AgentKeyboard = {
    press: async (combo: string, _options?: any) => {
      const { key, modifiers } = this.parseKeyCombo(combo);
      await this.dispatchKey('keyDown', key, modifiers);
      await this.dispatchKey('keyUp', key, modifiers);
    },
    type: async (text: string, _options?: any) => {
      // insertText 只走 composition 输入，不产生 keydown —— 对被测页等价于真实键入
      await this.cdp.send('Input.insertText', { text: String(text) });
    },
    down: async (key: string) => {
      const { key: k, modifiers } = this.parseKeyCombo(key);
      await this.dispatchKey('keyDown', k, modifiers);
    },
    up: async (key: string) => {
      const { key: k, modifiers } = this.parseKeyCombo(key);
      await this.dispatchKey('keyUp', k, modifiers);
    },
  };

  /** 最近一次鼠标坐标（AUT 视口坐标），供 down/up 复用 */
  private lastMouse = { x: 0, y: 0 };

  readonly mouse: AgentMouse;

  private createMouse(): AgentMouse {
    const moveTo = async (x: number, y: number) => {
      this.lastMouse = { x: Number(x) || 0, y: Number(y) || 0 };
      const p = await this.topLevelPoint(this.lastMouse.x, this.lastMouse.y);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    };
    const buttonAt = async (type: 'mousePressed' | 'mouseReleased', buttons: number, options?: any) => {
      const p = await this.topLevelPoint(this.lastMouse.x, this.lastMouse.y);
      await this.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: p.x,
        y: p.y,
        button: String(options?.button || 'left'),
        buttons,
        clickCount: Number(options?.clickCount || 1),
      });
    };
    return {
      click: async (x, y, options) => {
        await moveTo(x, y);
        const button = String(options?.button || 'left');
        const clickCount = Number(options?.clickCount || 1);
        const p = await this.topLevelPoint(x, y);
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: p.x, y: p.y, button, buttons: 1, clickCount,
        });
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 0, clickCount,
        });
      },
      move: moveTo,
      down: (options) => buttonAt('mousePressed', 1, options),
      up: (options) => buttonAt('mouseReleased', 0, options),
      wheel: async (deltaX, deltaY) => {
        const p = await this.topLevelPoint(this.lastMouse.x, this.lastMouse.y);
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: p.x,
          y: p.y,
          deltaX: Number(deltaX) || 0,
          deltaY: Number(deltaY) || 0,
        });
      },
    };
  }

  dispose(): void {
    this.listeners.clear();
    this.dialogHandler = null;
  }
}

export function createCyAgentPage(cdp: Cdp): CyAgentPage {
  return new CyAgentPage(cdp);
}
