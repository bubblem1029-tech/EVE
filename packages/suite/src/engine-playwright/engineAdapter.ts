/**
 * engineAdapter — 引擎无关操作接口 + Playwright 实现
 *
 * 所有测试脚本通过 engine.* 调用操作，不直接使用 page.locator / page.click。
 * 未来可替换为其他引擎实现（如 WebDriver）。
 */

import type { Locator, Page } from '@playwright/test';
import { expect as pwExpect } from '@playwright/test';
import { resolveElement, resolveChain } from '../core/page-object/elementResolver.js';
import {
  compareWithBaseline,
  beginGoalShotDiffCapture, drainGoalShotDiff, isGoalShotDiffCaptureActive,
  type ExpectScreenshotOptions, type ShotDiffResult,
} from '../core/judge/screenshotDiff.js';
import type { ElementRef, ElementEntry, DefinedPage } from '../core/page-object/definePage.js';
import { isElementFactory } from '../core/page-object/definePage.js';
import type { EngineAdapter, WaitForResponseOptions, WaitForResponseResult } from '../core/page-object/engine-types.js';
import { resolvePageUrl } from '../core/page-object/engine-types.js';

// ─── EngineAdapter Interface ──────────────────────────────────────────
//
// 契约本体在 ../core/page-object/engine-types.js（零依赖、浏览器安全）——
// Cypress 侧要 import 它，绕不开本文件里的 PlaywrightEngine。
// 这里只做转出。

export type { EngineAdapter, WaitForResponseOptions, WaitForResponseResult } from '../core/page-object/engine-types.js';
export { KEVE_ENV, resolvePageUrl } from '../core/page-object/engine-types.js';

// ─── Playwright Engine Implementation ─────────────────────────────────

export class PlaywrightEngine implements EngineAdapter {
  constructor(private page: Page) {}

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async openPage(page: DefinedPage, overrides?: Record<string, string>): Promise<void> {
    await this.navigate(resolvePageUrl(page, overrides));
  }

  async callScene(sceneId: string, keveGoal?: unknown): Promise<void> {
    const { sceneImplMap } = await import('../core/decorator/keve-registry.js');
    const fn = sceneImplMap.get(String(sceneId));
    if (!fn) {
      throw new Error(`callScene: 场景 '${sceneId}' 未注册（可能被排除或不存在）`);
    }
    await (fn as any)({ engine: this, keveGoal });
  }

  async waitForReady(defPage: DefinedPage): Promise<void> {
    const { waitForReady } = defPage;
    if (!waitForReady) return;

    // 等待 API
    if (waitForReady.api) {
      await this.page.waitForResponse(
        (resp) => resp.url().includes(waitForReady.api!),
        { timeout: 15000 }
      ).catch(() => {
        // API 等待失败不阻塞，继续等 UI
      });
    }

    // 等待 UI 元素
    if (waitForReady.ui) {
      const entry = defPage.elements[waitForReady.ui];
      if (entry && !isElementFactory(entry)) {
        const locator = resolveElement(this.page, entry as ElementRef);
        await locator.waitFor({ state: 'visible', timeout: 10000 });
      }
    }
  }

  /**
   * 等待指定响应 —— 配置型视觉对比场景的「就绪门」。
   *
   * 与 waitForReady.api 的差异：不需要 DefinedPage（配置型场景没有页面对象），
   * 并且能拿到响应体做渲染健康断言（老平台 interceptUrl 的 statuses 语义）。
   * 默认**软等待**（超时不阻塞，与老平台 cy.wait 后继续的容错一致），required=true 时硬失败。
   */
  async waitForResponse(urlPart: string | RegExp, opts: WaitForResponseOptions = {}): Promise<WaitForResponseResult> {
    const timeout = opts.timeout ?? 15000;
    const started = Date.now();
    const miss: WaitForResponseResult = { hit: false, url: '', status: 0, body: null, elapsedMs: 0 };
    try {
      const resp = await this.page.waitForResponse((r) => {
        const urlOk = typeof urlPart === 'string' ? r.url().includes(urlPart) : urlPart.test(r.url());
        if (!urlOk) return false;
        if (opts.method && r.request().method().toUpperCase() !== opts.method.toUpperCase()) return false;
        if (opts.status?.length && !opts.status.includes(r.status())) return false;
        return true;
      }, { timeout });

      let body: any = null;
      try {
        const text = await resp.text();
        if (text && text.length <= 2_000_000) {
          try { body = JSON.parse(text); } catch { body = text; }
        }
      } catch { /* 响应体不可读（重定向/流）不影响就绪判定 */ }

      if (opts.afterMs && opts.afterMs > 0) await this.page.waitForTimeout(opts.afterMs);
      return { hit: true, url: resp.url(), status: resp.status(), body, elapsedMs: Date.now() - started };
    } catch (err: any) {
      if (opts.required) {
        throw new Error(`waitForResponse 超时（${timeout}ms）：未等到匹配「${String(urlPart)}」的响应 —— ${err?.message || err}`);
      }
      console.warn(`[engine.waitForResponse] 软等待超时（${timeout}ms），继续执行：${String(urlPart)}`);
      return { ...miss, elapsedMs: Date.now() - started };
    }
  }

