/**
 * keve report - Generate report-data.json
 *
 * Usually called automatically by `keve run` after test execution.
 * Only generates report-data.json — frontend Vue report page consumes this.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { findKeveDir, getBranchDir } from '../config';
import { generateReportData } from '../index';

export interface ReportOptions {
  results?: string;
  cases?: string;
  round?: string;
}

/**
 * Resolve paths for report inputs
 */
function resolvePaths(options: ReportOptions) {
  const keveDir = findKeveDir();

  // Determine round
  let round: number | null = null;
  if (options.round) {
    round = parseInt(options.round, 10);
  } else if (keveDir) {
    const branchDir = getBranchDir(keveDir);
    const artifactsBase = branchDir ? path.join(branchDir, 'test-artifacts') : path.join(keveDir, 'test-artifacts');
    if (fs.existsSync(artifactsBase)) {
      const dirs = fs.readdirSync(artifactsBase)
        .filter(d => d.startsWith('round-'))
        .map(d => parseInt(d.replace('round-', ''), 10))
        .filter(n => !isNaN(n));
      if (dirs.length > 0) round = Math.max(...dirs);
    }
  }

  // Resolve test-results.json
  let resultsPath = options.results;
  if (!resultsPath && keveDir && round !== null) {
    const branchDir = getBranchDir(keveDir);
    const resultBase = branchDir ? path.join(branchDir, 'test-artifacts', `round-${round}`) : path.join(keveDir, 'test-artifacts', `round-${round}`);
    const candidate = path.join(resultBase, 'test-results.json');
    if (fs.existsSync(candidate)) resultsPath = candidate;
  }

  // Resolve test-cases.yaml
  let casesPath = options.cases;
  if (!casesPath && keveDir) {
    const candidates = [
      path.join(keveDir, 'test-cases.yaml'),
      path.join(process.cwd(), 'keve_test_spec', 'test-cases.yaml'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { casesPath = c; break; }
    }
  }

  // Resolve confidence-data.jsonl
  let confidencePath = '';
  if (keveDir && round !== null) {
    const branchDir = getBranchDir(keveDir);
    const resultBase = branchDir ? path.join(branchDir, 'test-artifacts', `round-${round}`) : path.join(keveDir, 'test-artifacts', `round-${round}`);
    const candidate = path.join(resultBase, 'confidence-data.jsonl');
    if (fs.existsSync(candidate)) confidencePath = candidate;
  }

  return { resultsPath, casesPath, confidencePath, round, keveDir };
}

/**
 * Generate report-data.json only
 */
async function invokeReport(options: ReportOptions): Promise<void> {
  const { resultsPath, casesPath, confidencePath, keveDir } = resolvePaths(options);

  if (!resultsPath || !fs.existsSync(resultsPath)) {
    console.error(chalk.red('  ✗ test-results.json not found'));
    console.error(chalk.gray(`    Use --results to specify path`));
    process.exit(1);
  }

  const projectRoot = keveDir || path.dirname(resultsPath);

  console.log(chalk.cyan('\n📊 keve report\n'));

  try {
    const reportData = await generateReportData({
      projectRoot,
      resultsPath,
      confidencePath: confidencePath || undefined,
      casesPath: casesPath || undefined,
    });

    const roundDir = reportData.roundDir as string;
    const latestDir = reportData.latestDir as string;

    fs.mkdirSync(roundDir, { recursive: true });

    // 只写 round-N/report-data.json
    const json = JSON.stringify(reportData, null, 2);
    fs.writeFileSync(path.join(roundDir, 'report-data.json'), json);

    // latest → round-N symlink
    try {
      if (fs.existsSync(latestDir)) {
        const stat = fs.lstatSync(latestDir);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(latestDir);
        } else {
          fs.rmSync(latestDir, { recursive: true, force: true });
        }
      }
      fs.symlinkSync(path.basename(roundDir), latestDir, 'junction');
    } catch { /* ignore latest symlink error */ }

    const summaryInner = reportData.summary?.summary || reportData.summary;
    console.log(chalk.green(`  ✓ report-data.json generated at ${path.relative(process.cwd(), path.join(roundDir, 'report-data.json'))}`));
    console.log(`    Total: ${summaryInner.total} | Passed: ${summaryInner.passed} | Failed: ${summaryInner.failed}`);
  } catch (err: any) {
    console.error(chalk.red(`  ✗ Report generation failed: ${err.message}`));
    if (process.env.KEVE_VERBOSE) console.error(err);
    process.exit(1);
  }
}

export async function report(options: ReportOptions): Promise<void> {
  await invokeReport(options);
}
