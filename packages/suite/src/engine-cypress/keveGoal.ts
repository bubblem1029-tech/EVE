/**
 * keveGoal — Cypress 版的唯一操作原语
 *
 * 与 Playwright 的 keveGoal fixture（core/keve-test.ts）**语义同构**：
 *   - 记录 goal 元数据到 sceneGoalsMap（报告归因用）
 *   - fn 前 / fn 后各截一张图，落盘后写进 attachment
 *   - fn 成功/失败都进入 Agent Re-Act，由观察真实页面后给最终结论；
 *     仅截图差异超阈值、环境阻断这两类确定性事实短路
 *   - 产物是 `keveGoalResult` attachment，字段与 Playwright 完全一致
 *
 * 唯一的实现差异：截图与落盘必须经 HTTP 桥（cy.task 在 async cy.then 内不可 await）。
 * 所以这里不 import 任何 Node 模块，也不 import @playwright/test。
 */

import { sceneGoalsMap, type KeveGoalMeta } from '../core/decorator/keve-registry.js';
import { keveAspect } from '../core/decorator/keve-aspect.js';
import { isAssertionFailure, isEnvironmentBlockedError, deriveActionConclusion } from '../core/judge/goal-heuristics.js';
import { beginGoalShotDiffCapture, drainGoalShotDiff, isGoalShotDiffCaptureActive } from './shotBuffer.js';
import { addAttachment, addLog, encodeAttachmentBody, nextGoalOrder, requireTestState } from './state.js';
import type { CypressEngine } from './adapter.js';
import type { RuntimeDiagnostics } from '../page-agent/diagnostics.js';

export interface KeveGoalCallOptions {
  precondition?: string;
  step: string;
  expected: string;
}

/** agent Re-Act 的结果（P0-3 接入；未接入时由 fn 结果直接判定） */
export interface CyGoalExploreResult {
  expectedMet: boolean;
  conclusion?: 'pass' | 'fail' | 'blocked';
  actions?: any[];
  finalSnapshot?: string;
  agentScreenshots?: string[];
  diagnosticHints?: string[];
  /** 运行诊断：性能、网络、浏览器错误与质量信号 */
  diagnostics?: RuntimeDiagnostics;
}

export type CyGoalExplorer = (
  options: KeveGoalCallOptions,
  ctx: {
    fnSource?: string;
    fnError?: string;
    goalScreenshotBefore?: string;
    fnAfterScreenshot?: string;
    /** 当前 spec 文件路径（探索器记录上下文用，可为空） */
    specFilePath?: string;
    testTitle?: string;
  },
) => Promise<CyGoalExploreResult | undefined>;

/** 由引擎入口注册的探索器（P0-3：Cypress 侧 AI Re-Act） */
let explorer: CyGoalExplorer | null = null;
export function setCyGoalExplorer(fn: CyGoalExplorer | null): void {
  explorer = fn;
}

export type CyKeveGoal = (options: KeveGoalCallOptions, fn?: () => Promise<any>) => Promise<any>;

/** 与 Playwright captureScreenshot 的 safeName 规则保持一致，保证两端截图文件名同形。 */
function safeStepName(step: string): string {
  return String(step || 'step').replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 30);
}

/**
 * 同时输出到 Cypress 控制台与用例日志缓冲。
 *
 * spec 内的 console.log 只留在浏览器控制台，不会进 Node 进程输出，因此
 * Playwright 报告中那条 `[keveGoal]` stdout 轨迹在 Cypress 下会整段缺失。
 * 这里双写，让 stdout 字段两端同构。
 */
function logLine(line: string): void {
  console.log(line);
  addLog(line);
}