  private resolve(refs: (ElementRef | ElementEntry)[]): Locator {
    // 规范化：工厂函数需要已调用，这里不做工厂调用
    const normalized = refs.map((r) => {
      if (isElementFactory(r)) {
        throw new Error('Factory function must be called before passing to engine. e.g. engine.click(page.elements.itemByName("时间"))');
      }
      return r as ElementRef;
    });
    return resolveChain(this.page, ...normalized);
  }

  async click(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await locator.first().click();
  }

  async dblClick(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await locator.first().dblclick();
  }

  async forceClick(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await locator.first().click({ force: true });
  }

  async clear(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await locator.first().fill('');
  }

  async drag(source: ElementRef | ElementEntry, target: ElementRef | ElementEntry): Promise<void> {
    const src = this.resolve([source]).first();
    const dst = this.resolve([target]).first();
    await src.dragTo(dst);
  }

  async scroll(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    if (refs.length === 0) {
      await this.page.mouse.wheel(0, 600);
      return;
    }
    const locator = this.resolve(refs);
    await locator.first().scrollIntoViewIfNeeded();
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(Math.max(0, Number(ms) || 0));
  }

  async waitForElement(selector: string, opts: { timeout?: number; visible?: boolean } = {}): Promise<{ found: boolean }> {
    const timeout = opts.timeout ?? 10000;
    const state = opts.visible === false ? 'hidden' : 'visible';
    try {
      await this.page.locator(selector).first().waitFor({ state, timeout });
      return { found: true };
    } catch {
      return { found: false };
    }
  }

  async refresh(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
  }

  async evaluate(expression: string): Promise<any> {
    // 平台 WRITE_GLOBAL 的 javascript hop 是表达式形态（如 'UI自动化看板'+new Date().getTime()）
    return await this.page.evaluate(`(() => (${expression}))()`);
  }

  async screenshot(name: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    await this.expectScreenshot(name, {}, ...refs);
  }

  async expectScreenshot(key: string, opts: ExpectScreenshotOptions = {}, ...refs: (ElementRef | ElementEntry)[]): Promise<ShotDiffResult> {
    const { test: pwTest } = await import('@playwright/test');
    // keveGoal 未开缓冲时（如探索/调试直调），就地开一个临时缓冲，保证结果也能入 attachment
    const owned = !isGoalShotDiffCaptureActive();
    if (owned) beginGoalShotDiffCapture();
    try {
      const buf = refs.length > 0
        ? await this.resolve(refs).first().screenshot()
        : await this.page.screenshot({ fullPage: !!opts.fullPage });
      // 统一走 compareWithBaseline：其内部按 key+env 判定
      //  - 精确视口无基线、同 key 也无其它视口基线 → 建候选基线（status=baseline_required，不算通过）
      //  - 同 key 有其它视口基线 → size_mismatch（尺寸变化不自举，杜绝掩盖变化）
      //  - 候选基线未审核 → baseline_required（不比对不判通过）
      //  - active 基线 → 像素比对（matched / exceeded，超阈值抛 ScreenshotDiffError）
      const result = compareWithBaseline(key, buf, { threshold: opts.threshold, mask: opts.mask });
      // 记录已下沉至 screenshotDiff 模块（成功路径 + 抛错路径均自动记录）
      // 原始截图仍挂附件（证据双保险：报告附件 + test-artifacts 路径）；
      // 测试上下文外（独立验证脚本）test.info() 会抛错 —— 对比功能不受影响，仅跳过附件
      try {
        await pwTest.info()?.attach(`screenshot-${key}`, { body: buf, contentType: 'image/png' });
      } catch { /* 非测试上下文：跳过附件 */ }
      return result;
    } finally {
      if (owned) drainGoalShotDiff();
    }
  }

