/**
 * keve-test — Playwright test fixture: keveGoal (唯一操作原语)
 *
 * keveGoal 执行 fn 后 → 截图+fn逻辑+expected → Agent Re-Act 观察页面后给最终结论
 *   fn 无    → Re-Act 直接探索
 *   fn 成功  → 仍进 Re-Act，确认预期达成并产出推理轨迹
 *   fn 异常  → Re-Act 自愈
 *   确定性事实（环境阻断 / 页面已关闭 / 截图差异超阈值）→ 短路，不烧 token
 *
 * keveAssert 已被吸收：keveGoal 的 expected 即断言语义
 *
 * Usage:
 *   import { test, expect } from '@kkeve/suite/keve-test';
 *
 *   test('my test', async ({ page, keveGoal }) => {
 *     await keveGoal({ step: '导航到列表页', expected: '页面加载完成' }, async () => {
 *       await page.goto('/agents');
 *     });
 *
 *     // AI explore (no fn):
 *     await keveGoal({ step: '点击新建按钮', expected: '弹出创建对话框' });
 *   });
 */

import { test as base, expect, chromium } from '@playwright/test';
import { sceneGoalsMap, type KeveGoalMeta } from '../core/decorator/keve-registry.js';
import { reactLoop } from '../page-agent/agent.js';
import type { ContentItem } from '@kkeve/core/llm';
import { keveAspect, type GoalContext, type GoalResult } from '../core/decorator/keve-aspect.js';
import { learnedActions } from '../core/learned-actions.js';
import { loadConfig } from '../config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 登录态注入 ─────────────────────────────────────────────────────
// 不再由测试侧启动浏览器 / CDP 接管。登录 cookie 由服务端解析后随环境变量下发，
// 这里只负责在启动浏览器前把 storageState 就位（global-setup 已写好文件）。
import { resolveStorageStatePath, writeStorageState, readInjectedCookies } from './global-setup.js';
import { beginGoalShotDiffCapture, drainGoalShotDiff, ScreenshotDiffError } from '../core/judge/screenshotDiff.js';
import { isAssertionFailure, isEnvironmentBlockedError } from '../core/judge/goal-heuristics.js';

export { expect };
export { keveModel, keveScene, getModelScenes } from '../core/decorator/keve-decorators.js';
export type { KeveSceneMeta, KeveModelOptions, KeveSceneOptions } from '../core/decorator/keve-decorators.js';
export { sceneCodeMap, sceneEvalMetaMap, sceneMetaMap } from '../core/decorator/keve-registry.js';
export type { KeveEvalMeta, ErrorCategory, KeveSceneStaticMeta } from '../core/decorator/keve-registry.js';

// Re-export goal metadata for consumer convenience
export { sceneGoalsMap, type KeveGoalMeta } from '../core/decorator/keve-registry.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface KeveGoalCallOptions {
  precondition?: string;
  step: string;
  expected: string;
}

type KeveFixture = {
  keveGoal: (options: KeveGoalCallOptions, fn?: () => Promise<void>) => Promise<void>;
  keveReadDoc: (url: string, options?: { noImages?: boolean; outputPath?: string }) => Promise<any>;
  /** 引擎适配器：engine.click/type/hover/assertVisible 等，引擎无关操作 */
  engine: import('./engineAdapter.js').EngineAdapter;
  /** 将内置 testInfo 包装为可解构 fixture，允许脚本直接写 { page, keveGoal, testInfo } */
  testInfo: import('@playwright/test').TestInfo;
};

// ─── Register Built-in Aspects ───────────────────────────────────────

// NOTE: action-log-write aspect 已废弃。
// AI 探索过程数据现在通过 keveGoalResult attachment 直接流到 KeveReporter，
// 由 KeveReporter 统一写入 confidence-data.jsonl（含 reactSteps）。

keveAspect.register({
  name: 'learnedActions-update',
  phase: 'after',
  order: 20,
  async execute(ctx: GoalContext, result?: GoalResult): Promise<GoalResult | void> {
    if (!result?.actions?.length) return;
    const url = ctx.page.url();
    learnedActions.add(ctx.step, result.actions as any[], url, result.success);
  },
});

