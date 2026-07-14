/**
 * keve run - Execute Playwright tests
 *
 * Wraps `npx playwright test` with round management and output organization.
 * Does NOT hardcode reporter or resultDir — the Playwright config handles those.
 * Only adds: round number management, retry-from/cases filtering, and post-run report generation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import chalk from 'chalk';
import { findKeveDir, getNextRoundFromState, completeRound, resolveTaskDir } from '../config';
import { generateReport } from '../core/generateReport/report';
import { generateReportData } from '../core/generateReport/reportData';

function isPlaywrightBrowserInstalled(): boolean {
  const cacheDir = os.platform() === 'darwin'
    ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
    : os.platform() === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
      : path.join(os.homedir(), '.cache/ms-playwright');

  if (!fs.existsSync(cacheDir)) return false;

  try {
    const entries = fs.readdirSync(cacheDir);
    return entries.some(e => e.startsWith('chromium-'));
  } catch {
    return false;
  }
}

async function ensurePlaywrightBrowsers(): Promise<void> {
  if (isPlaywrightBrowserInstalled()) return;

  console.log(chalk.yellow('  ⚠ Playwright browsers not found. Installing Chromium...'));
  console.log(chalk.gray('    This is a one-time setup (~200MB download).'));

  try {
    execSync('npx playwright install chromium', {
      stdio: 'inherit',
      timeout: 300_000,
    });
    console.log(chalk.green('  ✓ Playwright browsers installed.'));
  } catch (err) {
    console.error(chalk.red('  ✗ Failed to install Playwright browsers.'));
    console.error(chalk.gray('    Please run manually: npx playwright install chromium'));
    process.exit(1);
  }
}

export interface RunOptions {
  config?: string;
  round?: string;
  retryFrom?: string;
  cases?: string;
  grep?: string;
  verbose?: boolean;
}

export interface RunResult {
  exitCode: number;
  resultsFile: string;
  resultDir: string;
  taskDir: string;
  round: number;
  passed: number;
  failed: number;
  skipped: number;
}

function findPlaywrightConfig(keveDir: string, optionsConfig?: string): string | null {
  if (optionsConfig) {
    const resolved = path.resolve(optionsConfig);
    if (fs.existsSync(resolved)) return resolved;
    console.error(chalk.red(`  ✗ Config not found: ${optionsConfig}`));
    return null;
  }

  const taskDir = resolveTaskDir(keveDir);

  const searchPaths = [
    taskDir ? path.join(taskDir, 'keve-test.config.mjs') : null,
    taskDir ? path.join(taskDir, 'keve-test.config.ts') : null,
    keveDir ? path.join(keveDir, 'keve-test.config.mjs') : null,
    keveDir ? path.join(keveDir, 'keve-test.config.ts') : null,
    path.join(process.cwd(), 'keve_test_spec', 'keve-test.config.mjs'),
    path.join(process.cwd(), 'keve_test_spec', 'keve-test.config.ts'),
  ].filter(Boolean) as string[];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }

  console.error(chalk.red('  ✗ Playwright config not found'));
  console.error(chalk.gray('    Searched:'));
  for (const p of searchPaths) {
    console.error(chalk.gray(`      ${p}`));
  }
  console.error(chalk.gray('    Run: keve config  to create one'));
  return null;
}

function collectFailedTitles(suite: any, titles: string[]): void {
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      if (test.status === 'failed' || test.status === 'timedOut') {
        titles.push(spec.title || spec.name || '');
      }
    }
  }
  for (const child of suite.suites || []) {
    collectFailedTitles(child, titles);
  }
}

function escapeGrepPattern(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export class KeveRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeveRunError';
  }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const keveDir = findKeveDir();
  const cwd = process.cwd();

  const configPath = findPlaywrightConfig(keveDir || '', options.config);
  if (!configPath) {
    throw new KeveRunError('Playwright config not found');
  }

  let pwConfig: any;
  try {
    pwConfig = await new Function('return import(' + JSON.stringify(configPath) + ')')();
  } catch (e: any) {
    throw new KeveRunError(`Failed to import Playwright config: ${e.message}`);
  }
  const configDefault = pwConfig?.default || pwConfig;

  const taskDir = process.env.KEVE_TASK_DIR
    ? path.resolve(process.env.KEVE_TASK_DIR)
    : resolveTaskDir(keveDir) || cwd;

  let resultDir = '';
  let resultsFile = '';
  if (configDefault?.reporter) {
    for (const r of configDefault.reporter) {
      if (Array.isArray(r) && r[0] === 'json' && r[1]?.outputFile) {
        resultsFile = path.resolve(r[1].outputFile);
        resultDir = path.dirname(resultsFile);
        break;
      }
    }
  }

  console.log(chalk.cyan('\n🚀 keve run\n'));

  let round: number;
  if (options.round) {
    round = parseInt(options.round, 10);
  } else {
    round = getNextRoundFromState(taskDir);
  }

  resultDir = path.join(taskDir, 'test-artifacts', `round-${round}`);
  resultsFile = path.join(resultDir, 'test-results.json');

  const pwArgs = ['playwright', 'test', '--config', configPath];

  let effectiveGrep = options.grep || '';

  if (options.retryFrom) {
    const sourceRound = parseInt(options.retryFrom, 10);
    const sourceResultDir = path.join(taskDir, 'test-artifacts', `round-${sourceRound}`);

    const sourceResultsFile = path.join(sourceResultDir, 'test-results.json');
    if (!fs.existsSync(sourceResultsFile)) {
      throw new KeveRunError(`Round ${sourceRound} results not found: ${sourceResultsFile}`);
    }

    const sourceResults = JSON.parse(fs.readFileSync(sourceResultsFile, 'utf-8'));
    const failedTitles: string[] = [];
    for (const suite of sourceResults.suites || []) {
      collectFailedTitles(suite, failedTitles);
    }

    if (failedTitles.length === 0) {
      console.log(chalk.green(`  ✓ Round ${sourceRound} had no failures — nothing to retry`));
      return {
        exitCode: 0, resultsFile: sourceResultsFile, resultDir: sourceResultDir,
        taskDir, round, passed: 0, failed: 0, skipped: 0,
      };
    }

    const retryGrep = failedTitles.map(t => escapeGrepPattern(t)).join('|');
    effectiveGrep = effectiveGrep ? `${effectiveGrep}|${retryGrep}` : retryGrep;
    console.log(chalk.gray(`  Retrying ${failedTitles.length} failed cases from round ${sourceRound}`));
  }

  if (options.cases) {
    const caseNames = options.cases.split(',').map(c => c.trim());
    const casesGrep = caseNames.map(c => escapeGrepPattern(c)).join('|');
    effectiveGrep = effectiveGrep ? `${effectiveGrep}|${casesGrep}` : casesGrep;
    console.log(chalk.gray(`  Running specific cases: ${caseNames.join(', ')}`));
  }

  if (effectiveGrep) {
    pwArgs.push('--grep', effectiveGrep);
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    KEVE_TASK_DIR: taskDir,
    KEVE_ROUND: String(round),
  };

  if (!env.BASE_URL && !env.PWGEN_TARGET_URL) {
    console.log(chalk.gray('  Note: BASE_URL not set, Playwright config baseURL will be used for relative paths'));
  }

  fs.mkdirSync(resultDir, { recursive: true });

  if (options.verbose) {
    console.log(chalk.gray(`  Round:     ${round}`));
    console.log(chalk.gray(`  Config:    ${configPath}`));
    console.log(chalk.gray(`  ResultDir: ${resultDir}`));
    console.log(chalk.gray(`  Grep:      ${effectiveGrep || '(all)'}`));
    console.log();
  }

  console.log(chalk.blue(`  ▶ Round ${round} — Executing Playwright tests...\n`));

  await ensurePlaywrightBrowsers();

  if (!env.KEVE_CDP_ENDPOINT && !env.KEVE_CDP_WS_ENDPOINT) {
    env.KEVE_CDP_ENDPOINT = 'http://127.0.0.1:9222';
  }

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('npx', pwArgs, {
      cwd,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  if (exitCode !== 0 && options.verbose) {
    console.log(chalk.gray('  Playwright exited with errors (tests may have failed)'));
  }

  if (!fs.existsSync(resultsFile)) {
    console.error(chalk.red('  ✗ test-results.json not found after execution'));
    console.error(chalk.gray('    Expected at: ' + resultsFile));
    console.error(chalk.gray('    Check that config has json reporter with outputFile pointing to resultDir'));
    return {
      exitCode: 1, resultsFile, resultDir, taskDir, round, passed: 0, failed: 0, skipped: 0,
    };
  }

  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
  const stats = results.stats || {};

  const passed = stats.expected || (stats.passed || 0);
  const failed = stats.unexpected || (stats.failed || 0);
  const skipped = stats.skipped || 0;

  console.log(chalk.green(`\n  ✓ Round ${round} complete`));
  console.log(chalk.gray(`    Tests: ${stats.expected || 0} expected, ${stats.actual || 0} actual`));
  console.log(chalk.gray(`    Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`));

  completeRound(taskDir, round, { passed, failed, skipped });

  stripBase64FromTestResults(resultsFile, resultDir);

  // ── 兜底：确保 report-data.json 始终存在 ──
  const reportDataPath = path.join(resultDir, 'report-data.json');
  if (!fs.existsSync(reportDataPath)) {
    console.log(chalk.yellow('  ⚠ report-data.json missing — generating fallback report'));
    try {
      const confidencePath = path.join(resultDir, 'confidence-data.jsonl');
      if (fs.existsSync(resultsFile) && fs.existsSync(confidencePath)) {
        // 正常兜底：双文件都存在，调用 generateReportData 生成
        const reportData = await generateReportData({
          projectRoot: taskDir,
          resultsPath: resultsFile,
          confidencePath,
        });
        fs.writeFileSync(reportDataPath, JSON.stringify(reportData, null, 2));
        console.log(chalk.green(`  ✓ Fallback report-data.json generated at: ${reportDataPath}`));
      } else {
        // 极端兜底：缺少 confidence-data.jsonl（Playwright crash 场景）
        const fallbackReport: Record<string, any> = {
          round,
          taskDir,
          generatedBy: 'fallback',
          cases: [],
          warning: 'report-data.json generated by fallback — some test data may be incomplete',
        };
        // 尝试从 test-results.json 提取基础统计
        if (fs.existsSync(resultsFile)) {
          try {
            const results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
            const stats = results.stats || {};
            fallbackReport.summary = {
              total: (stats.expected || 0) + (stats.unexpected || 0) + (stats.skipped || 0),
              passed: stats.expected || 0,
              failed: stats.unexpected || 0,
              skipped: stats.skipped || 0,
            };
          } catch { /* ignore parse error in fallback */ }
        }
        fs.writeFileSync(reportDataPath, JSON.stringify(fallbackReport, null, 2));
        console.log(chalk.yellow(`  ⚠ Minimal fallback report-data.json generated (missing confidence data)`));
      }

      // 同步到 latest 目录 → symlink 指向最新 round（避免重复拷贝 34MB+）
      const latestDir = path.join(taskDir, 'test-artifacts', 'latest');
      if (latestDir !== resultDir) {
        try {
          if (fs.existsSync(latestDir)) {
            const stat = fs.lstatSync(latestDir);
            if (stat.isSymbolicLink()) {
              fs.unlinkSync(latestDir);
            } else {
              fs.rmSync(latestDir, { recursive: true, force: true });
            }
          }
          fs.symlinkSync(path.basename(resultDir), latestDir, 'junction');
        } catch { /* ignore latest symlink error */ }
      }
    } catch (err: any) {
      console.error(chalk.red(`  ✗ Fallback report generation failed: ${err.message}`));
    }
  }

  return { exitCode, resultsFile, resultDir, taskDir, round, passed, failed, skipped };
}

