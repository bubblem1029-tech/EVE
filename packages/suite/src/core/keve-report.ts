/**
 * keve-report: Playwright Reporter that collects test execution data
 *
 * After EACH test completes (onTestEnd), records test result metadata
 * including step results, error category, AI exploration steps, and diagnostics.
 * Results are appended to confidence-data.jsonl (one line per test).
 *
 * After ALL tests complete (onEnd), generates report-data.json directly,
 * eliminating the need for a separate `keve report` command.
 *
 * Usage in playwright config:
 *   reporter: [
 *     ['list'],
 *     ['@kkeve/suite/keve-report'],
 *   ]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Reporter, TestCase, TestResult, FullResult, FullConfig, Suite } from '@playwright/test/reporter';
import { parseKeveAsserts, parseKeveScreenshots } from './generateReport/reportData';
import { sceneGoalsMap, type ErrorCategory } from './keve-registry';
import { generateReportData } from './generateReport/reportData';

// Error classification patterns (duplicated from keve-decorators.ts for onTestEnd primary classification)
const ENV_ERROR_PATTERNS = /timeout|timed out|locator.*not found|navigation.*intercepted|net::|ERR_|authenticate|redirect|ECONNREFUSED|socket hang up|Cannot navigate to invalid URL|Protocol error.*Page\.navigate/i;

// ── keveGoalResult attachment 的类型（合并后统一步骤） ──────────────────

interface StepResultAttachment {
  step: string;
  expected: string;
  precondition?: string;
  order: number;
  success: boolean;
  conclusion?: 'pass' | 'fail' | 'blocked';
  actions: Array<{
    tool?: string;
    role?: string;
    name?: string;
    url?: string;
    text?: string;
    reason?: string;
    success?: boolean;
    conclusion?: 'pass' | 'fail' | 'blocked';
    result?: string;
    error?: string;
    evaluation?: string;
    memory?: string;
    nextGoal?: string;
    screenshotPath?: string;
  }>;
  finalSnapshot?: string;
  diagnosticHints: string[];
  goalScreenshotBefore?: string;
  goalScreenshotAfter?: string;
  agentScreenshots?: string[];
  // refinePatch?: string; // 已注释：scriptRefine 已禁用
}

class KeveReporter implements Reporter {
  private outputPath: string = '';
  private resultDir: string = '';

  onBegin(config: FullConfig, suite: Suite) {
    // Resolve resultDir: taskDir/test-artifacts/round-N (matches Playwright config)
    const taskDir = process.env.KEVE_TASK_DIR || '.keve';
    const round = process.env.KEVE_ROUND || 'latest';
    this.resultDir = path.join(taskDir, 'test-artifacts', `round-${round}`);
    this.outputPath = path.join(this.resultDir, 'confidence-data.jsonl');

    if (!fs.existsSync(this.resultDir)) {
      fs.mkdirSync(this.resultDir, { recursive: true });
    }

    console.log(`[keve-reporter] Confidence evaluation will be saved to: ${this.outputPath}`);
  }

  // Confidence values by errorCategory — gives meaningful scores instead of always 0
  private static CONFIDENCE_MAP: Record<string, number> = {
    pass: 100,       // 测试通过，确定性最高
    script: 95,      // 脚本代码错误，结果确定性高
    visual: 80,      // 视觉断言已评估，置信度较高
    'text-mismatch': 70, // UI文案格式不匹配（功能逻辑正确，文案措辞变了）
    assert: 50,      // Playwright 断言失败，需人工确认
    'react-fail': 40, // AI 探索未达预期，需人工确认
    env: 0,          // 环境问题，测试结果不可信
    unknown: 0,       // 未知异常，无参考价值
  };

  async onTestEnd(test: TestCase, result: TestResult) {
    // ── Step 0: Extract Agent conclusion from keveGoalResult attachments ──
    const steps = parseSteps(result.attachments);
    const agentConclusion = extractAgentConclusion(steps);

    // Error classification: Agent conclusion takes priority over fnError
    let effectiveCategory: ErrorCategory = 'unknown';
    let skipAI = false;
    let classifiedMessage = '';

    if (result.status === 'skipped') {
      skipAI = true;
      effectiveCategory = 'unknown';
    } else if (result.status === 'passed') {
      effectiveCategory = 'pass';
    } else if (agentConclusion) {
      // ── Agent provided a conclusion — use it directly (most reliable) ──
      classifiedMessage = agentConclusion.text.substring(0, 500);
      if (agentConclusion.result === 'pass') {
        // Agent said pass but test still failed → fn script issue (not env)
        effectiveCategory = 'pass'; skipAI = true;
      } else if (agentConclusion.result === 'blocked') {
        effectiveCategory = 'env'; skipAI = true;
      } else {
        // Agent said fail → assert/text-mismatch depending on diagnostic hints
        const hint = buildDiagnosticHint(result.attachments);
        if (hint && (hint.includes('实际显示') || hint.includes('页面实际') || hint.includes('而非预期'))) {
          effectiveCategory = 'text-mismatch'; skipAI = false;
        } else {
          effectiveCategory = 'assert'; skipAI = false;
        }
      }
    } else if (result.error) {
      // ── No Agent conclusion — fall back to fnError classification ──
      const rawError = result.error.message || String(result.error);
      classifiedMessage = rawError.substring(0, 500);

      // 1. 脚本错误：确定性短路
      const err = result.error;
      if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) {
        effectiveCategory = 'script'; skipAI = true;
      }
      // 2. 视觉断言失败（keveAssert 抛出的特定错误）
      else if (rawError.includes('视觉断言失败')) {
        effectiveCategory = 'visual'; skipAI = true;
      }
      // 3. Playwright expect 断言失败
      else if (rawError.includes('expect(') || err?.constructor?.name === 'AssertionError' || (err as any)?.name === 'AssertionError') {
        effectiveCategory = 'assert'; skipAI = false;
      }
      // 4. 环境/基础设施错误
      else if (ENV_ERROR_PATTERNS.test(rawError.substring(0, 300))) {
        effectiveCategory = 'env'; skipAI = true;
      }
      // 5. Re-Act loop 失败：AI 探索未达到预期（关键分类）
      else if (rawError.includes('Re-Act loop did not achieve') || rawError.includes('Expected not achieved after agent explore')) {
        effectiveCategory = 'react-fail'; skipAI = false;
      }
      // 5.5 文案不匹配
      else if (rawError.includes('Expected not achieved')) {
        const hint = buildDiagnosticHint(result.attachments);
        if (hint && (hint.includes('实际显示') || hint.includes('页面实际'))) {
          effectiveCategory = 'text-mismatch'; skipAI = false;
        } else {
          effectiveCategory = 'react-fail'; skipAI = false;
        }
      }
      // 6. 兜底
      else {
        effectiveCategory = 'unknown'; skipAI = true;
      }
    }
    // Script/visual/env error short-circuit — skip AI evaluation
    if (skipAI) {
      const thought = effectiveCategory === 'script'
        ? `脚本本身存在代码错误(${classifiedMessage})，测试结果无效`
        : effectiveCategory === 'env'
          ? `环境/基础设施异常(${classifiedMessage})，非应用功能问题`
          : effectiveCategory === 'visual'
            ? `视觉断言失败(${classifiedMessage})，已由keveAssert评估`
            : effectiveCategory === 'unknown'
              ? `无法分类的异常(${classifiedMessage})，跳过AI评估`
              : effectiveCategory === 'pass'
                ? `Agent判定通过但fn脚本执行失败(${classifiedMessage})，脚本需修复`
                : '用例被跳过';
      // AI评估列显示"跳过"（表示AI未参与评估），而非"不通过"
      const aiData = (effectiveCategory !== 'assert' && effectiveCategory !== 'react-fail' && effectiveCategory !== 'text-mismatch') ? '跳过' : '不通过';
      const keveScreenshots = parseKeveAsserts(result.attachments).map(ka => ka.label);
      this.appendRecord({
        title: test.title,
        data: aiData,
        confidence: KeveReporter.CONFIDENCE_MAP[effectiveCategory] ?? 0,
        thought,
        errorCategory: effectiveCategory,
        ...(keveScreenshots.length > 0 ? { keveScreenshots } : {}), // 仅非空时写入
        steps,
        diagnosticHint: buildDiagnosticHint(result.attachments),
      });
      console.log(`[keve-reporter] ${test.title}: SHORT-CIRCUIT skipAI (category=${effectiveCategory})`);
      return;
    }

    // Record result without AI confidence evaluation
    const keveScreenshots = parseKeveAsserts(result.attachments).map(ka => ka.label);
    this.appendRecord({
      title: test.title,
      data: result.status === 'passed' ? '通过' : '不通过',
      confidence: KeveReporter.CONFIDENCE_MAP[effectiveCategory] ?? 0,
      thought: '',
      errorCategory: effectiveCategory,
      ...(keveScreenshots.length > 0 ? { keveScreenshots } : {}),
      steps,
      diagnosticHint: buildDiagnosticHint(result.attachments),
    });
    console.log(`[keve-reporter] ${test.title}: ${result.status} (category=${effectiveCategory})`);
  }

  async onEnd(result: FullResult) {
    console.log(`[keve-reporter] All tests completed. Generating report-data.json...`);

    // ── 直接生成 report-data.json（不再需要 keve report 命令） ──
    try {
      const taskDir = process.env.KEVE_TASK_DIR || '.keve';
      const projectRoot = taskDir;

      // 找到 test-results.json（Playwright JSON Reporter 写入）
      const testResultsPath = path.join(this.resultDir, 'test-results.json');
      const confidencePath = this.outputPath;

      if (fs.existsSync(testResultsPath) && fs.existsSync(confidencePath)) {
        // YAML 用例文件在 {taskDir}/cases/test-cases.yaml
        const casesYamlPath = path.join(taskDir, 'cases', 'test-cases.yaml');
        const reportData = await generateReportData({
          projectRoot,
          resultsPath: testResultsPath,
          confidencePath,
          casesPath: fs.existsSync(casesYamlPath) ? casesYamlPath : undefined,
        });

        // 写入 report-data.json
        const reportDataPath = path.join(this.resultDir, 'report-data.json');
        fs.writeFileSync(reportDataPath, JSON.stringify(reportData, null, 2));

        // 更新 latest 目录 → symlink 指向最新 round（避免重复拷贝 34MB+）
        const latestDir = path.join(taskDir, 'test-artifacts', 'latest');
        if (latestDir !== this.resultDir) {
          try {
            if (fs.existsSync(latestDir)) {
              const stat = fs.lstatSync(latestDir);
              if (stat.isSymbolicLink()) {
                fs.unlinkSync(latestDir);
              } else {
                fs.rmSync(latestDir, { recursive: true, force: true });
              }
            }
            fs.symlinkSync(path.basename(this.resultDir), latestDir, 'junction');
          } catch { /* ignore latest symlink error */ }
        }

        console.log(`[keve-reporter] report-data.json generated at: ${reportDataPath}`);
      } else {
        console.log(`[keve-reporter] Skipped report-data.json generation (missing test-results.json or confidence-data.jsonl)`);
      }
    } catch (err: any) {
      console.error(`[keve-reporter] Failed to generate report-data.json: ${err.message}`);
    }
  }


  private appendRecord(record: any): void {
    // 清洗 steps：移除 screenshotBase64（截图已有文件路径保存）
    // 移除 snapshotPreview / finalSnapshot（冗余大字段，截图路径可获取相同信息）
    if (record.steps) {
      record.steps = record.steps.map((step: any) => {
        const { screenshotBase64, finalSnapshot, ...stepRest } = step;
        if (stepRest.actions) {
          stepRest.actions = stepRest.actions.map((a: any) => {
            const { snapshotPreview, ...actionRest } = a;
            return actionRest;
          });
        }
        return stepRest;
      });
    }
    fs.appendFileSync(this.outputPath, JSON.stringify(record) + '\n');
  }
}

