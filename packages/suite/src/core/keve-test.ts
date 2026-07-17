/**
 * keve-test — Playwright test fixture: keveGoal (唯一操作原语)
 *
 * keveGoal 执行 fn 后 → 截图+fn逻辑+expected → AI判断是否一致
 *   一致     → 通过
 *   不一致   → AI 告诉你还差什么 → Re-Act 探索 → 探索成功
 *   fn 无    → Re-Act 直接探索
 *   fn 异常  → Re-Act 自愈
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
import { sceneGoalsMap, type KeveGoalMeta } from './keve-registry';
import { reactLoop } from '../page-agent/agent';
import { keveAspect, type GoalContext, type GoalResult } from './keve-aspect';
import { learnedActions } from './learned-actions';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── CDP Mode ──────────────────────────────────────────────────────
// CDP 连接逻辑已移到 global-setup.ts，通过全局变量共享 Browser 对象
import { isCdpMode, getCdpBrowser } from './global-setup';

export { expect };
export { keveModel, keveScene, getModelScenes } from './keve-decorators';
export type { KeveSceneMeta } from './keve-decorators';
export { sceneCodeMap, sceneEvalMetaMap } from './keve-registry';
export type { KeveEvalMeta, ErrorCategory } from './keve-registry';

// Re-export goal metadata for consumer convenience
export { sceneGoalsMap, type KeveGoalMeta } from './keve-registry';

// ─── Types ──────────────────────────────────────────────────────────

export interface KeveGoalCallOptions {
  precondition?: string;
  step: string;
  expected: string;
}

type KeveFixture = {
  keveGoal: (options: KeveGoalCallOptions, fn?: () => Promise<void>) => Promise<void>;
  keveReadDoc: (url: string, options?: { noImages?: boolean; outputPath?: string }) => Promise<any>;
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
    if (!result?.actions?.length || !result.success) return;
    learnedActions.add(ctx.step, result.actions as any[]);
  },
});

// ─── (diagnostic extraction moved to page-agent/diagnostic.ts, called via onAfterTask hook) ──

// ─── Fixture ────────────────────────────────────────────────────────

export const test = base.extend<KeveFixture>({
  browser: async ({ }, use, testInfo) => {
    if (isCdpMode()) {
      const browser = await getCdpBrowser(); // 复用全局共享的 CDP browser
      await use(browser);
      // CDP 模式下不关闭浏览器（共享连接，关闭会影响后续用例）
    } else {
      const browser = await chromium.launch(
        testInfo.project?.use?.launchOptions as any || {},
      );
      await use(browser);
      await browser.close();
    }
  },

  page: async ({ browser }, use) => {
    if (isCdpMode()) {
      const contexts = browser.contexts();
      const cdpContext = contexts.length > 0 ? contexts[0] : await browser.newContext();
      // CDP 模式：优先复用已有 page（保留登录状态），仅在无可用 page 时新开
      const existingPages = cdpContext.pages();
      let page;
      if (existingPages.length > 0) {
        // 复用第一个非 about:blank 的 page（通常是用户已登录的 tab）
        page = existingPages.find(p => p.url() !== 'about:blank') || existingPages[0];
        // 导航到 about:blank 作为起始页（清空之前的状态，但保留 cookie）
        try { await page.goto('about:blank', { timeout: 3000 }); } catch { /* ignore */ }
      } else {
        page = await cdpContext.newPage();
      }
      await use(page);
      // CDP 模式下不关闭 page（保留浏览器 tab 给下一个用例复用）
    } else {
      const page = await browser.newPage();
      await use(page);
      await page.close();
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
      if (fn) {
        try {
          await fn();
          console.log(`[keveGoal] "${options.step}" fn executed`);
        } catch (err: any) {
          fnError = err?.message || String(err);
          console.log(`[keveGoal] "${options.step}" fn error: ${fnError}`);
        }
      }

      // ── Capture fn-after screenshot (fn 执行后的页面状态，传给 agent 说明执行前后) ──
      let fnAfterScreenshot = '';
      if (fn) {
        try {
          fnAfterScreenshot = await captureScreenshot(page, options.step, goalMeta.order, 'after-fn');
        } catch { /* non-critical */ }
      }

      // ── Hand off to agent: agent does Re-Act ──
      const learnedHint = learnedActions.getHint(options.step);
      let reactResult: any;
      let reactTimedOut = false;

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
        };
      } finally {
        clearTimeout(goalTimeout);
      }
      result = {
        success: reactResult.expectedMet,
        actions: reactResult.actions,
        finalSnapshot: reactResult.finalSnapshot,
        error: reactResult.expectedMet
          ? undefined
          : reactResult.conclusion === 'blocked'
            ? new Error(`Blocked: ${reactTimedOut ? `Agent 超时 (${GOAL_TIMEOUT_MS}ms)` : (reactResult.actions?.filter((a: any) => a.action?.tool === 'done').pop()?.action?.text || 'Agent blocked')}`)
            : new Error(`Expected not achieved: ${options.expected}`),
      } as any;
      // Attach Agent conclusion for downstream consumers
      if (reactResult.conclusion) (result as any).conclusion = reactResult.conclusion;
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
          goalScreenshotBefore: goalScreenshotBefore || undefined,
          goalScreenshotAfter: goalScreenshotAfter || undefined,
          agentScreenshots: (result as any).agentScreenshots || [],
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
    };

    await use(keveGoalFn);

    // keveGoals attachment 已删除：step/expected/precondition/order 已合并进
    // keveGoalResult attachment，不再单独输出 keveGoals 附件
    // sceneGoalsMap 保留供内部分类使用
  }
});

// Register extended test with keve-decorators so @keveModel uses the correct test
import { setKeveTest } from './keve-decorators';
setKeveTest(test);

// ── 辅助函数 ──

/**
 * 截图并保存到 test-artifacts，返回相对 taskDir 的路径
 * @param phase 'before' | 'after-fn' — 用于文件名前缀
 */
async function captureScreenshot(
  page: import('@playwright/test').Page,
  stepName: string,
  order: number,
  phase: 'before' | 'after-fn',
): Promise<string> {
  const buf = await page.screenshot({ type: 'png', timeout: 15000 });
  const taskDir = process.env.KEVE_TASK_DIR || '.keve';
  const round = process.env.KEVE_ROUND || 'latest';
  const screenshotsDir = path.join(taskDir, 'test-artifacts', `round-${round}`, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const safeName = stepName.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30);
  const file = path.join(screenshotsDir, `goal-${phase}-${order}-${safeName}-${Date.now()}.png`);
  fs.writeFileSync(file, buf);
  return path.relative(taskDir, file);
}
