/**
 * engine-types — EngineAdapter 契约（零依赖，浏览器安全）
 *
 * 所有测试脚本通过 `engine.*` 调用操作，不直接使用 page.locator / cy.get。
 * 契约单独成文件的原因：Cypress 侧要在浏览器里 import 它，而
 * engineAdapter.ts 里躺着 PlaywrightEngine —— 只要 Cypress 入口碰到那个模块，
 * esbuild 就会把 playwright-core → node:fs 整条链拉进浏览器 bundle 而构建失败。
 *
 * 约束：本模块只允许 `import type`，不得引入任何运行时依赖。
 */

import type { ElementRef, ElementEntry, DefinedPage } from './definePage.js';
import type { ExpectScreenshotOptions, ShotDiffResult } from '../judge/screenshotDiff.js';

/** waitForResponse 选项：就绪门语义（软等待 = 超时不阻塞，与 waitForReady.api 一致） */
export interface WaitForResponseOptions {
  /** 等待超时（默认 15000ms） */
  timeout?: number;
  /** 匹配的 HTTP 方法（如 'POST'；不传则不限） */
  method?: string;
  /** 期望的 HTTP 状态码列表（如 [200]；不传则不限）。给定时不匹配则继续等 */
  status?: number[];
  /** 超时是否视为失败。默认 false（软等待：打日志继续），true 则抛错（硬门） */
  required?: boolean;
  /** 命中后额外等待，给前端渲染留时间（默认 0） */
  afterMs?: number;
}

/** waitForResponse 结果：命中的响应摘要；软等待超时时 hit=false */
export interface WaitForResponseResult {
  hit: boolean;
  url: string;
  status: number;
  /** 响应体（JSON 可解析时为对象，否则为文本；体过大或非文本为 null） */
  body: any;
  elapsedMs: number;
}

