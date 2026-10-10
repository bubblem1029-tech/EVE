/**
 * host — 把 Cypress 的 describe/it 适配成 KeveHost
 *
 * 关键约束（探针结论，见 EVE/docs/cypress-engine-cdp-findings.md）：
 *   1. 用例体整体跑在 `cy.then({ timeout }, async () => …)` 内，内部**零 cy 命令**，
 *      全靠 CDP + 原生 DOM。默认 cy.then 超时只有 4000ms，必须显式放大。
 *   2. 必须先 `cy.visit(base)` 把 AUT iframe 建起来，否则 CDP 找不到 frame。
 *   3. `cy.task` 在 async cy.then 内不可 await —— Node 侧能力一律走 HTTP 桥。
 *
 * 这样同一份 @keveModel/@keveScene 脚本在 Playwright 与 Cypress 下注册出的
 * 场景元数据完全一致，报告才能同构。
 */

import type { KeveHost, KeveTestInfo } from '../core/decorator/keve-host.js';
import { setKeveHost } from '../core/decorator/keve-host.js';
import type { CdpSend } from './cdp.js';
import { createCdp } from './cdp.js';
import { CypressEngine, createBridge } from './adapter.js';
import { addUncaughtError, beginTestState, requireTestState } from './state.js';
import type { KeveGoalCallOptions } from './keveGoal.js';
import { createCyKeveGoal, setCyGoalExplorer, type CyGoalExploreResult } from './keveGoal.js';
import { CyAgentPage } from './agent-page.js';
import { reactLoop } from '../page-agent/agent.js';
import { emptyRuntimeDiagnostics, mergeRuntimeDiagnostics, buildRuntimeDiagnostics } from '../page-agent/diagnostics.js';

/** 单个用例体允许的最长执行时间（与 Playwright 侧 timeout 对齐） */
const CY_TEST_TIMEOUT_MS = Number(process.env.KEVE_CY_TEST_TIMEOUT || 300_000);

/** 单个 goal 的探索上限（与 Playwright keve-test.ts 的 GOAL_TIMEOUT_MS 对齐） */
const CY_GOAL_TIMEOUT_MS = 300_000;

/**
 * Cypress 的运行时对象（`Cypress`）：env / config / automation / currentTest / spec。
 * 注意它**不是**命令链，不能 `.visit()` / `.wrap()`。
 */
function cy(): any {
  const c = (globalThis as any).Cypress;
  if (!c) throw new Error('[cypress-engine] 未找到 Cypress 运行时：本模块只能在 Cypress spec 中运行');
  return c;
}

/**
 * 命令链 `cy`：visit / then / wrap 等。
 * 与运行时对象严格区分 —— `Cypress.visit` 不存在，混用会报 "cy(...).visit is not a function"。
 * 注意 Cypress 12 里 `cy` 是**可调用对象**（typeof === 'object'），所以只能按能力探测。
 */
function cyChain(): any {
  const chain = (globalThis as any).cy;
  if (!chain || typeof chain.visit !== 'function') {
    throw new Error('[cypress-engine] 未找到 cy 命令链：本模块只能在 Cypress spec 中运行');
  }
  return chain;
}

