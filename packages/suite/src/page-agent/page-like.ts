/**
 * page-like — Re-Act agent 依赖的「页面能力」契约（零 Node 依赖）
 *
 * 背景：`page-agent` 原本直接吃 Playwright `Page`，而 Cypress 侧没有 Playwright
 * Locator，也不允许在浏览器 bundle 里 import `@playwright/test`（会经
 * playwright-core → node:fs 拉爆 esbuild）。这里定义 agent 真正用到的那一层
 * 最小 API，两侧各给一个实现：
 *   - Playwright：`playwright-page.ts`（透传 + 截图归一化为 base64）
 *   - Cypress   ：`engine-cypress/agent-page.ts`（CDP + aria-ref）
 *
 * 约束：本模块只允许 `import type`。
 */

/** 元素截图/页面截图的统一返回：base64（不依赖 Node Buffer） */
export interface AgentScreenshot {
  base64: string;
}

export interface AgentBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentLocator {
  click(options?: any): Promise<void>;
  dblclick?(options?: any): Promise<void>;
  fill(value: string, options?: any): Promise<void>;
  hover(options?: any): Promise<void>;
  pressSequentially(text: string, options?: any): Promise<void>;
  evaluate(fn: any, arg?: any): Promise<any>;
  textContent(options?: any): Promise<string | null>;
  innerText(options?: any): Promise<string>;
  inputValue(options?: any): Promise<string>;
  isChecked(options?: any): Promise<boolean>;
  setChecked(checked: boolean, options?: any): Promise<void>;
  selectOption(values: any, options?: any): Promise<any>;
  waitFor(options?: any): Promise<void>;
  boundingBox(options?: any): Promise<AgentBoundingBox | null>;
  getAttribute(name: string, options?: any): Promise<string | null>;
  count(): Promise<number>;
  allInnerTexts(): Promise<string[]>;
  first(): AgentLocator;
  last(): AgentLocator;
  nth(index: number): AgentLocator;
  filter(options?: any): AgentLocator;
  locator(selector: string): AgentLocator;
  screenshot(options?: any): Promise<AgentScreenshot>;
  /** 可选：仅用于诊断，缺失时调用方需容忍 */
  isVisible?(options?: any): Promise<boolean>;
}

export interface AgentKeyboard {
  press(key: string, options?: any): Promise<void>;
  type(text: string, options?: any): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
}

export interface AgentMouse {
  click(x: number, y: number, options?: any): Promise<void>;
  move(x: number, y: number, options?: any): Promise<void>;
  down(options?: any): Promise<void>;
  up(options?: any): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

/** 页面事件：语义与 Playwright 同名事件对齐，Cypress 侧按能力尽力实现 */
export interface AgentDialog {
  type(): string;
  message(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export interface AgentPage {
  locator(selector: string): AgentLocator;
  getByText(text: string, options?: any): AgentLocator;
  getByRole(role: string, options?: any): AgentLocator;
  ariaSnapshot(options?: { mode?: string }): Promise<string>;
  /**
   * 当前 URL。
   *
   * Playwright 侧是同步取值；Cypress 侧必须经 CDP 异步读取，所以契约放宽为
   * 「同步或异步均可」，调用方一律 `await`。
   */
  url(): string | Promise<string>;
  title(): Promise<string>;
  goto(url: string, options?: any): Promise<void>;
  reload(options?: any): Promise<void>;
  evaluate(fn: any): Promise<any>;
  screenshot(options?: any): Promise<AgentScreenshot>;
  /** 同 url()：Playwright 同步，Cypress 异步，调用方一律 await */
  viewportSize(): { width: number; height: number } | null | Promise<{ width: number; height: number } | null>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  on(event: string, handler: (...args: any[]) => any): void;
  keyboard: AgentKeyboard;
  mouse: AgentMouse;
  /** 可选：原生 dialog 的预设处理偏好（Cypress 在页内接管 dialog 时需要） */
  setDialogPreference?(accept: boolean, promptText?: string): void;
  /** 可选：释放 Cypress 侧的轮询定时器等资源 */
  dispose?(): void;
}

/** 截图落盘：返回相对 taskDir 的路径（与 Playwright captureScreenshot 同形） */
export type AgentScreenshotSaver = (
  pngBase64: string,
  stepIndex: number,
  stepName: string,
) => Promise<string | undefined>;

/** 初始多模态上下文（goal-before / fn-after 截图） */
export type AgentInitialImageLoader = (paths: {
  goalScreenshotBefore?: string;
  fnAfterScreenshot?: string;
}) => Promise<any[]>;