// ─── (diagnostic extraction moved to page-agent/diagnostic.ts, called via onAfterTask hook) ──

// ─── Fixture ────────────────────────────────────────────────────────

export const test = base.extend<KeveFixture>({
  // ── 将内置 testInfo 包装为可解构 fixture ─────────────────────────
  // 测试方法可直接写 { page, keveGoal, testInfo }，不再报 "unknown parameter" 错误
  // ── engine: 引擎无关操作适配器 ──────────────────────────────────────
  engine: async ({ page }, use) => {
    const { createEngine } = await import('./engineAdapter.js');
    const engine = createEngine(page);
    await use(engine);
  },

  testInfo: async ({ }, use, testInfo) => {
    await use(testInfo);
  },

  browser: async ({ }, use, testInfo) => {
    const browser = await chromium.launch(
      testInfo.project?.use?.launchOptions as any || {},
    );
    await use(browser);
    await browser.close();
  },

  page: async ({ browser }, use, testInfo) => {
    // 建 context 时带上 storageState（服务端 cookies 写入的登录态），
    // 裸 newPage() 会丢失 cookies 导致用例未登录失败。
    // global-setup 正常会先写好；直接裸跑 playwright test 时这里兜底就地生成。
    let storageState = testInfo.project?.use?.storageState as string | undefined;
    if (!storageState && readInjectedCookies().length > 0) {
      storageState = resolveStorageStatePath();
      try { writeStorageState(storageState); } catch { /* 写失败则裸跑，用例会自行暴露登录问题 */ }
    }
    // 视频录制：playwright config use.video = { mode:'on', dir } → recordVideo
    //（自定义 context 不会自动附加视频附件，需在 context 关闭后显式 attach）
    const videoOpt = (testInfo as any).project?.use?.video as any;
    const videoOn = !!videoOpt && (videoOpt === 'on' || videoOpt.mode === 'on' || videoOpt.mode === 'retain-on-failure');
    const viewport = testInfo.project?.use?.viewport;
    const context = await browser.newContext({
      storageState,
      ...(viewport ? { viewport } : {}),
      ...(videoOn ? { recordVideo: { dir: typeof videoOpt === 'object' && videoOpt.dir ? videoOpt.dir : undefined } } : {}),
    });
    const page = await context.newPage();
    await use(page);
    const video = page.video();
    await page.close();
    await context.close();
    // 视频文件在 context 关闭后才定稿：显式挂附件 → results.json attachments
    if (video) {
      try {
        const videoPath = await video.path();
        await testInfo.attach('video', { path: videoPath });
      } catch { /* 无视频不阻塞 */ }
    }
  },

  // ── keveGoal: 唯一操作原语 ────────────────────────────────────────
  keveGoal: async ({ page }, use, testInfo) => {
    let goalOrder = 0;

    const keveGoalFn = async (
      options: KeveGoalCallOptions,
      fn?: () => Promise<void>,
    ) => {
      const goalMeta: KeveGoalMeta = {
        precondition: options.precondition,
        step: options.step,
        expected: options.expected,
        order: goalOrder++,
      };
      const sceneTitle = testInfo.title;
      if (!sceneGoalsMap.has(sceneTitle)) sceneGoalsMap.set(sceneTitle, []);
      sceneGoalsMap.get(sceneTitle)!.push(goalMeta);

      const ctx: GoalContext = {
        page,
        step: options.step,
        expected: options.expected,
        precondition: options.precondition,
        order: goalMeta.order,
        testTitle: sceneTitle,
        specFilePath: testInfo.file,
      };

      // Run before aspects
      await keveAspect.runPhase('before', ctx);

      // ── Capture goal-before screenshot (fn 之前的页面原始状态) ──
      // 语义：记录"测试动作发生前"的页面，供报告 before/after 对照
      let goalScreenshotBefore = '';
      try {
        goalScreenshotBefore = await captureScreenshot(page, options.step, goalMeta.order, 'before');
      } catch { /* non-critical */ }

      let result: GoalResult;
      const fnSource = fn?.toString() || undefined;

      let fnError: string | undefined;
      let fnErrorRaw: any; // 原始错误对象（ScreenshotDiffError 等带结构的错误需要保留结构）
      let fnResult: any; // fn 返回值透传（flow 产物，如 createDashboard 的看板名）
      let fnBlocked: boolean = false; // true when fn error is environment-blocked (skip agent Re-Act)
      // 截图对比：fn 前开缓冲、fn 后收集 —— engine.expectScreenshot 的结果经此进 attachment
      beginGoalShotDiffCapture();
      if (fn) {
        try {
          fnResult = await fn();
          console.log(`[keveGoal] "${options.step}" fn executed`);
        } catch (err: any) {
          fnError = err?.message || String(err);
          fnErrorRaw = err;
          console.log(`[keveGoal] "${options.step}" fn error: ${fnError}`);
          // ── Detect environment-blocked errors: skip Agent Re-Act, directly BLOCKED ──
          // When fn fails due to empty URL, connection refused, timeout, or navigation to invalid URL,
          // Agent exploration cannot fix environment issues — waste of time and tokens.
          fnBlocked = isEnvironmentBlockedError(err);
          if (fnBlocked) {
            console.log(`[keveGoal] 🚫 "${options.step}" BLOCKED — environment error detected, skipping agent Re-Act`);
          }
          // ── Detect page-level permission block (forbidden / unauthorized) ──
          // When the page redirected to a forbidden/unauthorized URL (e.g. kwaibi /pc/dashboard/forbidden),
          // the fn error is typically a locator timeout — but the root cause is access denial,
          // not a missing element. Mark as blocked and annotate the error for accurate reporting.
          if (!fnBlocked && fnError) {
            try {
              const blockedUrl = page.url();
              if (/\/forbidden|\/unauthorized|\/403|\/no-permission/i.test(blockedUrl)) {
                fnBlocked = true;
                fnError = `页面访问被阻断（当前 URL=${blockedUrl}），目标元素未渲染 — 权限或数据问题，非用例缺陷`;
                console.log(`[keveGoal] 🚫 "${options.step}" BLOCKED — page redirected to forbidden/unauthorized: ${blockedUrl}`);
              }
            } catch { /* page.url() may fail if page is closed */ }
          }
        }
      }
      // fn 结束（无论成败）即取出本 goal 的对比结果；不再有引擎路径会往里写
      const shotDiffs = drainGoalShotDiff();

      // ── Capture fn-after screenshot (fn 执行后的页面状态，传给 agent 说明执行前后) ──
      let fnAfterScreenshot = '';
      if (fn) {
        try {
          fnAfterScreenshot = await captureScreenshot(page, options.step, goalMeta.order, 'after-fn');
        } catch { /* non-critical */ }
      }

      // ── Hand off to agent: agent does Re-Act (OR shortcut to blocked if fnBlocked) ──
      const currentUrl = page.url();
      const learnedHint = learnedActions.getHint(options.step, currentUrl);
      let reactResult: any;
      let reactTimedOut = false;

      if (fnBlocked) {
        // ── Shortcut: environment error detected in fn, skip Agent Re-Act entirely ──
        // Agent exploration cannot fix empty URLs, connection refused, or navigation failures.
        // Directly produce a blocked result with the fn error as explanation.
        reactResult = {
          expectedMet: false,
          actions: [{
            action: { tool: 'done', verdict: 'blocked', text: `Environment blocked: ${fnError}` },
            toolOutput: '',
            result: 'ok',
          }],
          finalSnapshot: '',
          agentScreenshots: [],
          conclusion: 'blocked',
        };
      } else {
        // ── Page liveness check: if fn killed the page, skip Agent Re-Act ──
        // When fn error involves page/browser close, the page is dead —
        // Agent cannot take a11y snapshots or interact. Skip immediately.
        let pageAlive = true;
        try { await page.url(); } catch { pageAlive = false; }
        if (!pageAlive) {
          console.log(`[keveGoal] 🚫 "${options.step}" BLOCKED — page is dead after fn error, skipping agent Re-Act`);
          reactResult = {
            expectedMet: false,
            actions: [{
              action: { tool: 'done', verdict: 'blocked', text: `Page closed after fn error: ${fnError}` },
              toolOutput: '',
              result: 'ok',
            }],
            finalSnapshot: '',
            agentScreenshots: [],
            conclusion: 'blocked',
          };
        } else if (fnErrorRaw instanceof ScreenshotDiffError) {
          // ── 截图对比超阈值：确定性事实，跳过 Agent Re-Act ──
          // diff 不是探索能修复的（页面就该和基线不一样才报错），探索只会烧 token；
          // 对比结果已入 shotDiffs，attachment 会带上完整差异证据。
          console.log(`[keveGoal] 📊 "${options.step}" screenshot diff exceeded — skipping agent Re-Act`);
          reactResult = {
            expectedMet: false,
            actions: [{
              action: { tool: 'done', verdict: 'fail', text: fnError },
              toolOutput: fnErrorRaw.shotDiff?.message || '',
              result: 'ok',
            }],
            finalSnapshot: '',
            agentScreenshots: [],
            conclusion: 'fail' as const,
          };
        } else {
        // ── Per-goal timeout: prevent one slow goal from exhausting the test timeout ──
        // Default 300s per goal; total test timeout should be ≥ (goals × 300s + overhead)
        const GOAL_TIMEOUT_MS = 300_000;
        const goalTimeoutController = new AbortController();
        const goalTimeout = setTimeout(() => {
          goalTimeoutController.abort();
          console.log(`[keveGoal] ⏰ "${options.step}" timed out after ${GOAL_TIMEOUT_MS}ms — stopping agent`);
        }, GOAL_TIMEOUT_MS);

        try {
          reactResult = await reactLoop(
            page,
            options.step,
            options.expected,
            {
              learnedActionsHint: learnedHint,
              specFilePath: ctx.specFilePath,
              fnSource,
              fnResult: fnError ? { error: fnError } : { success: true },
              signal: goalTimeoutController.signal,
              goalScreenshotBefore: goalScreenshotBefore || undefined,
              fnAfterScreenshot: fnAfterScreenshot || undefined,
              targetUrl: process.env.KEVE_TARGET_URL || '',
              getEnv: (name: string) => process.env[name] || '',
              saveScreenshot: saveAgentScreenshot,
              loadInitialImages: loadInitialImages,
              llm: reactLlmConfig(),
            },
          );
        } catch (reactErr: any) {
          reactTimedOut = true;
          const isGoalTimeout = goalTimeoutController.signal.aborted;
          const msg = isGoalTimeout
            ? `Goal timed out (${GOAL_TIMEOUT_MS}ms)`
            : (reactErr?.message || String(reactErr));
          console.log(`[keveGoal] reactLoop interrupted: ${msg.slice(0, 200)}`);
          reactResult = {
            expectedMet: false,
            actions: [],
            finalSnapshot: '',
            agentScreenshots: [],
            conclusion: isGoalTimeout ? 'blocked' : 'fail',
            diagnostics: undefined,
          };
        } finally {
          clearTimeout(goalTimeout);
        }
        } // end of page-alive else (agent Re-Act path)
        } // end of else (non-blocked path)

      // ── Deterministic override: fn assertion failure cannot be overridden by Agent "pass" ──
      // When fn has a hard assertion failure (Expected X, Received Y), the value mismatch
      // is a fact, not a judgment. The Agent may rationalize "consistency" (e.g. "both pages
      // show 15px, so consistent") and override to pass, but 15px ≠ 16px is a definitive failure.
      // This is the per-goal equivalent of pipeline afterHook (case-gen-validate) —
      // deterministic check > LLM judgment.
      if (fnError && !fnBlocked && reactResult.expectedMet && isAssertionFailure(fnError)) {
        console.log(`[keveGoal] ⚠️ "${options.step}" Agent said PASS but fn had assertion failure — overriding to FAIL`);
        console.log(`[keveGoal]    fn assertion: ${fnError}`);
        reactResult.expectedMet = false;
        reactResult.conclusion = 'fail';
      }

      result = {
        success: reactResult.expectedMet,
        actions: reactResult.actions,
        finalSnapshot: reactResult.finalSnapshot,
        error: reactResult.expectedMet
          ? undefined
          : reactResult.conclusion === 'blocked'
            ? new Error(`Blocked: ${fnBlocked ? fnError : (reactTimedOut ? `Agent 超时 (300000ms)` : (reactResult.actions?.filter((a: any) => a.action?.tool === 'done').pop()?.action?.text || 'Agent blocked'))}`)
            : (fnErrorRaw instanceof ScreenshotDiffError)
              ? new Error(fnError) // 截图对比：保留带差异率/区块数/基线版本的结构化错误文案
              : (fnError && isAssertionFailure(fnError) && !fnBlocked)
                ? new Error(`Assertion failed: ${fnError}`)
                : new Error(`Expected not achieved: ${options.expected}`),
      } as any;
      // Attach Agent conclusion for downstream consumers
      if (reactResult.conclusion) (result as any).conclusion = reactResult.conclusion;
      // Attach runtime diagnostics for downstream consumers (Playwright side must
      // copy them here because the attachment reads from `result`).
      if (reactResult.diagnostics) (result as any).diagnostics = reactResult.diagnostics;
      console.log(reactResult.expectedMet
        ? `[keveGoal] ✅ "${options.step}" PASSED`
        : `[keveGoal] ❌ "${options.step}" FAILED (${reactResult.conclusion || 'fail'}) — ${result.error?.message || 'expected not achieved'}`);
      // if (reactResult.refinePatch) (result as any).refinePatch = reactResult.refinePatch; // 已注释：scriptRefine 已禁用
      if (reactResult.agentScreenshots) (result as any).agentScreenshots = reactResult.agentScreenshots;

      // ── 核心：在 keveGoal 内部、throw 之前，写 attachment ──
      // AI 探索的完整数据（actions、diagnosticHint）
      // 通过 Playwright attachment 流到 KeveReporter.onTestEnd
      // 注意：screenshotBase64 不再写入 attachment（截图已保存到文件系统，路径见 goalScreenshotBefore/goalScreenshotAfter）
      const diagnosticHints = (reactResult as any).diagnosticHints || [];
      // ── goalScreenshotAfter = agent done 时的截图（done-time screenshot） ──
      // agent.ts 在 done 工具触发时截图并写入 stepEvent.screenshotPath，
      // 这里复用该路径作为 goal-after 证据（与 agent 判定时刻一致，避免状态漂移）。
      let goalScreenshotAfter = '';
      try {
        const lastActionWithShot = [...(reactResult.actions || [])]
          .reverse()
          .find((a: any) => a.screenshotPath);
        if (lastActionWithShot?.screenshotPath) {
          goalScreenshotAfter = lastActionWithShot.screenshotPath;
        }
      } catch { /* non-critical */ }
      await testInfo.attach('keveGoalResult', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({
          step: options.step,
          expected: options.expected,
          precondition: options.precondition,
          order: goalMeta.order,
          success: result.success,
          actions: (result.actions || []).map((a: any) => {
            // Derive done action conclusion reliably (4-level backoff):
            // - Level 1: step-level conclusion (from agent.ts, handles verdict/result/success/text)
            // - Level 2: a.action?.verdict (new, no schema conflict)
            // - Level 3: a.action?.result if it's a valid 3-state value
            // - Level 4: a.action?.success (legacy boolean) or text parsing
            // Do NOT use a.action?.result blindly (MacroTool schema conflict: "ok" ≠ "pass")
            const actionTool = a.action?.tool;
            let actionConclusion: string | undefined;
            if (actionTool === 'done') {
              if ((result as any).conclusion) {
                actionConclusion = (result as any).conclusion;
              } else {
                const verdict = a.action?.verdict;
                if (verdict === 'pass' || verdict === 'fail' || verdict === 'blocked') {
                  actionConclusion = verdict;
                } else {
                  const raw = a.action?.result;
                  if (raw === 'pass' || raw === 'fail' || raw === 'blocked') actionConclusion = raw;
                  else if (typeof a.action?.success === 'boolean') actionConclusion = a.action.success ? 'pass' : 'fail';
                  else {
                    // Level 4: parse text for verdict keyword (includes match, not exact)
                    // IMPORTANT: Check fail/blocked BEFORE pass to avoid "不通过" hitting "通过"
                    const tv = String(a.action?.text || '').trim().toLowerCase();
                    if (tv.includes('fail') || tv.includes('failure')
                      || tv.includes('失败') || tv.includes('未通过') || tv.includes('不通过')) actionConclusion = 'fail';
                    else if (tv.includes('blocked') || tv.includes('阻塞') || tv.includes('阻止')) actionConclusion = 'blocked';
                    else if (tv.includes('pass') || tv.includes('success') || tv.includes('ok')
                      || tv.includes('完成') || tv.includes('成功') || tv.includes('通过') || tv.includes('验证通过')) actionConclusion = 'pass';
                  }
                }
              }
            }
            return {
              tool: actionTool,
              role: a.action?.role,
              name: a.action?.name,
              url: a.action?.url,
              text: a.action?.text,
              toolOutput: a.toolOutput?.slice(0, 500),
              reason: a.action?.reason,
              success: a.action?.success,
              // Agent 3-state verdict (pass/fail/blocked) — new field, no schema conflict
              verdict: a.action?.verdict,
              // Agent 3-state conclusion (pass/fail/blocked) — reliably derived
              conclusion: actionConclusion,
              result: a.result,
              error: a.error,
              evaluation: a.evaluation?.slice(0, 300),
              memory: a.memory?.slice(0, 200),
              nextGoal: a.nextGoal?.slice(0, 200),
              screenshotPath: a.screenshotPath,
            };
          }),
          finalSnapshot: result.finalSnapshot ? String(result.finalSnapshot).slice(0, 500) : undefined,
          diagnosticHints,
          diagnostics: (result as any).diagnostics,
          goalScreenshotBefore: goalScreenshotBefore || undefined,
          goalScreenshotAfter: goalScreenshotAfter || undefined,
          // agent 未单独留图时，用 fn-after 兜底，保证报告至少有一张执行后截图。
          // 不能写 `|| [...]`：空数组是 truthy，会把兜底截图短路丢弃。
          agentScreenshots: (result as any).agentScreenshots?.length
            ? (result as any).agentScreenshots
            : (fnAfterScreenshot ? [fnAfterScreenshot] : []),
          // 截图对比证据（matched/created/exceeded 全量保留；平台 stepsDetail 回收为 evidence.screenshotDiff）
          screenshotDiff: shotDiffs.length ? shotDiffs : undefined,
          // refinePatch: (result as any).refinePatch || undefined, // 已注释：scriptRefine 已禁用
          conclusion: (result as any).conclusion || undefined,
        }), 'utf-8'),
      });

      // Run after aspects
      await keveAspect.runPhase('after', ctx, result, result.error);

      // Throw if not successful
      if (!result.success) {
        const failReason = result.error?.message || 'expected state not achieved';
        console.log(`[keveGoal] ❌ "${options.step}" FAILED — reason: ${failReason}`);
        throw result.error || new Error(`keveGoal "${options.step}" failed: ${failReason}`);
      }
      // 透传 fn 返回值：flow 辅助函数（如 createDashboard 返回看板名）可包进 keveGoal，
      // 脚本失败时由 Agent Re-Act 自愈，成功时把产物继续传给后续步骤
      return fnResult;
    };

    await use(keveGoalFn);

    // keveGoals attachment 已删除：step/expected/precondition/order 已合并进
    // keveGoalResult attachment，不再单独输出 keveGoals 附件
    // sceneGoalsMap 保留供内部分类使用
  }
});

