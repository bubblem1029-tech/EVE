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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Reporter, TestCase, TestResult, FullResult, FullConfig, Suite } from '@playwright/test/reporter';
import { generateReportData } from '../core/generateReport/reportData.js';
import {
  buildConfidenceRecord,
  parseStepsFromAttachments,
  sanitizeRecord,
  type ConfidenceRecord,
  type StepResultAttachment,
} from '../core/judge/confidence.js';

class KeveReporter implements Reporter {
  private outputPath: string = '';
  private resultDir: string = '';

  onBegin(config: FullConfig, suite: Suite) {
    // Resolve resultDir: 优先 runner 注入的 KEVE_RESULT_DIR（<taskRoot>/reports/round-N），
    // 缺失时回退旧布局 taskDir/test-artifacts/round-N。
    const taskDir = process.env.KEVE_TASK_DIR || '.keve';
    const round = process.env.KEVE_ROUND || 'latest';
    this.resultDir = process.env.KEVE_RESULT_DIR
      ? path.resolve(process.env.KEVE_RESULT_DIR)
      : path.join(taskDir, 'test-artifacts', `round-${round}`);
    this.outputPath = path.join(this.resultDir, 'confidence-data.jsonl');

    if (!fs.existsSync(this.resultDir)) {
      fs.mkdirSync(this.resultDir, { recursive: true });
    }

    console.log(`[keve-reporter] Confidence evaluation will be saved to: ${this.outputPath}`);
  }

  async onTestEnd(test: TestCase, result: TestResult) {
    // 分类逻辑统一收敛在 core/confidence.ts，Cypress 侧复用同一实现，避免两端报告漂移
    const { record, log } = buildConfidenceRecord({
      title: test.title,
      status: result.status,
      error: result.error ? { message: result.error.message || String(result.error), name: (result.error as any)?.name } : null,
      steps: parseStepsFromAttachments(result.attachments),
      attachments: result.attachments,
    });
    this.appendRecord(record);
    console.log(`[keve-reporter] ${test.title}: ${log}`);
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
        const latestDir = path.join(path.dirname(this.resultDir), 'latest');
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


  private appendRecord(record: ConfidenceRecord): void {
    fs.appendFileSync(this.outputPath, JSON.stringify(sanitizeRecord(record)) + '\n');
  }
}

export default KeveReporter;
