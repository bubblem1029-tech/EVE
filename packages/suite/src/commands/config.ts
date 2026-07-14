/**
 * keve config - Create or update Playwright config
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { findKeveDir, resolveTaskDir } from '../config';
import { generatePwConfig, resolveConfigOutputPath, findExistingConfig, type PwConfigOptions } from '../core/pw-config';

export interface ConfigOptions {
  baseUrl?: string;
  cdp?: boolean;
  cdpEndpoint?: string;
  webServer?: boolean;
  workers?: string;
  timeout?: string;
  retries?: string;
  output?: string;
  force?: boolean;
  show?: boolean;
  print?: boolean;
}

export async function config(options: ConfigOptions): Promise<void> {
  const keveDir = findKeveDir();
  const taskDir = resolveTaskDir(keveDir);

  if (options.show) {
    const configPath = findExistingConfig(keveDir, taskDir);
    if (configPath) {
      console.log(chalk.green(`  Config: ${configPath}`));
      console.log(fs.readFileSync(configPath, 'utf-8'));
    } else {
      console.log(chalk.yellow('  No keve-test.config.ts found'));
      console.log(chalk.gray('    Run: keve config  to create one'));
    }
    return;
  }

  const pwOptions: PwConfigOptions = {
    baseUrl: options.baseUrl || process.env.BASE_URL || process.env.PWGEN_TARGET_URL,
    cdp: options.cdp,
    cdpEndpoint: options.cdpEndpoint,
    webServer: options.webServer === false ? false : undefined,
    workers: options.workers ? parseInt(options.workers, 10) : undefined,
    timeout: options.timeout ? parseInt(options.timeout, 10) : undefined,
    retries: options.retries ? parseInt(options.retries, 10) : undefined,
  };

  const content = generatePwConfig(pwOptions);

  if (options.print) {
    console.log(content);
    return;
  }

  const outputPath = options.output
    ? path.resolve(options.output)
    : resolveConfigOutputPath();

  console.log(chalk.cyan('\n⚙️  keve config\n'));

  if (fs.existsSync(outputPath) && !options.force) {
    console.log(chalk.yellow(`  ⚠ ${path.relative(process.cwd(), outputPath)} already exists. Use --force to overwrite.`));
    console.log(chalk.gray('    Use --show to view current config'));
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf-8');

  console.log(chalk.green(`  ✓ Created: ${path.relative(process.cwd(), outputPath)}`));
  console.log(chalk.gray(`  baseURL:   ${pwOptions.baseUrl || '(from env)'}`));
  console.log(chalk.gray(`  CDP:       ${pwOptions.cdp ? 'enabled' : 'disabled'}`));
  console.log(chalk.gray(`  webServer: ${pwOptions.webServer !== false ? 'enabled' : 'disabled'}`));
  console.log(chalk.gray(`  workers:   ${pwOptions.workers || 3}`));
  console.log(chalk.gray(`  timeout:   ${pwOptions.timeout || 60000}ms`));

  if (pwOptions.cdp) {
    console.log(chalk.blue('\n  CDP Mode:'));
    console.log(chalk.gray('    Set KEVE_CDP_ENDPOINT=http://[::1]:9222 before running tests'));
  }

  console.log(chalk.green('\n  ✓ Config complete\n'));
}