// Register extended test with keve-decorators so @keveModel uses the correct test
import { setKeveTest } from '../core/decorator/keve-decorators.js';
setKeveTest(test);

// ── 辅助函数 ──

/**
 * 截图并保存到当前轮次的 reports/round-N，返回相对 taskDir 的路径
 * @param phase 'before' | 'after-fn' — 用于文件名前缀
 */
async function captureScreenshot(
  page: import('@playwright/test').Page,
  stepName: string,
  order: number,
  phase: 'before' | 'after-fn',
): Promise<string> {
  const buf = await page.screenshot({ type: 'png', timeout: 15000 });
  const safeName = stepName.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30);
  return writeScreenshot(buf, `goal-${phase}-${order}-${safeName}`);
}

/**
 * 当前轮次截图目录绝对路径（与 Cypress 桥同名同层）。
 * 新布局为 <taskRoot>/reports/round-N/screenshots；缺失时回退旧布局，
 * 兼容历史执行环境。
 */
function screenshotsDir(): string {
  if (process.env.KEVE_RESULT_DIR) {
    return path.join(path.resolve(process.env.KEVE_RESULT_DIR), 'screenshots');
  }
  const taskDir = process.env.KEVE_TASK_DIR || '.keve';
  const round = process.env.KEVE_ROUND || 'latest';
  return path.join(taskDir, 'test-artifacts', `round-${round}`, 'screenshots');
}

