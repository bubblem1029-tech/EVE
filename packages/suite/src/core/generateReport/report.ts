/**
 * 报告生成统一入口
 *
 * 只生成 report-data.json — 前端 Vue 报告页面消费的唯一数据源。
 * 废弃的产物：execution-summary.json、summary-report.html（数据均已在 report-data.json 中）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateReportData, type ReportDataOptions } from './reportData';

export type { ReportDataOptions };

export interface GenerateReportOptions extends ReportDataOptions {}

export interface GenerateReportResult {
  /** 生成的报告数据（JSON） */
  reportData: any;
}

/**
 * 报告生成统一入口：数据生成 → 写入 report-data.json
 */
export async function generateReport(opts: GenerateReportOptions): Promise<GenerateReportResult> {
  // Step 1: 生成报告数据（纯计算，无 IO）
  const reportData = await generateReportData(opts);

  // Step 2: 写入 round-N/report-data.json，latest/ 用 symlink 指向最新轮次（避免 34MB+ 重复拷贝）
  const { roundDir, latestDir, summary } = reportData;
  fs.mkdirSync(roundDir, { recursive: true });

  const reportDataJson = JSON.stringify(reportData, null, 2);
  fs.writeFileSync(path.join(roundDir, 'report-data.json'), reportDataJson);

  // latest → round-N symlink
  try {
    if (fs.existsSync(latestDir)) {
      const stat = fs.lstatSync(latestDir);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(latestDir); // 已是 symlink，替换
      } else {
        fs.rmSync(latestDir, { recursive: true, force: true }); // 旧式目录，清理
      }
    }
    fs.symlinkSync(path.basename(roundDir), latestDir, 'junction');
  } catch { /* ignore latest symlink error */ }

  const summaryInner = summary.summary || summary;
  console.log(`\n  Report data generated:`);
  console.log(`    Round: ${reportData.round}`);
  console.log(`    Total: ${summaryInner.total} | Passed: ${summaryInner.passed} | Failed: ${summaryInner.failed}`);
  console.log(`    Pass Rate: ${summaryInner.passRate}`);

  return { reportData };
}

// ─── CLI Entry ────────────────────────────────────────────────────────

export async function reportMain(): Promise<void> {
  const projectRoot = process.env.PROJECT_ROOT
    || (process.argv.find(a => a.startsWith('--project-root='))?.split('=')[1])
    || path.resolve(__dirname, '..');
  const resultsPath = process.argv.find(a => a.startsWith('--results-path='))?.split('=')[1]
    || process.env.TEST_RESULTS_PATH
    || path.join(projectRoot, 'test-artifacts', 'test-results.json');
  const confidencePath = process.argv.find(a => a.startsWith('--confidence-path='))?.split('=')[1];
  const casesPath = process.argv.find(a => a.startsWith('--cases-path='))?.split('=')[1];

  await generateReport({ projectRoot, resultsPath, confidencePath, casesPath });
  console.log('  report-data.json generated');
}