  async type(text: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await locator.first().fill(text);
  }

  async hover(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await locator.first().hover();
  }

  async text(...refs: (ElementRef | ElementEntry)[]): Promise<string> {
    const locator = this.resolve(refs);
    return await locator.first().textContent() ?? '';
  }

  async expectVisible(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).toBeVisible();
  }

  async expectHidden(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).toBeHidden();
  }

  async expectText(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).toContainText(expected);
  }

  async expectNotText(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).not.toContainText(expected);
  }

  async expectTextEquals(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).toHaveText(expected);
  }

  async expectTextNotEquals(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).not.toHaveText(expected);
  }

  async expectCount(count: number, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator).toHaveCount(count);
  }

  async expectNonEmptyCount(count: number, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    // 历史语义（老平台 EXPECTED_VALUE ctype=index）：匹配到的元素里，
    // 文本非空的有几个。空文本元素不计入 —— 直接 toHaveCount 会把占位节点也算进去。
    await pwExpect
      .poll(async () => {
        const texts = await locator.allTextContents();
        return texts.filter((t) => String(t).trim().length > 0).length;
      })
      .toBe(count);
  }

  async expectExists(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).toBeAttached();
  }

  async expectNotExists(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator).toHaveCount(0);
  }

  async expectClass(className: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    // 检查元素 class 属性包含指定 class
    const classAttr = await locator.first().getAttribute('class') ?? '';
    if (!classAttr.split(/\s+/).includes(className)) {
      throw new Error(`Element does not have class '${className}'. Actual classes: '${classAttr}'`);
    }
  }

  async expectNotClass(className: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    const classAttr = await locator.first().getAttribute('class') ?? '';
    if (classAttr.split(/\s+/).includes(className)) {
      throw new Error(`Element should not have class '${className}'. Actual classes: '${classAttr}'`);
    }
  }

  async expectAttribute(attr: string, value: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    await pwExpect(locator.first()).toHaveAttribute(attr, value);
  }

  async expectAttributeContains(attr: string, value: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const locator = this.resolve(refs);
    const actual = await locator.first().getAttribute(attr);
    if (actual === null || !actual.includes(value)) {
      throw new Error(`Element attribute '${attr}' should contain '${value}'. Actual: ${JSON.stringify(actual)}`);
    }
  }

  async expectUrlContains(part: string): Promise<void> {
    await pwExpect(this.page).toHaveURL(new RegExp(escapeRegExp(part)));
  }

  async expectUrlNotContains(part: string): Promise<void> {
    const url = this.page.url();
    if (url.includes(part)) {
      throw new Error(`URL '${url}' should not contain '${part}'`);
    }
  }

  async expectUrlEquals(url: string): Promise<void> {
    await pwExpect(this.page).toHaveURL(url);
  }

  async expectUrlNotEquals(url: string): Promise<void> {
    const actual = this.page.url();
    if (actual === url) {
      throw new Error(`URL should not equal '${url}'`);
    }
  }

  async expectTitle(part: string): Promise<void> {
    await pwExpect(this.page).toHaveTitle(new RegExp(escapeRegExp(part)));
  }

  async expectTitleEquals(title: string): Promise<void> {
    await pwExpect(this.page).toHaveTitle(title);
  }

  rawPage(): Page {
    return this.page;
  }

  async ariaSnapshot(options?: { mode?: string }): Promise<string> {
    // 使用 Playwright 的 aria snapshot (--yarn/1.49+)
    // 回退到 page.locator('body').innerText() 作为简化快照
    try {
      const snapshot = await this.page.locator('body').ariaSnapshot();
      return snapshot ?? '';
    } catch {
      // 旧版 Playwright 回退
      return await this.page.locator('body').innerText();
    }
  }

  async injectCookies(cookies: any[]): Promise<void> {
    const context = this.page.context();
    await context.addCookies(cookies);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

/** RegExp 元字符转义（expectUrlContains 用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 Playwright page 创建 engine 实例
 */
export function createEngine(page: Page): EngineAdapter {
  return new PlaywrightEngine(page);
}
