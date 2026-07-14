/**
 * keve test - Full pipeline: gen → run → evaluate → report
 * Orchestrates the complete KEVE test loop with fix cycles.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { findKeveDir, loadConfig } from '../config';
import { run, KeveRunError, type RunOptions } from './run';
import { report, type ReportOptions } from './report';

export interface TestOptions {
  config?: string;
  maxRounds?: string;
  grep?: string;
  verbose?: boolean;
  inlineImages?: boolean;
}

export async function test(options: TestOptions): Promise<void> {
  const maxRounds = parseInt(options.maxRounds || '3', 10);
  const keveDir = findKeveDir();

  console.log(chalk.cyan('\n🔄 keve test — Full pipeline\n'));
  console.log(chalk.gray(`  Max rounds: ${maxRounds}`));

  for (let round = 1; round <= maxRounds; round++) {
    console.log(chalk.blue(`\n━━━ Round ${round}/${maxRounds} ━━━\n`));

    // Step 1: Run tests
    console.log(chalk.yellow('  [1/2] Running tests...'));
    try {
      await run({
        config: options.config,
        grep: options.grep,
        verbose: options.verbose,
      });
    } catch (e: any) {
      if (e instanceof KeveRunError) {
        console.error(chalk.red(`  ✗ Run failed: ${e.message}`));
        break;
      }
      throw e;
    }

    // Step 2: Generate report
    console.log(chalk.yellow('  [2/2] Generating report...'));
    await report({
    } as any);

    // Check if all passed — if so, we're done
    if (keveDir) {
      const summaryPath = path.join(keveDir, 'reports', 'latest', 'execution-summary.json');
      if (fs.existsSync(summaryPath)) {
        try {
          const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
          if (summary.summary?.failed === 0) {
            console.log(chalk.green(`\n  ✓ All tests passed in round ${round}!`));
            break;
          }
          console.log(chalk.yellow(`  ⚠ ${summary.summary.failed} failed, ${summary.summary.passed} passed`));

          // Check for D-class failures that could be auto-fixed
          const dClassFailures = (summary.failedCases || []).filter((c: any) => c.type?.startsWith('D'));
          if (dClassFailures.length === 0 || round >= maxRounds) {
            if (round >= maxRounds) {
              console.log(chalk.yellow(`\n  ⚠ Reached max rounds (${maxRounds})`));
            }
            break;
          }
          console.log(chalk.gray(`  → ${dClassFailures.length} D-class failures, will retry...`));
        } catch { /* ignore parse errors */ }
      }
    }
  }

  console.log(chalk.green('\n  ✓ Pipeline complete\n'));
}