function stripBase64FromTestResults(resultsFile: string, resultDir: string): void {
  if (!fs.existsSync(resultsFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
    const screenshotsDir = path.join(resultDir, 'screenshots');
    let extractedCount = 0;

    function stripSuite(suite: any): void {
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            for (const att of result.attachments || []) {
              if (att.body && typeof att.body === 'string' && att.contentType !== 'application/json') {
                const fileName = `${att.name || 'screenshot'}.png`;
                const filePath = path.join(screenshotsDir, fileName);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, Buffer.from(att.body, 'base64'));
                delete att.body;
                att.path = path.relative(resultDir, filePath);
                extractedCount++;
              }
            }
          }
        }
      }
      for (const child of suite.suites || []) {
        stripSuite(child);
      }
    }

    for (const suite of data.suites || []) {
      stripSuite(suite);
    }

    fs.writeFileSync(resultsFile, JSON.stringify(data, null, 2));
    if (extractedCount > 0) {
      console.log(chalk.gray(`    Stripped ${extractedCount} base64 attachments from test-results.json`));
    }
  } catch (err: any) {
    console.log(chalk.gray(`    Note: Could not strip base64 from test-results.json: ${err.message}`));
  }
}

async function runGenerateReport(
  resultDir: string,
  resultsFile: string,
  keveDir: string | null,
  taskDir: string,
): Promise<void> {
  let casesPath = '';
  const casesCandidates = [
    path.join(process.cwd(), '.keve', 'test-cases.yaml'),
    keveDir ? path.join(keveDir, 'test-cases.yaml') : '',
    path.join(process.cwd(), 'keve_test_spec', 'test-cases.yaml'),
  ];
  for (const candidate of casesCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      casesPath = candidate;
      break;
    }
  }

  if (!casesPath && taskDir) {
    const taskCase = path.join(taskDir, 'test-cases.yaml');
    if (fs.existsSync(taskCase)) casesPath = taskCase;
  }

  const projectRoot = process.cwd();
  const confidenceFile = path.join(resultDir, 'confidence-data.jsonl');

  console.log(chalk.gray('  Step 1: Generating report data...'));
  try {
    const { reportData } = await generateReport({
      projectRoot,
      resultsPath: resultsFile,
      confidencePath: fs.existsSync(confidenceFile) ? confidenceFile : undefined,
      casesPath: casesPath || undefined,
    });

    const roundDir = reportData.roundDir as string;
    const latestDir = reportData.latestDir as string;

    try {
      if (fs.existsSync(latestDir)) fs.unlinkSync(latestDir);
      fs.symlinkSync(path.basename(roundDir), latestDir, 'junction');
    } catch { /* non-critical */ }

    console.log(chalk.green(`  ✓ Report: ${path.relative(process.cwd(), path.join(roundDir, 'report-data.json'))}`));
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Report generation failed: ${err.message}`));
    if (process.env.KEVE_VERBOSE) console.error(err);
  }
}
