/**
 * keve vitest - Execute Vitest unit/component tests
 *
 * Wraps `npx vitest` with keve-specific config and coverage support.
 * Uses vitest.config.ts from keve_test_spec/ by default.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import chalk from 'chalk';

/**
 * Walk up from __dirname to find node_modules/vitest/vitest.mjs
 *
 * pnpm structure:
 *   node_modules/.pnpm/@ks-data+keve-agent@.../node_modules/
 *     ├── @ks-data/keve-suite/    ← __dirname is in dist/commands/ here
 *     └── vitest/                 ← sibling dep, walk up to find
 *
 * npm/node structure:
 *   node_modules/
 *     ├── @ks-data/keve-suite/    ← __dirname is in dist/commands/ here
 *     └── vitest/                 ← sibling dep, walk up to find
 */
function findVitestBinary(): { bin: string; nodeModules: string } | null {
  let current = __dirname;
  for (let i = 0; i < 10; i++) {
    const vitestBin = path.join(current, 'node_modules', 'vitest', 'vitest.mjs');
    if (fs.existsSync(vitestBin)) {
      return {
        bin: vitestBin,
        nodeModules: path.join(current, 'node_modules'),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return null;
}

export interface VitestOptions {
  config?: string;
  watch?: boolean;
  coverage?: boolean;
  filter?: string;
  verbose?: boolean;
}

/**
 * Find Vitest config: keve_test_spec/vitest.config.ts by default
 */
function findVitestConfig(optionsConfig?: string): string | null {
  const cwd = process.cwd();

  if (optionsConfig) {
    const resolved = path.resolve(cwd, optionsConfig);
    if (fs.existsSync(resolved)) return resolved;
    console.error(chalk.red(`  ✗ Vitest config not found: ${optionsConfig}`));
    return null;
  }

  const configPath = path.join(cwd, 'keve_test_spec', 'vitest.config.ts');
  if (fs.existsSync(configPath)) return configPath;

  console.error(chalk.red('  ✗ Vitest config not found'));
  console.error(chalk.gray('    Searched: keve_test_spec/vitest.config.ts'));
  console.error(chalk.gray('    Run: keve init'));
  return null;
}

export async function vitest(options: VitestOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = findVitestConfig(options.config);

  if (!configPath) {
    process.exit(1);
  }

  console.log(chalk.cyan('\n🧪 keve vitest\n'));

  // Build vitest args
  const vitestArgs: string[] = [];

  // Run mode (default: single run; --watch for watch mode)
  if (options.watch) {
    vitestArgs.push('watch');
  } else {
    vitestArgs.push('run');
  }

  vitestArgs.push('--config', configPath);

  if (options.coverage) {
    vitestArgs.push('--coverage');
  }

  if (options.filter) {
    vitestArgs.push(options.filter);
  }

  if (options.verbose) {
    console.log(chalk.gray(`  Config:    ${configPath}`));
    console.log(chalk.gray(`  Mode:      ${options.watch ? 'watch' : 'run'}`));
    console.log(chalk.gray(`  Coverage:  ${options.coverage ? 'enabled' : 'disabled'}`));
    console.log(chalk.gray(`  Filter:    ${options.filter || '(all)'}`));
    console.log();
  }

  console.log(chalk.blue(`  ▶ Running Vitest tests...\n`));

  // Resolve vitest binary — pnpm puts it in a sibling node_modules/
  // Walk up from __dirname (dist/commands/) to find node_modules/vitest/
  const vitestInfo = findVitestBinary();

  if (!vitestInfo) {
    console.error(chalk.red('  ✗ Vitest not found'));
    console.error(chalk.yellow('    Install: pnpm add -D @ks-data/keve-suite (includes vitest)'));
    process.exit(1);
  }

  const { bin: vitestBin, nodeModules: vitestNodeModules } = vitestInfo;

  // Execute Vitest with NODE_PATH so vitest.config.ts can resolve 'vitest/config'
  const exitCode = await new Promise<number>((resolve) => {
    const existingNodePath = process.env.NODE_PATH || '';
    const nodePath = existingNodePath
      ? `${vitestNodeModules}:${existingNodePath}`
      : vitestNodeModules;

    const child = spawn('node', [vitestBin, ...vitestArgs], {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_PATH: nodePath,
        FORCE_COLOR: '1',
      },
    });

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(chalk.red(`  ✗ Failed to start vitest: ${err.message}`));
      resolve(1);
    });
  });

  if (exitCode !== 0) {
    console.log(chalk.yellow('\n  ⚠ Some tests failed.'));
    process.exit(exitCode);
  }

  console.log(chalk.green('\n  ✓ All Vitest tests passed.'));
}
