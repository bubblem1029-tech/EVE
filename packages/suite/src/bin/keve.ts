#!/usr/bin/env node

/**
 * keve - AI-powered full-stack test agent CLI
 *
 * Commands:
 *   init          Initialize .keve/ directory and inject Skill
 *   run           Execute Playwright E2E tests
 *   vitest        Execute Vitest unit/component tests
 *   report        Generate HTML summary report
 *   test          Full pipeline: run → report
 *   clean         Clean test artifacts
 */

import { Command } from 'commander';
import * as path from 'node:path';

// package.json is in the package root, not in dist/
// __dirname → dist/bin/ → go up 2 levels to package root
const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
const pkg = require(pkgPath);

const program = new Command();

program
  .name('keve')
  .description('AI-powered full-stack test agent')
  .version(pkg.version);

// ─── init ──────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize .keve/ directory and inject Skill')
  .option('--loop <type>', 'Inject Skill to loop framework (myflicker)')
  .option('--skip-skill', 'Only create .keve/ directory, skip Skill injection')
  .option('--force', 'Overwrite existing files')
  .option('--cdp', 'Enable CDP mode in generated Playwright config')
  .option('--base-url <url>', 'Target application URL for Playwright config')
  .action(async (options) => {
    const { init } = await import('../commands/init.js');
    await init(options);
  });

// ─── config ────────────────────────────────────────────────

program
  .command('config')
  .description('Create or update Playwright config')
  .option('--base-url <url>', 'Target application URL')
  .option('--cdp', 'Enable CDP mode (connect to running Chrome)')
  .option('--cdp-endpoint <url>', 'CDP endpoint URL')
  .option('--no-web-server', 'Disable webServer section')
  .option('--workers <n>', 'Number of parallel workers', '3')
  .option('--timeout <ms>', 'Test timeout in ms', '1200000')
  .option('--retries <n>', 'Retry count', '0')
  .option('--output <path>', 'Config output path')
  .option('--force', 'Overwrite existing config')
  .option('--show', 'Show current config path and contents')
  .option('--print', 'Print generated config to stdout (no file write)')
  .action(async (options) => {
    const { config } = await import('../commands/config.js');
    await config(options);
  });

// ─── run ───────────────────────────────────────────────────

program
  .command('run')
  .description('Execute Playwright tests')
  .option('--config <path>', 'Playwright config path', '.keve/keve-test.config.ts')
  .option('--round <N>', 'Execution round number (auto-increment if omitted)')
  .option('--retry-from <round>', 'Re-run failed cases from specified round number')
  .option('--cases <names>', 'Run specific cases by name (comma-separated)')
  .option('--grep <pattern>', 'Filter cases by regex pattern')
  .option('--verbose', 'Verbose output')
  .action(async (options) => {
    const { run, KeveRunError } = await import('../commands/run.js');
    try {
      await run(options);
    } catch (e: any) {
      if (e instanceof KeveRunError) {
        console.error(`\n  ✗ ${e.message}`);
        process.exit(1);
      }
      throw e;
    }
  });

// ─── vitest ────────────────────────────────────────────────

program
  .command('vitest')
  .description('Execute Vitest unit/component tests')
  .option('--config <path>', 'Vitest config path', 'keve_test_spec/vitest.config.ts')
  .option('--watch', 'Run in watch mode')
  .option('--coverage', 'Generate coverage report')
  .option('--filter <glob>', 'Run tests matching glob pattern')
  .option('--verbose', 'Verbose output')
  .action(async (options) => {
    const { vitest } = await import('../commands/vitest.js');
    await vitest(options);
  });

// ─── report ────────────────────────────────────────────────

program
  .command('report')
  .description('Generate HTML summary report')
  .option('--results <path>', 'test-results.json path')
  .option('--cases <path>', 'test-cases.yaml path')
  .option('--output <dir>', 'Output directory')
  .option('--round <N>', 'Report round number')
  .action(async (options) => {
    const { report } = await import('../commands/report.js');
    await report(options);
  });

// ─── test (full pipeline) ──────────────────────────────────

program
  .command('test')
  .description('Full pipeline: run → report')
  .option('--config <path>', 'Playwright config path')
  .option('--grep <pattern>', 'Run tests matching pattern')
  .option('--max-rounds <N>', 'Max fix loop rounds', '3')
  .option('--verbose', 'Show detailed output')
  .action(async (options) => {
    const { test } = await import('../commands/test.js');
    await test(options);
  });

// ─── clean ─────────────────────────────────────────────────

program
  .command('clean')
  .description('Clean test artifacts')
  .option('--rounds', 'Clean round artifacts only')
  .option('--reports', 'Clean reports only')
  .option('--all', 'Clean all artifacts')
  .option('--dry-run', 'Preview without deleting')
  .action(async (options) => {
    const { clean } = await import('../commands/clean.js');
    await clean(options);
  });

// ─── Parse ─────────────────────────────────────────────────

program.parse();