/** AUT 打底 URL：优先 cypress.config baseUrl，其次 KEVE_TARGET_URL */
export function resolveBaseUrl(): string {
  const fromConfig = String(cy().config?.('baseUrl') || '');
  if (/^https?:\/\//.test(fromConfig)) return fromConfig;
  const fromEnv = String(cy().env?.('KEVE_TARGET_URL') || '');
  if (/^https?:\/\//.test(fromEnv)) return fromEnv;
  throw new Error(
    '[cypress-engine] 缺少 baseUrl：请在 cypress.config 设置 baseUrl，或注入 KEVE_TARGET_URL 环境变量',
  );
}

/** 服务端解析好的 SSO cookie（经 config.env 下发，浏览器侧可读） */
function readInjectedCookies(): any[] {
  const raw = cy().env?.('KEVE_SSO_COOKIES');
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn('[cypress-engine] KEVE_SSO_COOKIES 解析失败，按未登录执行');
    return [];
  }
}

export function createCypressEngine(bridge = createBridge()): CypressEngine {
  const send: CdpSend = (command, params) =>
    cy().automation('remote:debugger:protocol', { command, params: params || {} });
  return new CypressEngine(createCdp(send), bridge);
}

// ─── Agent Re-Act（P0-3：Cypress 侧与 Playwright 同构） ─────────────────

/** 浏览器侧读环境变量：cy.env 优先，其次非敏感 config.env 兜底。 */
function readBrowserEnv(name: string): string {
  const raw = cy().env?.(name);
  return raw === undefined || raw === null ? '' : String(raw);
}

/**
 * Cypress 侧的 AgentPage 宿主能力（与 core/keve-test.ts 的注入一一对应）。
 *
 * 与 Playwright 的唯一差异：Node 能力全部经桥往返 ——
 *   - 截图落盘    → `/shot/save`
 *   - 读初始截图  → `/fs/read-binary`
 *   - LLM 调用    → `/llm/chat`（apiKey 不出 Node）
 */
function createCyAgentHost(bridge: ReturnType<typeof createBridge>, signal: AbortSignal): {
  targetUrl: string;
  getEnv: (name: string) => string;
  saveScreenshot: (pngBase64: string, stepIndex: number, stepName: string) => Promise<string | undefined>;
  loadInitialImages: (paths: { goalScreenshotBefore?: string; fnAfterScreenshot?: string }) => Promise<any[]>;
  llm: { baseURL: string; model: string; customFetch: typeof globalThis.fetch };
} {
  const targetUrl = readBrowserEnv('KEVE_TARGET_URL') || resolveBaseUrl();

  const getEnv = (name: string): string => {
    const direct = readBrowserEnv(name);
    if (direct) return direct;
    // 兼容 Node 侧命名差异：LLM_BASE_URL → KEVE_LLM_BASE_URL
    const alias: Record<string, string> = {
      KEVE_LLM_BASE_URL: 'LLM_BASE_URL',
      KEVE_LLM_MODEL_NAME: 'LLM_MODEL_NAME',
      KEVE_LLM_MODEL: 'LLM_MODEL_NAME',
      KEVE_LLM_API_KEY: 'LLM_API_KEY',
      KEVE_TARGET_URL: 'BASE_URL',
    };
    return alias[name] ? readBrowserEnv(alias[name]) : '';
  };

  const saveScreenshot = async (
    pngBase64: string,
    stepIndex: number,
    stepName: string,
  ): Promise<string | undefined> => {
    // 命名规则与 Playwright 的 saveAgentScreenshot 保持一致（桥自动追加时间戳）
    const safeName = String(stepName || 'step').replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30);
    const resp = await bridge.post('/shot/save', {
      name: `agent-step${stepIndex}-${safeName}`,
      pngBase64,
    }, { signal });
    return resp?.ok ? String(resp.path || '') || undefined : undefined;
  };

  const loadInitialImages = async (paths: {
    goalScreenshotBefore?: string;
    fnAfterScreenshot?: string;
  }): Promise<any[]> => {
    const items: any[] = [];
    for (const [label, rel] of [
      ['goal-before', paths.goalScreenshotBefore],
      ['fn-after', paths.fnAfterScreenshot],
    ] as const) {
      if (!rel) continue;
      try {
        const resp = await bridge.post('/fs/read-binary', { file: rel }, { signal });
        if (!resp?.ok || !resp.base64) continue;
        items.push({ type: 'text', text: `Screenshot (${label}):` });
        items.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${resp.base64}` } });
      } catch { /* 单张图读失败不影响探索 */ }
    }
    return items;
  };

  /**
   * LLM 配置：baseURL/model 下发浏览器，调用经桥转发回 Node。
   *
   * 刻意不传 apiKey —— `@kkeve/core` 只在 apiKey 非空时才拼 Authorization，
   * 这里留空即可；真正的鉴权头由桥在 Node 侧补齐。
   */
  const customFetch = (async (url: any, init: any): Promise<Response> => {
    const headers: Record<string, string> = {};
    try {
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    } catch { /* headers 不可枚举时留空 */ }
    const resp = await bridge.post('/llm/chat', {
      url: String(url),
      method: String(init?.method || 'POST'),
      headers,
      body: typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? {}),
    }, { signal });
    if (!resp?.ok) throw new Error(resp?.error || 'llm/chat 桥调用失败');
    return new Response(String(resp.body ?? ''), {
      status: Number(resp.status) || 200,
      statusText: String(resp.statusText || ''),
      headers: (resp.headers || {}) as Record<string, string>,
    });
  }) as typeof globalThis.fetch;

  return {
    targetUrl,
    getEnv,
    saveScreenshot,
    loadInitialImages,
    llm: {
      baseURL: readBrowserEnv('KEVE_LLM_BASE_URL') || getEnv('KEVE_LLM_BASE_URL'),
      model: readBrowserEnv('KEVE_LLM_MODEL_NAME') || getEnv('KEVE_LLM_MODEL_NAME'),
      customFetch,
    },
  };
}

/**
 * 注册 Cypress 侧的 goal 探索器：fn 成功/失败都用同一个 Re-Act 循环做最终判定。
 *
 * 必须在**每次 test 内**重新注册 —— 探索器闭包绑定了本次 test 的 engine/bridge/
 * 超时控制，跨用例复用会污染到已结束的 CDP 通道。
 */
function installGoalExplorer(engine: CypressEngine, bridge: ReturnType<typeof createBridge>): void {
  const cdp = engine.rawPage() as ReturnType<typeof createCdp>;

  setCyGoalExplorer(async (options, ctx): Promise<CyGoalExploreResult | undefined> => {
    const page = new CyAgentPage(cdp);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CY_GOAL_TIMEOUT_MS);
    const host = createCyAgentHost(bridge, controller.signal);
    try {
      const result = await reactLoop(page, options.step, options.expected, {
        specFilePath: ctx.specFilePath,
        fnSource: ctx.fnSource,
        // fn 只是前置确定性校验：成功时也要让 Agent 重新走一遍 Re-Act 给出
        // 最终结论，否则报告里不会产生 AI 推理轨迹。
        fnResult: ctx.fnError ? { error: ctx.fnError } : { success: true },
        signal: controller.signal,
        goalScreenshotBefore: ctx.goalScreenshotBefore,
        fnAfterScreenshot: ctx.fnAfterScreenshot,
        targetUrl: host.targetUrl,
        getEnv: host.getEnv,
        saveScreenshot: host.saveScreenshot,
        loadInitialImages: host.loadInitialImages,
        llm: host.llm,
      });

      /**
       * Cypress 侧 reactLoop 的原生页面事件监听不会产生数据（CyAgentPage 不派发
       * console/network 事件）。真正的采集在主世界预加载脚本里完成，这里读取
       * DOM 快照，把页面级性能与浏览器/网络样本补进同一份诊断结构。
       */
      let diagnostics: CyGoalExploreResult['diagnostics'] = result.diagnostics;
      try {
        const snap = await page.readDiagnosticsSnapshot();
        if (snap) {
          const pageDiag = buildRuntimeDiagnostics({
            consoleRecords: snap.browser,
            networkRecords: snap.network,
            pageMetrics: snap.page,
          });
          diagnostics = mergeRuntimeDiagnostics([result.diagnostics || emptyRuntimeDiagnostics(), pageDiag]);
        }
      } catch { /* 诊断读取失败不阻断用例 */ }

      return {
        expectedMet: result.expectedMet,
        conclusion: result.conclusion,
        actions: result.actions,
        finalSnapshot: result.finalSnapshot,
        agentScreenshots: result.agentScreenshots,
        diagnosticHints: (result as any).diagnosticHints,
        diagnostics,
      };
    } finally {
      clearTimeout(timer);
      page.dispose();
    }
  });
}

/** 模块级前置校验失败 → 该 describe 下所有 Scene 跳过（blocked，不是 fail） */
const blockedSuites = new Map<string, string>();

/**
 * 当前用例所属的模块 describe 标题（`M_SG90061: …`）。
 *
 * Cypress 12 的 `currentTest` 上**没有** `titlePath`（探针实测），必须沿 Mocha
 * `parent` 链取最靠近用例的非 root 祖先标题。取空会让 blockedSuites 全部落到同一个
 * 空键上 —— 模块前置校验失败时既不能精准跳过，又会跨 spec 残留污染其他用例。
 */
function currentSuiteTitle(): string {
  const titles: string[] = [];
  let node = cy().currentTest?.parent;
  while (node && !node.root) {
    if (node.title) titles.push(String(node.title));
    node = node.parent;
  }
  return titles.length ? titles[titles.length - 1] : '';
}

/**
 * 安装 Cypress → KeveHost 适配，并注册装饰器宿主。
 *
 * 幂等：重复调用（多次 import）不会重复注册钩子。
 */
let installed = false;
export function installCypressHost(): KeveHost {
  if (installed) return host;
  installed = true;

  const c = cy();
  // 应用侧未捕获异常不放过测试继续执行：记录错误并交给 reporter 归为失败，
  // 否则单一页面运行时异常会让整个用例在 keveGoal 收尾前被 Cypress 中断，
  // 报告拿不到截图/推理日志/真实步骤。
  c.on('uncaught:exception', (err: any) => {
    addUncaughtError(String(err?.message || err?.stack || err));
    return false;
  });

  const mochaDescribe = c.describe || (globalThis as any).describe;
  const mochaIt = c.it || (globalThis as any).it;
  const mochaBefore = c.before || (globalThis as any).before;
  const mochaBeforeEach = c.beforeEach || (globalThis as any).beforeEach;
  const mochaAfter = c.after || (globalThis as any).after;
  const mochaAfterEach = c.afterEach || (globalThis as any).afterEach;

  // 每个用例开始：重置状态容器（附件 / goal 序号 / skip 标记）
  mochaBeforeEach(function () {
    beginTestState(cy().currentTest?.title || '', cy().spec?.relative || '');
    const reason = blockedSuites.get(currentSuiteTitle());
    if (reason) this.skip(reason);
  });

  host = {
    describe: (title, fn) => mochaDescribe(title, fn),
    // Cypress 的执行天然串行，serial 与普通 describe 等价
    describeSerial: (title, fn) => mochaDescribe(title, fn),

    beforeAll: (fn) => {
      // 模块前置校验：失败不抛（抛会让所有 Scene 变 failed），
      // 而是记住原因，交给每个 Scene 的 beforeEach 统一 skip。
      mochaBefore(async function (this: any) {
        const suite = currentSuiteTitle();
        try {
          await fn();
        } catch (err: any) {
          const reason = err?.message || String(err);
          if (suite) blockedSuites.set(suite, reason);
          console.warn(`[cypress-engine] 模块前置校验未通过，跳过 "${suite}"：${reason}`);
        }
      });
    },

    beforeEach: (fn) => {
      mochaBeforeEach(async function (this: any) {
        const title = cy().currentTest?.title || '';
        const info: KeveTestInfo = {
          title,
          skip: (reason?: string) => this.skip(reason),
        };
        await fn(info);
      });
    },

    afterEach: (fn) => {
      mochaAfterEach(async function (this: any) {
        const title = cy().currentTest?.title || '';
        const info: KeveTestInfo = {
          title,
          skip: (reason?: string) => this.skip(reason),
        };
        await fn(info);
      });
    },

    afterAll: (fn) => {
      mochaAfter(async function () {
        await fn();
      });
    },

    /**
     * 注册一个 Scene 用例。
     * 场景方法体形如 `({ engine, keveGoal }) => …`，这里装配同形 fixture。
     */
    test: (title, fn) => {
      mochaIt(title, function () {
        const state = requireTestState();
        const base = resolveBaseUrl();

        /**
         * 登录态：服务端解析好的 cookie 经 config.env 下发。
         *
         * 必须在**首次 cy.visit 之前**注入：目标站未登录时会把首个导航 302 到
         * SSO 登录页，随后的 Re-Act 会拿到登录页截图并尝试用密码登录（必然失败，
         * 报告里表现为 "SSO login failed … credentials rejected"）。
         * Playwright 侧由 storageState 在 context 创建时就带好 cookie，没有这个
         * 竞态；Cypress 侧只能在命令队列里把注入排到 visit 前面。
         *
         * 该步骤跑在 Cypress 的 test body 内 —— Cypress 已在用例开始前清过 cookie，
         * 此处写入的 cookie 不会被再次清掉。
         */
        const injectCookiesBeforeVisit = async () => {
          const cookies = readInjectedCookies();
          if (!cookies.length) {
            console.warn('[cypress-engine] 未收到 KEVE_SSO_COOKIES，按未登录执行（可能跳转 SSO 登录页）');
            return;
          }
          try {
            const engine = createCypressEngine(createBridge());
            await engine.injectCookies(cookies);
            console.log(`[cypress-engine] 首次导航前已注入 SSO cookie ${cookies.length} 条`);
          } catch (err: any) {
            console.warn(`[cypress-engine] cookie 注入失败（继续执行）：${err?.message || err}`);
          }
        };

        return cyChain()
          .then({ timeout: CY_TEST_TIMEOUT_MS }, injectCookiesBeforeVisit)
          /**
           * 唯一的 cy 命令：把 AUT iframe 建起来（CDP 通道依赖它）。
           *
           * `base` 只作为占位首页，真实目标由用例内的 `engine.navigate` 决定。
           * 部分环境（如 rc-eve 根域）即便带上有效 SSO cookie 也会返回 403，
           * 若用默认校验会让整条用例在 bootstrap 阶段就失败 —— 这里关掉状态码
           * 校验，只要 iframe 建起来即可；注入的 cookie 已在访问前写好，不会丢。
           */
          .then({ timeout: CY_TEST_TIMEOUT_MS }, () => cyChain().visit(base, { failOnStatusCode: false }))
          .then({ timeout: CY_TEST_TIMEOUT_MS }, async () => {
            const bridge = createBridge();
            const engine = createCypressEngine(bridge);
            /**
             * 给后续每次新文档预注册浏览器运行时 API 兜底。
             *
             * 现状：部分业务页面（如 kwaibi 多维）会直接调用 rAF，而 Cypress 的
             * `<iframe.aut-iframe>` 主世界没有带出该实现，页面脚本会在导航后抛
             * `window.requestAnimationFrame is not a function`。Playwright 上下文
             * 自带完整 DOM 运行时，所以两边差异只在 Cypress 侧暴露。
             */
            try {
              await engine.rawPage().installPreloadScript(`
                (() => {
                  if (typeof window.requestAnimationFrame !== 'function') {
                    window.requestAnimationFrame = function (cb) {
                      return setTimeout(function () { cb(Date.now()); }, 16);
                    };
                  }
                  if (typeof window.cancelAnimationFrame !== 'function') {
                    window.cancelAnimationFrame = function (id) { clearTimeout(id); };
                  }
                })();
              `);
            } catch (err: any) {
              console.warn(`[cypress-engine] rAF polyfill 预注册失败：${err?.message || err}`);
            }

            /**
             * 运行诊断采集：必须在**主世界**注册（isolated world 看不到应用主世界的
             * console / fetch），且要早于业务脚本执行。通过
             * `Page.addScriptToEvaluateOnNewDocument` 保证每次导航后自动重放。
             */
            try {
              const { diagnosticsSource } = await import('./pageOps.js');
              await engine.rawPage().installPreloadScript(diagnosticsSource());
            } catch (err: any) {
              console.warn(`[cypress-engine] 诊断采集预注册失败：${err?.message || err}`);
            }

            // Agent Re-Act：fn 成功/失败都由同一个 Re-Act 循环判定（per-test 注册，避免跨用例污染）
            installGoalExplorer(engine, bridge);

            const keveGoal = createCyKeveGoal(engine);
            const testInfo = {
              title: state.title,
              file: state.file,
              skip: () => { /* Mocha skip 由宿主 beforeEach 提供 */ },
            };
            try {
              await fn({ engine, keveGoal, testInfo });
            } finally {
              // 用例结束即摘掉探索器：闭包绑定的 CDP 通道已随 frame 失效
              setCyGoalExplorer(null);
            }
          });
      });
    },
  };

  setKeveHost(host);
  return host;
}

let host: KeveHost;

/** 模块级前置校验的跳过原因（供 reporter 归因展示） */
export function getBlockedReason(suiteTitle: string): string | undefined {
  return blockedSuites.get(suiteTitle);
}

export type { KeveGoalCallOptions };