export interface EngineAdapter {
  /** 导航到 URL */
  navigate(url: string): Promise<void>;
  /** 打开 PageObject 页面入口：按 KEVE_ENV 解析四环境 URL 并填充 ${param} 占位（overrides 优先于 page.url.params） */
  openPage(page: DefinedPage, overrides?: Record<string, string>): Promise<void>;
  /** 调用其他场景（用例组合原语）：按 @keveScene 注册的 id 查找并执行其方法体，无需 spec 互相 import */
  callScene(sceneId: string, keveGoal?: unknown): Promise<void>;
  /** 等待页面就绪（API + UI 信号） */
  waitForReady(page: DefinedPage): Promise<void>;
  /** 等待指定响应（就绪门，平台 WAIT_RESPONSE 转译落地用）。
   *  配置型场景没有 DefinedPage，只能按 URL 片段/正则等待 —— 语义与 waitForReady.api 一致 */
  waitForResponse(urlPart: string | RegExp, opts?: WaitForResponseOptions): Promise<WaitForResponseResult>;
  /** 点击元素 */
  click(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 双击元素（平台 DB_CLICK_ELEMENT） */
  dblClick(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 强制点击元素（平台 FORCE_CLICK_ELEMENT，跳过 actionability 检查） */
  forceClick(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 输入文本 */
  type(text: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 清空输入内容（平台 CLEAN） */
  clear(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 悬停元素 */
  hover(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 拖拽元素到目标（平台 DRAGGING：source 拖到 target） */
  drag(source: ElementRef | ElementEntry, target: ElementRef | ElementEntry): Promise<void>;
  /** 滚动使元素进入视口（平台 SCROLL） */
  scroll(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 等待指定毫秒（平台 WAIT_EVENTS） */
  wait(ms: number): Promise<void>;
  /** 等待元素就绪（平台元素门的真检测：按 selector 等 visible/hidden，超时返回 found=false 不抛错；
   *  替代「固定延时兜底」——只有元素真的就绪才算就绪，防丢响应/防假就绪） */
  waitForElement(selector: string, opts?: { timeout?: number; visible?: boolean }): Promise<{ found: boolean }>;
  /** 刷新页面（平台 REFRESH_PAGE） */
  refresh(): Promise<void>;
  /** 在页面上下文执行 JS 表达式（平台 WRITE_GLOBAL 的 javascript hop） */
  evaluate(expression: string): Promise<any>;
  /** 截图并附加到测试报告（平台 SCREEN_SHOT_COMPARE）。⚠ 语义已升级为基线对比断言：
   *  无基线 → 自动建候选基线（pass）；差异率超阈值 → 抛 ScreenshotDiffError（确定性 fail）；
   *  对比结果（差异率/区块/证据图路径）进 keveGoalResult attachment（screenshotDiff 字段） */
  screenshot(name: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 截图基线对比断言（expectScreenshot 的显式形态，支持阈值/掩码/全页选项） */
  expectScreenshot(key: string, opts?: ExpectScreenshotOptions, ...refs: (ElementRef | ElementEntry)[]): Promise<ShotDiffResult>;
  /** 获取元素文本 */
  text(...refs: (ElementRef | ElementEntry)[]): Promise<string>;
  /** 断言：元素可见 */
  expectVisible(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素不可见 */
  expectHidden(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素文本包含 */
  expectText(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素文本不包含（平台 TEXT_NOT_EXIST） */
  expectNotText(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素文本等于（平台 TEXT_EQUAL / EXPECTED_VALUE ctype=text cexpression=eq） */
  expectTextEquals(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素文本不等于（平台 EXPECTED_VALUE ctype=text cexpression=not.eq） */
  expectTextNotEquals(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素数量 */
  expectCount(count: number, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素集合中「文本非空」的个数（平台 EXPECTED_VALUE ctype=index，历史语义为计数） */
  expectNonEmptyCount(count: number, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素存在 */
  expectExists(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素不存在 */
  expectNotExists(...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素包含指定 class */
  expectClass(className: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素不包含指定 class（平台 EXPECTED_VALUE ctype=class cexpression=not.include） */
  expectNotClass(className: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素属性值 */
  expectAttribute(attr: string, value: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：元素属性值包含（平台 EXPECTED_VALUE ctype=style cexpression=include） */
  expectAttributeContains(attr: string, value: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void>;
  /** 断言：当前 URL 包含指定片段（平台 EXPECTED__PAGET_VALUE ctype=url） */
  expectUrlContains(part: string): Promise<void>;
  /** 断言：当前 URL 不包含指定片段 */
  expectUrlNotContains(part: string): Promise<void>;
  /** 断言：当前 URL 等于（平台 EXPECTED__PAGET_VALUE ctype=url cexpression=eq） */
  expectUrlEquals(url: string): Promise<void>;
  /** 断言：当前 URL 不等于 */
  expectUrlNotEquals(url: string): Promise<void>;
  /** 断言：页面标题包含（平台 EXPECTED__PAGET_VALUE ctype=title cexpression=include） */
  expectTitle(part: string): Promise<void>;
  /** 断言：页面标题等于 */
  expectTitleEquals(title: string): Promise<void>;
  /** 获取底层引擎 page（仅探索场景使用；Cypress 下返回 CDP driver，无 Playwright Page） */
  rawPage(): any;
  /** aria snapshot（AI 探索用） */
  ariaSnapshot(options?: { mode?: string }): Promise<string>;
  /** 注入 cookies 到当前浏览器上下文（登录态透传） */
  injectCookies(cookies: any[]): Promise<void>;
}

/** 当前执行环境（调度层 KEVE_ENV 注入；与 keve-wiki test-data.ts 同源同序） */
export const KEVE_ENV: string = (['online', 'pre', 'rc', 'test'].includes(process.env.KEVE_ENV || '') ? process.env.KEVE_ENV : 'test') as string;

/**
 * 解析 PageObject 入口 URL：KEVE_ENV 环境值 → ${param} 占位填充（overrides 优先于默认 params）
 * 环境值非法（非 http，如平台脏数据 "1"）时回退 test → online → 任意 http 值
 */
export function resolvePageUrl(page: DefinedPage, overrides?: Record<string, string>): string {
  const u: any = page.url;
  if (!u) throw new Error(`openPage: 页面 ${page.__pageId} 未定义 url 入口`);
  const candidates = [u[String(KEVE_ENV)], u.test, u.online, ...Object.values(u)].filter(
    (v: any) => typeof v === 'string' && /^https?:\/\//.test(v)
  );
  let url = String(candidates[0] || '');
  if (!url) throw new Error(`openPage: 页面 ${page.__pageId} 的 url 无有效 http 值: ${JSON.stringify(u)}`);
  const params: Record<string, string> = { ...(u.params || {}), ...(overrides || {}) };
  for (const [k, v] of Object.entries(params)) {
    url = url.split('${' + k + '}').join(encodeURIComponent(String(v)));
  }
  return url.replace(/\$\{\w+\}/g, ''); // 未覆盖的占位符清空（保底不把 ${x} 发给服务端）
}