/** 落盘 PNG，返回相对 taskDir 的路径 */
function writeScreenshot(png: Buffer, baseName: string): string {
  const taskDir = process.env.KEVE_TASK_DIR || '.keve';
  const dir = screenshotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${baseName}-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  return path.relative(taskDir, file);
}

/** Agent 单步截图落盘（宿主注入给 reactLoop，与 Cypress 桥的命名同形） */
async function saveAgentScreenshot(
  pngBase64: string,
  stepIndex: number,
  stepName: string,
): Promise<string | undefined> {
  const safeName = stepName.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30);
  return writeScreenshot(Buffer.from(pngBase64, 'base64'), `agent-step${stepIndex}-${safeName}`);
}

/** 读取 goal-before / fn-after 图片，转成多模态 ContentItem（唯一注意：路径是相对 taskDir） */
async function loadInitialImages(paths: {
  goalScreenshotBefore?: string;
  fnAfterScreenshot?: string;
}): Promise<ContentItem[]> {
  const taskDir = process.env.KEVE_TASK_DIR || '.keve';
  const items: ContentItem[] = [];
  for (const [label, rel] of [
    ['goal-before', paths.goalScreenshotBefore],
    ['fn-after', paths.fnAfterScreenshot],
  ] as const) {
    if (!rel) continue;
    try {
      const file = path.isAbsolute(rel) ? rel : path.join(taskDir, rel);
      if (!fs.existsSync(file)) continue;
      const b64 = fs.readFileSync(file).toString('base64');
      items.push({ type: 'text', text: `Screenshot (${label}):` });
      items.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } } as ContentItem);
    } catch { /* 单张图读失败不影响探索 */ }
  }
  return items;
}

/** Re-Act 的 LLM 配置：优先 keve.yaml，其次进程环境变量（与 config.ts DEFAULT_CONFIG 同源） */
function reactLlmConfig(): {
  baseURL: string;
  model: string;
  apiKey?: string;
} {
  let cfg = { base_url: '', model: '', api_key: '' } as {
    base_url: string;
    model: string;
    api_key?: string;
  };
  try {
    cfg = loadConfig().llm as typeof cfg;
  } catch { /* 配置缺失时退回环境变量 */ }
  return {
    baseURL: cfg.base_url || process.env.KEVE_LLM_BASE_URL || '',
    model: cfg.model || process.env.KEVE_LLM_MODEL_NAME || process.env.KEVE_LLM_MODEL || '',
    apiKey: cfg.api_key || process.env.KEVE_LLM_API_KEY || '',
  };
}
