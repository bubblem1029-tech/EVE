/**
 * reporter — Cypress 侧结果收集
 *
 * Cypress 没有 Playwright 那种「进程内 Reporter」能直接拿到 TestCase/TestResult；
 * 这里用全局 afterEach 捞出当前用例的状态，经 HTTP 桥送回 Node 落盘。
 *
 * 落盘形态与 Playwright 完全一致：
 *   - confidence-data.jsonl：由 core/confidence.ts 的分类逻辑生成（同源）
 *   - test-results.json：Playwright JSON reporter 的结构（bridge 内合成）
 *   - report-data.json：同一份 generateReportData 汇总
 *
 * Mocha 的 afterEach 拿不到「用例耗时」的精确起点，这里用 beginTestState 的
 * 时间戳兜底；Cypress 的 `this.currentTest.duration` 在有值时优先。
 */

import { createBridge } from './adapter.js';
import { endTestState, getTestState } from './state.js';

/** 从 Mocha 的 currentTest 里取错误文案（Cypress 会把失败信息挂在不同字段） */
function extractError(test: any): string | undefined {
  if (!test) return undefined;
  const err = test.err;
  if (!err) return undefined;
  return String(err.message || err.stack || err);
}

function mapStatus(test: any): 'passed' | 'failed' | 'skipped' | 'timedOut' {
  const state = String(test?.state || '');
  if (state === 'passed') return 'passed';
  if (state === 'pending') return 'skipped';
  if (test?.timedOut) return 'timedOut';
  return 'failed';
}

/**
 * suite 标题 = @keveModel 注册时的 describe 标题（`M_SG90061: …`）。
 *
 * Cypress 12 的 Mocha Test 上**没有** `titlePath`（探针实测 ownKeys 无此字段），
 * 只能沿 `parent` 链向上收集，取最靠近用例的那个非 root 祖先标题 —— 语义等价于
 * Playwright `suitePath` 的末段，reportData.buildCaseResultMap 就是按末段取模块名。
 */
function suiteTitleOf(test: any): string {
  const titles: string[] = [];
  let node = test?.parent;
  while (node && !node.root) {
    if (node.title) titles.push(String(node.title));
    node = node.parent;
  }
  return titles.length ? titles[titles.length - 1] : '';
}

let installed = false;

/**
 * 安装结果收集钩子。
 * 需要在场景注册之前调用（与 installCypressHost 同一时机），保证 afterEach
 * 能拿到装饰器执行过程中写入 state 的附件。
 */
export function installCypressReporter(): void {
  if (installed) return;
  installed = true;

  const c = (globalThis as any).Cypress;
  const afterEach = c?.afterEach || (globalThis as any).afterEach;
  if (typeof afterEach !== 'function') {
    throw new Error('[cypress-engine] 未找到 afterEach：本模块只能在 Cypress spec 中运行');
  }

  // 注册在根级：Cypress 会先跑 suite 内的 afterEach（场景 afterHook），最后跑根级；
  // 因此这里能拿到装饰器执行期间写入的全部附件。
  afterEach(function (this: any) {
    const test = this.currentTest;
    if (!test) return;
    const state = getTestState();
    const suiteTitle = suiteTitleOf(test);
    const title = state?.title || '';
    // 只认 @keveScene 注册的用例：state 必须存在且标题形如 `S90061: 描述`。
    // 注意不能退化成看 suite 标题前缀 —— Cypress 在 hook 失败时也会跑根级 afterEach，
    // 那时 suite 名仍是 `M_` 开头，会把 hook 误收成一条空用例（state.title 为空）。
    if (!state || !/^[A-Z][A-Z0-9_]*\d*:/.test(title)) return;

    const rawStatus = mapStatus(test);
    // 应用侧未捕获异常已被 Cypress 放行（return false），不会中断测试执行；
    // 最终状态仍以 Cypress 的真实用例结果为准。通过用例不因页面运行时噪音
    // 显示失败，失败用例再把未捕获异常合并进错误文本做根因补充。
    const uncaughtErrors = state?.uncaughtErrors || [];
    const status = rawStatus;
    const testError = rawStatus === 'passed' || rawStatus === 'skipped' ? undefined : extractError(test);
    const error = uncaughtErrors.length && rawStatus !== 'passed' && rawStatus !== 'skipped'
      ? [...uncaughtErrors, testError || ''].filter(Boolean).join('\n')
      : testError;
    const record = {
      title,
      suiteTitle,
      file: state?.file || '',
      status,
      duration: Number(test.duration || 0),
      startTime: new Date(Date.now() - Number(test.duration || 0)).toISOString(),
      error,
      logs: state?.logs || [],
      uncaughtErrors,
      attachments: state?.attachments || [],
    };
    endTestState();

    // 必须 return Cypress 链：这样 Cypress 会等请求真正返回后才结束该 hook，
    // 保证 after:run（Node 侧 finalize）读到的是完整结果集。
    // 注意不能用 `await cy.xxx()`，只能用返回链的形态。
    // 注意：这里必须是命令链 `cy.wrap`，不是运行时对象 `Cypress.wrap`（不存在）。
    const chain = (globalThis as any).cy;
    if (!chain || typeof chain.wrap !== 'function') {
      console.error(`[cypress-engine] 结果落盘失败（${record.title}）：未找到 cy 命令链`);
      return;
    }
    return chain.wrap(null, { log: false }).then({ timeout: 60_000 }, async () => {
      try {
        const out = await createBridge().post('/report/test', record);
        if (!out?.ok) throw new Error(out?.error || 'unknown');
      } catch (err: any) {
        console.error(`[cypress-engine] 结果落盘失败（${record.title}）：${err?.message || err}`);
      }
    });
  });
}