// ── 解析 keveGoalResult attachment（合并后统一步骤数据） ──────────────

/** Parse all keveGoalResult attachments into a unified steps array */
function parseSteps(attachments: TestResult['attachments']): StepResultAttachment[] {
  const results: StepResultAttachment[] = [];
  for (const att of attachments) {
    if (att.name !== 'keveGoalResult' || !att.body) continue;
    try {
      let jsonStr: string;
      if (typeof att.body === 'string') {
        // Playwright JSON Reporter may base64-encode Buffer bodies
        try {
          jsonStr = Buffer.from(att.body, 'base64').toString('utf-8');
          JSON.parse(jsonStr); // validate it's JSON
        } catch {
          jsonStr = att.body; // fallback: treat as raw JSON string
        }
      } else {
        jsonStr = att.body.toString('utf-8');
      }
      results.push(JSON.parse(jsonStr));
    } catch { /* skip malformed attachment */ }
  }
  return results;
}

/** Extract Agent conclusion (result + text) from keveGoalResult steps */
function extractAgentConclusion(steps: StepResultAttachment[]): { result: 'pass' | 'fail' | 'blocked'; text: string } | undefined {
  // Walk steps in reverse to find the most recent conclusion
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    // Step-level conclusion (from agent.ts buildResult → keveGoalResult attachment)
    if (step.conclusion) {
      // Find the done action text for context
      const doneAction = step.actions?.find(a => a.tool === 'done');
      return { result: step.conclusion, text: doneAction?.text || '' };
    }
    // Action-level conclusion (from done action's 'result' field)
    if (step.actions) {
      for (let j = step.actions.length - 1; j >= 0; j--) {
        const action = step.actions[j];
        if (action?.tool === 'done' && action?.conclusion) {
          return { result: action.conclusion, text: action.text || '' };
        }
      }
    }
  }
  return undefined;
}

/** Build diagnosticHint from keveGoalResult attachments (primary) + fallback to keveDiagnosticHint */
function buildDiagnosticHint(attachments: TestResult['attachments']): string | undefined {
  // 优先从 keveGoalResult 中提取 diagnosticHints
  const goalResults = parseSteps(attachments);
  const allHints: string[] = [];
  for (const gr of goalResults) {
    if (gr.success) continue;
    if (gr.diagnosticHints?.length) {
      allHints.push(...gr.diagnosticHints);
    }
  }
  if (allHints.length) return allHints.join('；');

  // 兜底：从旧的 keveDiagnosticHint attachment 提取
  const hint = attachments.find(a => a.name === 'keveDiagnosticHint');
  if (!hint || !hint.body) return undefined;
  try {
    const data = typeof hint.body === 'string' ? JSON.parse(hint.body) : JSON.parse(hint.body.toString('utf-8'));
    return data.hints?.join('；') || undefined;
  } catch {
    return undefined;
  }
}

export default KeveReporter;
