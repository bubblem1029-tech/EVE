/**
 * cdp — Cypress 下的 AUT（被测应用）驱动层
 *
 * 背景：Cypress 的命令队列无法承载 async 的 EngineAdapter（详见
 * EVE/docs/cypress-engine-cdp-findings.md）。这里完全绕开命令队列，只用
 * `Cypress.automation('remote:debugger:protocol')` 直连 CDP，得到与 Playwright
 * 等价的「读 DOM / 交互 / 导航 / 截图」能力。
 *
 * 三条硬约束（探针实测，改动前先看 findings 文档）：
 *   1. 严禁对主会话发 Page.navigate / Page.reload —— 会导航 Cypress runner 顶层页，
 *      摧毁 runner。导航/刷新一律在 AUT 的 isolated world 内改 location。
 *   2. 所有 DOM 读写必须走 `Page.createIsolatedWorld` 得到的 executionContextId，
 *      否则读到的是 Cypress runner 自己的 UI（cy.$$ / Cypress.$ 同理不可用）。
 *   3. Page.captureScreenshot 不带 clip 会拍到 runner 界面；必须用
 *      `iframe.aut-iframe` 的 rect 裁剪，才能得到干净的 AUT 截图。
 *
 * 本模块零依赖，运行在 Cypress 的 spec 上下文（浏览器）。
 */

export type CdpSend = (command: string, params?: Record<string, unknown>) => Promise<any>;

export interface CdpFrame {
  id: string;
  url: string;
}

export interface AutSnapshot {
  frameId: string;
  url: string;
  readyState: string;
  title: string;
}

const RUNNER_FRAME_RE = /__cypress|__\//;

/** 判断 frame URL 是否属于 Cypress runner 自身（AUT 诊断采集应跳过） */
export function isRunnerFrameUrl(url: string): boolean {
  return RUNNER_FRAME_RE.test(String(url || ''));
}

