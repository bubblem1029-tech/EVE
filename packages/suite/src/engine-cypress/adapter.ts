/**
 * adapter — Cypress 版 EngineAdapter
 *
 * 与 PlaywrightEngine 逐方法对齐语义（唯一差异见各方法注释）。定位与操作都通过
 * CDP 在 AUT 的 isolated world 内执行，Node 侧能力（截图对比、落盘）经 HTTP 桥。
 *
 * 本模块**不得** import '@playwright/test'（含 core/engineAdapter.js、elementResolver.js
 * 这类会传递依赖 playwright-core 的模块）：playwright-core → node:fs 会把整条链
 * 拉进浏览器 bundle，esbuild 直接失败。类型只允许 `import type`。
 */

import type { ElementRef, ElementEntry, DefinedPage } from '../core/page-object/definePage.js';
import { isElementFactory } from '../core/page-object/definePage.js';
import type { EngineAdapter, WaitForResponseOptions, WaitForResponseResult } from '../core/page-object/engine-types.js';
import { resolvePageUrl, KEVE_ENV } from '../core/page-object/engine-types.js';
import type { ExpectScreenshotOptions } from '../core/judge/screenshotDiff.js';
import type { Cdp } from './cdp.js';
import { pollUntil } from './cdp.js';
import {
  beginGoalShotDiffCapture, drainGoalShotDiff, isGoalShotDiffCaptureActive,
  recordShotDiff, CypressScreenshotDiffError, type CyShotDiffResult,
} from './shotBuffer.js';

/** 浏览器 → Node 的调用封装（端口来自 config.env.KEVE_BRIDGE_PORT） */
export interface Bridge {
  post(route: string, payload?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<any>;
}

export function createBridge(): Bridge {
  const port = (globalThis as any).Cypress?.env?.('KEVE_BRIDGE_PORT');
  if (!port) throw new Error('[cypress-engine] KEVE_BRIDGE_PORT 未注入：请确认 cypress.config 使用了 @kkeve/suite/engine-cypress 的 setupKeveBridge');
  const base = `http://127.0.0.1:${port}`;
  return {
    async post(route, payload = {}, opts = {}) {
      const res = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // 透传中止信号：goal 超时后必须能中断本次桥调用，否则浏览器侧会一直
        // 等一个已经在 Agent 层判定为超时的响应。
        signal: opts.signal,
      });
      return await res.json();
    },
  };
}

