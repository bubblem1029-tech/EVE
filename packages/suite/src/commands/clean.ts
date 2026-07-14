/**
 * keve clean - Clean test artifacts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { findKeveDir } from '../config';

export interface CleanOptions {
  rounds?: boolean;
  reports?: boolean;
  all?: boolean;
  dryRun?: boolean;
}

function removeDir(dir: string, dryRun: boolean): void {
  if (!fs.existsSync(dir)) return;
  if (dryRun) {
    console.log(chalk.gray(`  [dry-run] Would remove: ${path.relative(process.cwd(), dir)}`));
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(chalk.green(`  ✓ Removed: ${path.relative(process.cwd(), dir)}`));
}

export async function clean(options: CleanOptions): Promise<void> {
  const keveDir = findKeveDir();
  if (!keveDir) {
    console.error(chalk.red('  ✗ .keve/ directory not found'));
    process.exit(1);
  }

  console.log(chalk.cyan('\n🧹 keve clean\n'));

  if (options.all || (!options.rounds && !options.reports)) {
    // Default: clean both
    removeDir(path.join(keveDir, 'test-artifacts'), !!options.dryRun);
    removeDir(path.join(keveDir, 'reports'), !!options.dryRun);
    console.log(chalk.green('  ✓ Cleaned all artifacts and reports'));
    return;
  }

  if (options.rounds) {
    removeDir(path.join(keveDir, 'test-artifacts'), !!options.dryRun);
  }

  if (options.reports) {
    removeDir(path.join(keveDir, 'reports'), !!options.dryRun);
  }

  console.log(chalk.green('\n  ✓ Clean complete\n'));
}