/** 轮询工具：`fn` 返回 undefined 表示「还没就绪」，继续轮询 */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeout: number,
  interval = 100,
): Promise<T | undefined> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  for (;;) {
    try {
      const out = await fn();
      if (out !== undefined) return out;
      last = out;
    } catch {
      /* 过渡期（frame 正在重建 / context 已销毁）：继续轮询 */
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function createCdp(send: CdpSend) {
  let cachedWorld: { frameId: string; contextId: number } | null = null;

  async function frames(): Promise<CdpFrame[]> {
    const tree = await send('Page.getFrameTree');
    const all: CdpFrame[] = [];
    const walk = (node: any) => {
      if (!node?.frame) return;
      all.push({ id: node.frame.id, url: String(node.frame.url || '') });
      (node.childFrames || []).forEach(walk);
    };
    walk(tree?.frameTree);
    return all;
  }

  /** AUT frame：过滤掉 Cypress runner 自身的 frame */
  async function autFrame(): Promise<CdpFrame> {
    const all = await frames();
    const hit = all.find((f) => !RUNNER_FRAME_RE.test(f.url));
    if (!hit) {
      throw new Error(`[cypress-engine] 未找到 AUT frame，现有 frame: ${JSON.stringify(all.map((f) => f.url))}`);
    }
    return hit;
  }

  /**
   * AUT 的 isolated world。
   * 导航会销毁旧 contextId，因此每次调用先校验缓存是否仍指向同一 frame；
   * 失效时重建（`Page.createIsolatedWorld` 对同 frame + 同 worldName 会复用）。
   */
  async function context(force = false): Promise<number> {
    const frame = await autFrame();
    if (!force && cachedWorld && cachedWorld.frameId === frame.id) return cachedWorld.contextId;
    const res = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'keve' });
    cachedWorld = { frameId: frame.id, contextId: res.executionContextId };
    return res.executionContextId;
  }

  /** 在 AUT 内求值；context 失效时自动重建并重试一次 */
  async function evaluateInAut<T = any>(expression: string, opts: { awaitPromise?: boolean } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const ctx = await context();
      const res = await send('Runtime.evaluate', {
        expression,
        contextId: ctx,
        returnByValue: true,
        awaitPromise: opts.awaitPromise !== false,
      });
      if (res?.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
        throw new Error(String(desc));
      }
      return res?.result?.value as T;
    };
    try {
      return await run();
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (!/context|Cannot find|Execution context/i.test(msg)) throw err;
      cachedWorld = null;
      return await run();
    }
  }

  /**
   * 在指定 frame 内求值（诊断遍历子 frame 用）。
   *
   * Cypress 的 AUT 与业务子 frame 可能是跨域 OOPIF，但它们仍在同一 CDP
   * 页面目标内；`Page.createIsolatedWorld` + `Runtime.evaluate` 可以逐个 frame
   * 读主世界快照。逐次创建 world 成本可接受，且对同 frame + 同 worldName
   * 浏览器会复用已有执行上下文。
   */
  async function evaluateInFrame<T = any>(
    frameId: string,
    expression: string,
    opts: { awaitPromise?: boolean } = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const res = await send('Page.createIsolatedWorld', { frameId, worldName: 'keve' });
      const ctx = res?.executionContextId;
      if (!ctx) throw new Error(`[cypress-engine] frame ${frameId} 未返回 isolated world`);
      const evaluated = await send('Runtime.evaluate', {
        expression,
        contextId: ctx,
        returnByValue: true,
        awaitPromise: opts.awaitPromise !== false,
      });
      if (evaluated?.exceptionDetails) {
        const desc = evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text;
        throw new Error(String(desc));
      }
      return evaluated?.result?.value as T;
    };
    try {
      return await run();
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (!/context|Cannot find|Execution context|frame/i.test(msg)) throw err;
      return await run();
    }
  }

  /** 在 runner 顶层页求值（仅用于取 AUT iframe 的 rect，不用于业务断言） */
  async function evaluateInRunner<T = any>(expression: string): Promise<T> {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (res?.exceptionDetails) {
      throw new Error(String(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res?.result?.value as T;
  }

  /** 读取 AUT 基础状态（frame URL / readyState / title） */
  async function snapshot(): Promise<AutSnapshot> {
    const frame = await autFrame();
    const probe = await evaluateInAut<string>(
      `document.readyState + "\\u0000" + location.href + "\\u0000" + String(document.title || "")`,
    );
    const [readyState, url, title] = String(probe ?? '').split('\u0000');
    return { frameId: frame.id, url: url || frame.url, readyState: readyState || '', title: title || '' };
  }

  /** 当前 AUT URL（context 失效时回退到 frame.url） */
  async function currentUrl(): Promise<string> {
    try {
      return await evaluateInAut<string>('location.href');
    } catch {
      return (await autFrame()).url;
    }
  }

  /**
   * 导航到目标 URL。
   *
   * 就绪判定不看 URL，而是看 `performance.timeOrigin` 是否变化：
   *   1. 目标站常把 `/` 客户端重定向到 `/projects`（含尾斜杠、hash 差异），
   *      用 `snap.url === url` 判定会让已渲染的页面被误报成导航超时；
   *   2. `timeOrigin` 每次新文档导航都会变，而 SPA 的 pushState/replaceState
   *      不改它，因此既能确认「真的换了文档」，又不会被路由重写干扰；
   *   3. 旧的 `screenshot-before` 误把旧页面 complete 当导航完成的问题也一并规避。
   *
   * 新文档就绪后 readyState 非 loading 即视为可交互：部分长连接页面会长期停在
   * interactive，不再进入 complete。
   */
  async function goto(url: string, timeout = 30000): Promise<void> {
    const beforeUrl = await currentUrl();
    // 基线读不到时用 null 表示「未知」，绝不用 0 兜底 —— 后者会让后续任意一次
    // 成功读数都被判成「换过文档」，等于把旧文档放行。
    const beforeTimeOrigin = await evaluateInAut<number>(
      'Number(performance.timeOrigin || 0)',
    ).catch(() => null);
    await evaluateInAut(`location.href = ${JSON.stringify(url)}`);

    /** 仅 hash 不同 = 同文档内跳转，timeOrigin 不变，只能等 URL 收敛 */
    const normalizeUrl = (raw: string): string => {
      try {
        const u = new URL(String(raw));
        u.hash = '';
        // 尾斜杠差异不代表换页，统一去掉再做比较。
        return u.href.replace(/\/$/, '');
      } catch {
        return String(raw || '');
      }
    };
    const readHash = (raw: string): string => {
      try {
        return new URL(String(raw)).hash;
      } catch {
        return '';
      }
    };
    const hashOnly = (() => {
      try {
        const target = new URL(url);
        return Boolean(target.hash) && normalizeUrl(beforeUrl) === normalizeUrl(url);
      } catch {
        return false;
      }
    })();

    let lastSnapshot: AutSnapshot | null = null;
    let lastProbeError = '';
    const documentChanged = async (snap: AutSnapshot): Promise<boolean> => {
      const origin = await evaluateInAut<number>(
        'Number(performance.timeOrigin || 0)',
      ).catch(() => null);
      // 基线或当前值任一读不到时，退回「URL 确实变了」这一较弱但不会放行
      // 旧文档的信号，避免把当前文档当成导航完成。
      if (typeof origin !== 'number' || origin <= 0 || beforeTimeOrigin === null) {
        return snap.url !== beforeUrl;
      }
      return origin !== beforeTimeOrigin;
    };
    const readLanded = async (requireComplete: boolean): Promise<AutSnapshot | undefined> => {
      try {
        const snap = await snapshot();
        lastSnapshot = snap;
        lastProbeError = '';
        // hash 跳转不换文档：按规范化后的「同路径 + 目标 hash」判定收敛；
        // 同址 re-goto 时首轮即命中属预期（页面本就在目标位置）。
        const arrived = hashOnly
          ? normalizeUrl(snap.url) === normalizeUrl(url) && readHash(snap.url) === readHash(url)
          : await documentChanged(snap);
        if (!arrived) return undefined;
        if (requireComplete) return snap.readyState === 'complete' ? snap : undefined;
        return snap.readyState === 'loading' || snap.readyState === 'uninitialized' ? undefined : snap;
      } catch (err: any) {
        lastProbeError = String(err?.message || err);
        return undefined;
      }
    };

    if (await pollUntil(() => readLanded(true), timeout)) return;
    if (await pollUntil(() => readLanded(false), 5000)) return;

    const detail = lastSnapshot
      ? `最后状态 readyState=${lastSnapshot.readyState} url=${lastSnapshot.url}`
      : `未读到新文档快照${lastProbeError ? `（${lastProbeError}）` : ''}`;
    throw new Error(`[cypress-engine] 导航超时（${timeout}ms）：${url}；${detail}`);
  }

  /** 刷新当前 AUT 页面（在 AUT context 内 reload，绝不碰 runner） */
  async function reload(timeout = 30000): Promise<void> {
    const before = await currentUrl();
    await evaluateInAut('location.reload()').catch(() => { /* reload 会打断本次求值，属预期 */ });
    const landed = await pollUntil(async () => {
      const snap = await snapshot();
      if (snap.readyState !== 'complete') return undefined;
      // reload 后 URL 不变，只能等 frame 重建后的 complete
      return snap.url === before ? snap : undefined;
    }, timeout, 200);
    if (!landed) throw new Error(`[cypress-engine] 刷新超时（${timeout}ms）`);
  }

  /** AUT 截图（裁剪到 iframe 区域，得到不含 runner chrome 的图） */
  async function autRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return await evaluateInRunner<{ x: number; y: number; w: number; h: number } | null>(
      `(() => {
        var f = document.querySelector('iframe.aut-iframe');
        if (!f) return null;
        var b = f.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      })()`,
    );
  }

  /** AUT 截图（裁剪到 iframe 区域，得到不含 runner chrome 的图） */
  async function screenshot(): Promise<string> {
    const rect = await autRect();
    const shot = rect
      ? await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
      })
      : await send('Page.captureScreenshot', { format: 'png' });
    return String(shot?.data || '');
  }

  /**
   * 元素级截图：`clip` 是 AUT 视口坐标（getBoundingClientRect 的 x/y/width/height），
   * 这里叠加 AUT iframe 在 runner 顶层页里的偏移与顶层滚动量，得到
   * Page.captureScreenshot 需要的顶层页面坐标。
   */
  async function screenshotClip(clip: {
    x: number; y: number; width: number; height: number;
  }): Promise<string> {
    const rect = await autRect();
    const scroll = await evaluateInRunner<{ x: number; y: number }>(
      '({ x: window.scrollX || 0, y: window.scrollY || 0 })',
    ).catch(() => ({ x: 0, y: 0 }));
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: clip.x + (rect?.x || 0) + (scroll?.x || 0),
        y: clip.y + (rect?.y || 0) + (scroll?.y || 0),
        width: Math.max(1, clip.width),
        height: Math.max(1, clip.height),
        scale: 1,
      },
    });
    return String(shot?.data || '');
  }

  /** 注入浏览器侧定位器源码（幂等） */
  async function injectLocator(source: string): Promise<void> {
    await evaluateInAut(source);
  }

  /**
   * 注册新文档预加载脚本（主世界）。
   *
   * Cypress 的 isolated world 只能访问 AUT 的独立执行上下文，改不了主世界里应用
   * 依赖的 `window.*`。要兜底像 `requestAnimationFrame` 这类 DOM 运行时 API，
   * 必须在每次新文档创建前注册到主世界，确保应用脚本执行前已就位。
   */
  async function installPreloadScript(source: string): Promise<void> {
    await send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async function ensureLocator(): Promise<void> {
    const ok = await evaluateInAut<boolean>(
      'Boolean(window.__keveLocator && window.__keveLocatorSource === "v5")',
    );
    if (!ok) {
      const { locatorSource } = await import('../dsl/locatorSource.js');
      await injectLocator(locatorSource());
    }
  }

  async function setCookie(cookie: {
    name: string; value: string; domain?: string; path?: string;
    secure?: boolean; httpOnly?: boolean; expires?: number;
  }): Promise<void> {
    await send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expires: cookie.expires,
    });
  }

  /** AUT 可访问性树（仅 AUT，主会话调用拿到的是 runner UI） */
  async function axTree(): Promise<any[]> {
    const frame = await autFrame();
    const res = await send('Accessibility.getFullAXTree', { frameId: frame.id });
    return Array.isArray(res?.nodes) ? res.nodes : [];
  }

  return {
    send,
    frames,
    autFrame,
    context,
    evaluateInAut,
    evaluateInFrame,
    evaluateInRunner,
    snapshot,
    currentUrl,
    goto,
    reload,
    autRect,
    screenshot,
    screenshotClip,
    injectLocator,
    installPreloadScript,
    ensureLocator,
    setCookie,
    axTree,
    invalidateWorld: () => { cachedWorld = null; },
  };
}

export type Cdp = ReturnType<typeof createCdp>;