/** refs 规范化：工厂函数必须先调用（与 PlaywrightEngine.resolve 一致） */
function normalizeRefs(refs: (ElementRef | ElementEntry)[]): ElementRef[] {
  return refs.map((r) => {
    if (isElementFactory(r)) {
      throw new Error('Factory function must be called before passing to engine. e.g. engine.click(page.elements.itemByName("时间"))');
    }
    return r as ElementRef;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class CypressEngine implements EngineAdapter {
  constructor(private cdp: Cdp, private bridge: Bridge) {}

  // ── AUT 上下文准备 ────────────────────────────────────────────────

  /**
   * 每次调用前确保：AUT 存在 + isolated world 有效 + 定位器/操作原语已注入。
   * 导航会销毁注入，所以这里每次校验 `__keveOpsSource` 版本号（幂等且极廉价）。
   */
  private async ensureReady(): Promise<void> {
    const has = await this.cdp.evaluateInAut<boolean>(
      'Boolean(window.__keveOpsSource === "v1" && window.__keveNetLogSource === "v1" && window.__keveLocatorSource === "v1")',
    ).catch(() => false);
    if (has) return;
    const { locatorSource } = await import('../dsl/locatorSource.js');
    const { bootstrapSource } = await import('./pageOps.js');
    await this.cdp.evaluateInAut(bootstrapSource(locatorSource()));
  }

  private async ops<T = any>(expr: string): Promise<T> {
    await this.ensureReady();
    return await this.cdp.evaluateInAut<T>(expr);
  }

  private async opsCall<T = any>(fn: string, ...args: unknown[]): Promise<T> {
    const encoded = args.map((a) => JSON.stringify(a ?? null)).join(',');
    return await this.ops<T>(`window.__keveOps.${fn}(${encoded})`);
  }

  /** 定位失败时给出可读错误（Playwright 是等元素超时，这里是立即失败） */
  private async withWait<T>(fn: () => Promise<T>, timeout = 10000, interval = 150): Promise<T> {
    const deadline = Date.now() + timeout;
    let lastErr: any;
    for (;;) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || err);
        // 只有「元素未找到 / 断言暂不成立」值得重试；代码错误直接抛
        const retryable = /元素未找到|not found|no-match|index-out-of-range|断言|expected|should|BUT/.test(msg);
        if (!retryable || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, interval));
      }
    }
  }

  // ── 导航 ─────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    if (!/^https?:\/\//.test(String(url || ''))) {
      throw new Error(`navigate: URL 非法（必须是 http/https）: ${JSON.stringify(url)}`);
    }
    await this.cdp.goto(url);
  }

  async openPage(page: DefinedPage, overrides?: Record<string, string>): Promise<void> {
    await this.navigate(resolvePageUrl(page, overrides));
  }

  async callScene(sceneId: string, keveGoal?: unknown): Promise<void> {
    const { sceneImplMap } = await import('../core/decorator/keve-registry.js');
    const fn = sceneImplMap.get(String(sceneId));
    if (!fn) throw new Error(`callScene: 场景 '${sceneId}' 未注册（可能被排除或不存在）`);
    await (fn as any)({ engine: this, keveGoal });
  }

  async waitForReady(defPage: DefinedPage): Promise<void> {
    const cfg = defPage.waitForReady;
    if (!cfg) return;
    if (cfg.api) {
      // 软等待：与本文件 waitForResponse 默认语义一致
      await this.waitForResponse(cfg.api, { timeout: 15000 });
    }
    if (cfg.ui) {
      const entry = defPage.elements?.[cfg.ui];
      if (entry && !isElementFactory(entry)) {
        await this.withWait(() => this.expectVisible(entry as ElementRef), 10000);
      }
    }
  }

  /**
   * 等到匹配的响应。
   * 与 Playwright 的差异：不能「先挂监听再等」——注入早于导航，只能查已有记录；
   * 因此语义是「从本 goal 开始起的时间窗内出现该响应」。软等待（默认）超时不失败。
   */
  async waitForResponse(urlPart: string | RegExp, opts: WaitForResponseOptions = {}): Promise<WaitForResponseResult> {
    const timeout = opts.timeout ?? 15000;
    const started = Date.now();
    const probe = async (): Promise<WaitForResponseResult | undefined> => {
      const entry = await this.ops<{ url: string; method: string; status: number; at: number } | null>(
        `(() => {
          var log = window.__keveNetLog || [];
          var part = ${JSON.stringify(typeof urlPart === 'string' ? urlPart : urlPart.source)};
          var isRe = ${typeof urlPart === 'string' ? 'false' : 'true'};
          var method = ${JSON.stringify(opts.method || '')};
          var statuses = ${JSON.stringify(opts.status || [])};
          for (var i = log.length - 1; i >= 0; i -= 1) {
            var e = log[i];
            var hit = isRe ? new RegExp(part).test(String(e.url || '')) : String(e.url || '').indexOf(part) >= 0;
            if (!hit) continue;
            if (method && String(e.method || '').toUpperCase() !== method.toUpperCase()) continue;
            if (statuses.length && statuses.indexOf(e.status) < 0) continue;
            return e;
          }
          return null;
        })()`,
      );
      if (!entry) return undefined;
      return { hit: true, url: entry.url, status: entry.status, body: null, elapsedMs: Date.now() - started };
    };
    try {
      const hit = await pollUntil(probe, timeout, 150);
      if (hit) {
        if (opts.afterMs && opts.afterMs > 0) await this.wait(opts.afterMs);
        return hit;
      }
      throw new Error(`waitForResponse 超时（${timeout}ms）`);
    } catch (err: any) {
      if (opts.required) {
        throw new Error(`waitForResponse 超时（${timeout}ms）：未等到匹配「${String(urlPart)}」的响应`);
      }
      console.warn(`[engine.waitForResponse] 软等待超时（${timeout}ms），继续执行：${String(urlPart)}`);
      return { hit: false, url: '', status: 0, body: null, elapsedMs: Date.now() - started };
    }
  }

  // ── 交互 ─────────────────────────────────────────────────────────

  async click(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(() => this.opsCall('click', r, false));
  }

  async dblClick(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(() => this.opsCall('click', r, true));
  }

  /** 强制点击：CDP 下没有 actionability 检查，语义等同于 click */
  async forceClick(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    await this.click(...refs);
  }

  async type(text: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(() => this.opsCall('type', r, String(text ?? '')));
  }

  async clear(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(() => this.opsCall('clear', r));
  }

  async hover(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(() => this.opsCall('hover', r));
  }

  async drag(source: ElementRef | ElementEntry, target: ElementRef | ElementEntry): Promise<void> {
    const s = normalizeRefs([source]);
    const t = normalizeRefs([target]);
    await this.withWait(() => this.opsCall('drag', s, t));
  }

  async scroll(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    if (refs.length === 0) {
      await this.opsCall('scrollPage', 600);
      return;
    }
    const r = normalizeRefs(refs);
    await this.withWait(() => this.opsCall('scrollIntoView', r));
  }

  async wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
  }

  async waitForElement(selector: string, opts: { timeout?: number; visible?: boolean } = {}): Promise<{ found: boolean }> {
    const timeout = opts.timeout ?? 10000;
    const found = await pollUntil(async () => {
      const ok = await this.ops<boolean>(`window.__keveOps.waitSelector(${JSON.stringify(selector)}, ${opts.visible === false ? 'false' : 'true'})`);
      return ok ? true : undefined;
    }, timeout, 150);
    return { found: !!found };
  }

  async refresh(): Promise<void> {
    await this.cdp.reload();
  }

  async evaluate(expression: string): Promise<any> {
    return await this.ops(`window.__keveOps.evaluate(${JSON.stringify(expression)})`);
  }

  // ── 截图 / 视觉对比 ──────────────────────────────────────────────

  async screenshot(name: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    await this.expectScreenshot(name, {}, ...refs);
  }

  /**
   * 截图对比：Node 侧能力，走桥。
   * 元素级截图（refs 非空）暂按整页截图处理 —— Cypress/CDP 无法取元素级 clip 的
   * 高保真结果（滚动容器与 transform 会错位）；调用方若有元素级需求需显式记录。
   */
  async expectScreenshot(key: string, opts: ExpectScreenshotOptions = {}, ...refs: (ElementRef | ElementEntry)[]): Promise<CyShotDiffResult> {
    if (refs.length > 0) {
      console.warn(`[engine.expectScreenshot] Cypress 下元素级截图按整页处理：${key}`);
    }
    const owned = !isGoalShotDiffCaptureActive();
    if (owned) beginGoalShotDiffCapture();
    try {
      const pngBase64 = await this.cdp.screenshot();
      const resp = await this.bridge.post('/shot/compare', {
        key,
        pngBase64,
        threshold: opts.threshold,
        mask: opts.mask,
      });
      if (!resp?.ok) {
        if (resp?.code === 'SHOT_DIFF_EXCEEDED') {
          recordShotDiff(resp.shotDiff);
          throw new CypressScreenshotDiffError(resp.shotDiff);
        }
        throw new Error(resp?.error || `截图对比失败：${key}`);
      }
      recordShotDiff(resp.result);
      return resp.result;
    } finally {
      if (owned) drainGoalShotDiff();
    }
  }

  // ── 读取 ─────────────────────────────────────────────────────────

  async text(...refs: (ElementRef | ElementEntry)[]): Promise<string> {
    const r = normalizeRefs(refs);
    return await this.withWait(() => this.opsCall<string>('text', r));
  }

  // ── 断言 ─────────────────────────────────────────────────────────

  async expectVisible(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const ok = await this.opsCall<boolean>('visible', r);
      if (!ok) throw new Error(`断言失败：元素应可见，实际不可见 —— ${JSON.stringify(r).slice(0, 200)}`);
    });
  }

  async expectHidden(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const ok = await this.opsCall<boolean>('hidden', r);
      if (!ok) throw new Error(`断言失败：元素应隐藏，实际可见 —— ${JSON.stringify(r).slice(0, 200)}`);
    });
  }

  async expectText(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<string>('text', r);
      if (!actual.includes(expected)) {
        throw new Error(`断言失败：元素文本应包含「${expected}」，实际显示「${actual}」而非预期`);
      }
    });
  }

  async expectNotText(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<string>('text', r);
      if (actual.includes(expected)) {
        throw new Error(`断言失败：元素文本不应包含「${expected}」，实际为「${actual}」`);
      }
    });
  }

  async expectTextEquals(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<string>('text', r);
      if (actual !== String(expected).replace(/\s+/g, ' ').trim()) {
        throw new Error(`断言失败：元素文本应等于「${expected}」，实际显示「${actual}」而非预期`);
      }
    });
  }

  async expectTextNotEquals(expected: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<string>('text', r);
      if (actual === String(expected).replace(/\s+/g, ' ').trim()) {
        throw new Error(`断言失败：元素文本不应等于「${expected}」，实际为「${actual}」`);
      }
    });
  }

  async expectCount(count: number, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<number>('count', r);
      if (actual !== Number(count)) {
        throw new Error(`断言失败：元素数量应为 ${count}，实际为 ${actual}`);
      }
    });
  }

  async expectNonEmptyCount(count: number, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<number>('countNonEmpty', r);
      if (actual !== Number(count)) {
        throw new Error(`断言失败：文本非空元素数量应为 ${count}，实际为 ${actual}`);
      }
    });
  }

  async expectExists(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const ok = await this.opsCall<boolean>('exists', r);
      if (!ok) throw new Error(`断言失败：元素应存在，实际不存在 —— ${JSON.stringify(r).slice(0, 200)}`);
    });
  }

  async expectNotExists(...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const ok = await this.opsCall<boolean>('exists', r);
      if (ok) throw new Error(`断言失败：元素不应存在 —— ${JSON.stringify(r).slice(0, 200)}`);
    });
  }

  async expectClass(className: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    const classes = await this.withWait(() => this.opsCall<string>('classes', r));
    if (!classes.split(/\s+/).includes(className)) {
      throw new Error(`断言失败：元素应包含 class '${className}'，实际为 '${classes}'`);
    }
  }

  async expectNotClass(className: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    const classes = await this.withWait(() => this.opsCall<string>('classes', r));
    if (classes.split(/\s+/).includes(className)) {
      throw new Error(`断言失败：元素不应包含 class '${className}'，实际为 '${classes}'`);
    }
  }

  async expectAttribute(attr: string, value: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<string | null>('attr', r, attr);
      if (actual !== value) {
        throw new Error(`断言失败：属性 '${attr}' 应等于 '${value}'，实际为 ${JSON.stringify(actual)}`);
      }
    });
  }

  async expectAttributeContains(attr: string, value: string, ...refs: (ElementRef | ElementEntry)[]): Promise<void> {
    const r = normalizeRefs(refs);
    await this.withWait(async () => {
      const actual = await this.opsCall<string | null>('attr', r, attr);
      if (actual === null || !actual.includes(value)) {
        throw new Error(`断言失败：属性 '${attr}' 应包含 '${value}'，实际为 ${JSON.stringify(actual)}`);
      }
    });
  }

  async expectUrlContains(part: string): Promise<void> {
    await this.withWait(async () => {
      const url = await this.opsCall<string>('url');
      if (!url.includes(part)) throw new Error(`断言失败：URL 应包含 '${part}'，实际为 '${url}'`);
    });
  }

  async expectUrlNotContains(part: string): Promise<void> {
    const url = await this.opsCall<string>('url');
    if (url.includes(part)) throw new Error(`断言失败：URL 不应包含 '${part}'，实际为 '${url}'`);
  }

  async expectUrlEquals(url: string): Promise<void> {
    await this.withWait(async () => {
      const actual = await this.opsCall<string>('url');
      if (actual !== url) throw new Error(`断言失败：URL 应等于 '${url}'，实际为 '${actual}'`);
    });
  }

  async expectUrlNotEquals(url: string): Promise<void> {
    const actual = await this.opsCall<string>('url');
    if (actual === url) throw new Error(`断言失败：URL 不应等于 '${url}'`);
  }

  async expectTitle(part: string): Promise<void> {
    await this.withWait(async () => {
      const title = await this.opsCall<string>('title');
      if (!title.includes(part)) throw new Error(`断言失败：标题应包含 '${part}'，实际为 '${title}'`);
    });
  }

  async expectTitleEquals(title: string): Promise<void> {
    await this.withWait(async () => {
      const actual = await this.opsCall<string>('title');
      if (actual !== title) throw new Error(`断言失败：标题应等于 '${title}'，实际为 '${actual}'`);
    });
  }

  // ── 探索辅助 ─────────────────────────────────────────────────────

  /** Cypress 下没有 Playwright Page，返回 CDP 驱动（供探索层调用） */
  rawPage(): any {
    return this.cdp;
  }

  /** 当前 AUT URL（keveGoal 记录诊断上下文用；context 失效时回退 frame.url） */
  async currentUrl(): Promise<string> {
    return await this.cdp.currentUrl();
  }

  /**
   * 截图并落盘到 taskDir/test-artifacts/round-N/screenshots，返回相对 taskDir 的路径。
   * 与 Playwright 侧 captureScreenshot 的产物路径同形，报告可直接消费。
   */
  async captureArtifact(name: string): Promise<string> {
    const pngBase64 = await this.cdp.screenshot();
    const resp = await this.bridge.post('/shot/save', { name, pngBase64 });
    if (!resp?.ok) throw new Error(resp?.error || '截图落盘失败');
    return String(resp.path || '');
  }

  async ariaSnapshot(_options?: { mode?: string }): Promise<string> {
    // 仅取 AUT 的 AX 树（主会话默认调用拿到的是 Cypress runner UI）
    const nodes = await this.cdp.axTree();
    const lines: string[] = [];
    for (const node of nodes) {
      if (!node?.role?.value) continue;
      if (node.ignored) continue;
      const name = node.name?.value ? ` "${String(node.name.value).slice(0, 120)}"` : '';
      lines.push(`- ${node.role.value}${name}`);
    }
    return lines.join('\n');
  }

  async injectCookies(cookies: any[]): Promise<void> {
    for (const c of cookies || []) {
      if (!c?.name) continue;
      await this.cdp.setCookie({
        name: String(c.name),
        value: String(c.value ?? ''),
        domain: c.domain,
        path: c.path,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expires: typeof c.expires === 'number' ? c.expires : undefined,
      });
    }
  }

  /** 当前环境（供脚本判断，与 Playwright 侧同源） */
  get env(): string { return KEVE_ENV; }
}

/** URL 断言用的正则转义（导出以便测试） */
export { escapeRegExp };