export function createCyKeveGoal(engine: CypressEngine): CyKeveGoal {
  return async (options, fn) => {
    const state = requireTestState();
    const order = nextGoalOrder();
    const goalMeta: KeveGoalMeta = {
      precondition: options.precondition,
      step: options.step,
      expected: options.expected,
      order,
    };
    if (!sceneGoalsMap.has(state.title)) sceneGoalsMap.set(state.title, []);
    sceneGoalsMap.get(state.title)!.push(goalMeta);

    const ctx: any = {
      // Cypress 下没有 Playwright Page；探索层用 engine.rawPage() 拿 CDP 驱动
      page: engine.rawPage(),
      engine,
      step: options.step,
      expected: options.expected,
      precondition: options.precondition,
      order,
      testTitle: state.title,
      specFilePath: state.file,
    };
    await keveAspect.runPhase('before', ctx);

    // ── goal-before 截图（动作发生前的页面原始状态） ──
    let goalScreenshotBefore = '';
    try {
      goalScreenshotBefore = await engine.captureArtifact(`goal-before-${order}-${safeStepName(options.step)}`);
    } catch { /* 截图非关键路径 */ }

    let fnError: string | undefined;
    let fnErrorRaw: any;
    let fnResult: any;
    let fnBlocked = false;
    const fnSource = fn?.toString() || undefined;

    const owned = !isGoalShotDiffCaptureActive();
    if (owned) beginGoalShotDiffCapture();
    if (fn) {
      try {
        fnResult = await fn();
        logLine(`[keveGoal] "${options.step}" fn executed`);
      } catch (err: any) {
        fnError = err?.message || String(err);
        fnErrorRaw = err;
        fnBlocked = isEnvironmentBlockedError(err);
        logLine(`[keveGoal] "${options.step}" fn error: ${fnError}`);
        // 页面级权限阻断：fn 报的是定位失败，根因是访问被拒 → 按 blocked 归因
        if (!fnBlocked && fnError) {
          try {
            const blockedUrl = await engine.currentUrl();
            if (/\/forbidden|\/unauthorized|\/403|\/no-permission/i.test(blockedUrl)) {
              fnBlocked = true;
              fnError = `页面访问被阻断（当前 URL=${blockedUrl}），目标元素未渲染 — 权限或数据问题，非用例缺陷`;
            }
          } catch { /* URL 读不到则保持原错误 */ }
        }
      }
    }
    const shotDiffs = owned ? drainGoalShotDiff() : [];

    // ── fn-after 截图（执行后的页面状态） ──
    let fnAfterScreenshot = '';
    if (fn) {
      try {
        fnAfterScreenshot = await engine.captureArtifact(`goal-after-fn-${order}-${safeStepName(options.step)}`);
      } catch { /* 非关键 */ }
    }

    // ── 判定 ──
    let reactResult: CyGoalExploreResult;
    if (fnBlocked) {
      reactResult = {
        expectedMet: false,
        conclusion: 'blocked',
        actions: [{
          action: { tool: 'done', verdict: 'blocked', text: `Environment blocked: ${fnError}` },
          toolOutput: '',
          result: 'ok',
        }],
        agentScreenshots: [],
      };
      console.log(`[keveGoal] 🚫 "${options.step}" BLOCKED — 环境错误，跳过 Agent Re-Act`);
    } else if (fnErrorRaw?.name === 'ScreenshotDiffError') {
      reactResult = {
        expectedMet: false,
        conclusion: 'fail',
        actions: [{
          action: { tool: 'done', verdict: 'fail', text: fnError },
          toolOutput: fnErrorRaw.shotDiff?.message || '',
          result: 'ok',
        }],
        agentScreenshots: [],
      };
      console.log(`[keveGoal] 📊 "${options.step}" 截图差异超阈值 — 确定性失败`);
    } else {
      // fn 成功 / 失败都交给评测器。fn 只是前置动作与确定性校验：
      //  - fn 成功 ≠ expected 达成（fn 可能只覆盖预期的一个子集）；
      //  - fn 失败 ≠ 不可恢复（普通运行时错误下页面可能仍可探索自愈）。
      // 「先评测、再决定放行还是探索」由这一轮承担：Agent 先观察真实页面评测
      // expected，达成即 done(pass) 放行，未达成再继续探索。
      let explored: CyGoalExploreResult | undefined;
      if (explorer) {
        try {
          logLine(fnError
            ? `[keveGoal] 🤖 "${options.step}" fn failed — entering Agent Re-Act`
            : `[keveGoal] 🤖 "${options.step}" fn succeeded — entering Agent Re-Act for final verdict`);
          explored = await explorer(options, {
            fnSource,
            fnError,
            goalScreenshotBefore: goalScreenshotBefore || undefined,
            fnAfterScreenshot: fnAfterScreenshot || undefined,
            specFilePath: state.file || undefined,
            testTitle: state.title,
          });
        } catch (err: any) {
          // Cypress 下浏览器控制台不回流 Node stdout，必须同时写用例日志，否则
          // 探索层异常在 CI 里完全不可见（报告只剩一个没有归因的 fail）。
          logLine(`[keveGoal] ⚠️ "${options.step}" 探索异常：${err?.message || err}`);
        }
      } else {
        logLine(`[keveGoal] ℹ️ "${options.step}" 未注册探索器，跳过 Agent Re-Act`);
      }
      reactResult = explored || {
        expectedMet: false,
        conclusion: isAssertionFailure(fnError) ? 'fail' : 'fail',
        actions: [{
          action: { tool: 'done', verdict: 'fail', text: fnError },
          toolOutput: '',
          result: 'ok',
        }],
        agentScreenshots: [],
      };
    }

    // ── 确定性覆盖：fn 断言失败不允许被 Agent 判成 pass ──
    if (fnError && !fnBlocked && reactResult.expectedMet && isAssertionFailure(fnError)) {
      console.log(`[keveGoal] ⚠️ "${options.step}" Agent 判 PASS 但 fn 断言失败 — 覆盖为 FAIL`);
      reactResult.expectedMet = false;
      reactResult.conclusion = 'fail';
    }

    const conclusion = reactResult.expectedMet ? 'pass' : (reactResult.conclusion || 'fail');
    const success = reactResult.expectedMet;
    const errorMessage = success
      ? undefined
      : conclusion === 'blocked'
        ? `Blocked: ${fnBlocked ? fnError : (reactResult.actions || []).filter((a: any) => a.action?.tool === 'done').pop()?.action?.text || 'Agent blocked'}`
        : fnErrorRaw?.name === 'ScreenshotDiffError'
          ? fnError
          : fnError && isAssertionFailure(fnError)
            ? `Assertion failed: ${fnError}`
            : `Expected not achieved: ${options.expected}`;
    // 与 Playwright keve-test.ts 的终局日志同形，保证两端执行轨迹可逐行对照
    logLine(success
      ? `[keveGoal] ✅ "${options.step}" PASSED`
      : `[keveGoal] ❌ "${options.step}" FAILED (${conclusion}) — ${errorMessage}`);

    // ── goal-after：优先取 agent done 时刻的截图，否则用 fn-after ──
    let goalScreenshotAfter = '';
    try {
      const lastWithShot = [...(reactResult.actions || [])].reverse().find((a: any) => a.screenshotPath);
      if (lastWithShot?.screenshotPath) goalScreenshotAfter = String(lastWithShot.screenshotPath);
    } catch { /* 非关键 */ }

    const goalResultPayload = {
      step: options.step,
      expected: options.expected,
      precondition: options.precondition,
      order,
      success,
      actions: (reactResult.actions || []).map((a: any) => ({
        tool: a.action?.tool,
        role: a.action?.role,
        name: a.action?.name,
        url: a.action?.url,
        text: a.action?.text,
        toolOutput: typeof a.toolOutput === 'string' ? a.toolOutput.slice(0, 500) : undefined,
        reason: a.action?.reason,
        success: a.action?.success,
        verdict: a.action?.verdict,
        conclusion: deriveActionConclusion(reactResult.conclusion, a.action),
        result: a.result,
        error: a.error,
        evaluation: typeof a.evaluation === 'string' ? a.evaluation.slice(0, 300) : undefined,
        memory: typeof a.memory === 'string' ? a.memory.slice(0, 200) : undefined,
        nextGoal: typeof a.nextGoal === 'string' ? a.nextGoal.slice(0, 200) : undefined,
        screenshotPath: a.screenshotPath,
      })),
      finalSnapshot: reactResult.finalSnapshot ? String(reactResult.finalSnapshot).slice(0, 500) : undefined,
      diagnosticHints: reactResult.diagnosticHints || [],
      diagnostics: reactResult.diagnostics,
      goalScreenshotBefore: goalScreenshotBefore || undefined,
      goalScreenshotAfter: goalScreenshotAfter || undefined,
      // 注意不能写成 `|| [...]`：空数组是 truthy，会把 fn-after 兜底截图短路丢弃。
      agentScreenshots: reactResult.agentScreenshots?.length
        ? reactResult.agentScreenshots
        : (fnAfterScreenshot ? [fnAfterScreenshot] : []),
      screenshotDiff: shotDiffs.length ? shotDiffs : undefined,
      conclusion,
    };

    addAttachment({
      name: 'keveGoalResult',
      contentType: 'application/json',
      // base64 编码：与 Playwright JSON reporter 的 attachment body 序列化格式一致
      body: encodeAttachmentBody(JSON.stringify(goalResultPayload)),
    });

    const result: any = {
      success,
      conclusion,
      actions: reactResult.actions || [],
      finalSnapshot: reactResult.finalSnapshot,
      error: success ? undefined : new Error(errorMessage),
    };
    await keveAspect.runPhase('after', ctx, result, result.error);

    if (!success) throw result.error || new Error(`keveGoal "${options.step}" failed`);
    return fnResult;
  };
}
