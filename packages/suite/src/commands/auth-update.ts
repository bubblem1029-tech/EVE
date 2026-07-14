/**
 * keve auth-update - Update auth storage state (cookies/localStorage)
 *
 * Opens a browser for the user to manually log in, then saves the
 * storage state to `.auth/storage-state.json`.
 *
 * Usage:
 *   npx keve auth-update
 *   npx keve auth-update --url http://localhost:3000
 *   npx keve auth-update --config .keve/keve-test.config.ts
 */

import chalk from 'chalk';
import * as path from 'path';
import { acquireStorageState } from '../core/auth';

export interface AuthUpdateOptions {
  url?: string;
  config?: string;
}

export async function authUpdate(options: AuthUpdateOptions = {}) {
  const targetUrl = options.url || process.env.PWGEN_TARGET_URL || 'http://localhost:3000';
  const storageStatePath = path.resolve(process.cwd(), '.auth/storage-state.json');

  console.log(chalk.cyan('\n  keve auth-update'));
  console.log(chalk.gray(`  Target URL: ${targetUrl}`));
  console.log(chalk.gray(`  Storage state: ${storageStatePath}`));
  console.log(chalk.yellow('\n  Opening browser for manual login...'));
  console.log(chalk.gray('  (Auto-save when you navigate away from login page)\n'));

  const success = await acquireStorageState({
    targetUrl,
    storageStatePath,
    logPrefix: '  [keve auth-update]',
    onLoginDetected: (url) => console.log(chalk.green(`  Login detected! URL: ${url}`)),
    onStateSaved: (cookieCount, originCount) => {
      console.log(chalk.green(`\n  ✓ Auth state saved`));
      console.log(chalk.gray(`  Cookies: ${cookieCount}, localStorage origins: ${originCount}`));

      if (cookieCount === 0) {
        console.log(chalk.yellow('  ⚠ No cookies saved — login may not have completed.'));
        console.log(chalk.yellow('  Try `npx keve auth-update` again.'));
      } else {
        console.log(chalk.green('  ✓ Auth update complete! Run tests with: npx keve run'));
      }
    },
    onError: (msg) => console.error(chalk.red(`  Error: ${msg}`)),
    onBrowserFailed: (msg) => {
      console.error(chalk.red(`  Cannot launch browser: ${msg}`));
      console.error(chalk.yellow('  Ensure a display is available, or run in a local environment.'));
    },
  });

  if (!success && !options.url) {
    console.log(chalk.yellow('\n  Hint: Specify target URL if different from default:'));
    console.log(chalk.yellow('  npx keve auth-update --url http://your-app-url'));
  }
}