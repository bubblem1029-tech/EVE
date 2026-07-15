/**
 * Playwright config template generator
 *
 * Shared by `keve config`, `keve init`, and pipeline agents
 * to produce consistent keve-test.config.{ts,mjs} files.
 */

import * as path from 'node:path';
import { findKeveDir, resolveTaskDir, getBranchDir } from '../config';

export interface PwConfigOptions {
  baseUrl?: string;
  cdp?: boolean;
  cdpEndpoint?: string;
  webServer?: boolean;
  workers?: number;
  timeout?: number;
  retries?: number;
  format?: 'ts' | 'mjs';
}

export function generatePwConfig(options: PwConfigOptions = {}): string {
  const {
    baseUrl,
    cdp = false,
    cdpEndpoint,
    webServer = !cdp,
    workers = 3,
    timeout = 1200000,
    retries = 0,
    format = 'ts',
  } = options;

  const baseURLLine = baseUrl
    ? `process.env.BASE_URL || '${baseUrl}'`
    : `process.env.BASE_URL || process.env.PWGEN_TARGET_URL || 'http://localhost:3000'`;

  const cdpBlock = cdp
    ? `\n    // CDP: connect to running Chrome (preserves login state)\n    // Set KEVE_CDP_ENDPOINT=http://[::1]:9222 at runtime\n    // Or:  KEVE_CDP_WS_ENDPOINT=ws://...\n    connectOptions: ${cdpEndpoint ? `{ endpoint: '${cdpEndpoint}' }` : `process.env.KEVE_CDP_ENDPOINT ? { endpoint: process.env.KEVE_CDP_ENDPOINT } : undefined`},`
    : '';

  const webServerBlock = webServer
    ? `\n  webServer: {\n    command: 'pnpm dev',\n    url: ${baseUrl ? `'${baseUrl}'` : `'http://localhost:3000'`},\n    reuseExistingServer: true,\n  },`
    : `\n  // webServer disabled — CDP mode assumes app is already running`;

  if (format === 'mjs') {
    return generateMjsConfig({ baseURLLine, cdp, cdpBlock, webServerBlock, workers, timeout, retries });
  }

  return `import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');

// Task directory — set KEVE_TASK_DIR env at execution time
// e.g. KEVE_TASK_DIR=.keve/task_xxx npx playwright test --config=.keve/task_xxx/keve-test.config.ts
const taskDir = process.env.KEVE_TASK_DIR
  ? path.resolve(projectRoot, process.env.KEVE_TASK_DIR)
  : path.resolve(projectRoot, '.keve/default');

const round = process.env.KEVE_ROUND || 'latest';
const resultDir = path.join(taskDir, 'test-artifacts', \`round-\${round}\`);

export default defineConfig({
  globalSetup: require.resolve('@kkeve/suite/global-setup'),
  testDir: path.join(taskDir, 'keve_test_spec'),
  fullyParallel: true,
  workers: ${workers},
  retries: ${retries},
  timeout: ${timeout},
  expect: { timeout: 10000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(resultDir, 'test-results.json') }],
    [require.resolve('@kkeve/suite/keve-report')],
  ],
  use: {
    baseURL: ${baseURLLine},${cdp ? `\n    // CDP mode: login state preserved via connected Chrome` : `\n    storageState: path.resolve(projectRoot, '.auth/storage-state.json'),`}
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 5000,${cdpBlock}
  },
  outputDir: path.join(resultDir, 'test-results'),${webServerBlock}
});
`;
}

function generateMjsConfig(params: {
  baseURLLine: string;
  cdp: boolean;
  cdpBlock: string;
  webServerBlock: string;
  workers: number;
  timeout: number;
  retries: number;
}): string {
  const { baseURLLine, cdp, cdpBlock, webServerBlock, workers, timeout, retries } = params;

  const keveSuiteDir = `resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@ks-data', 'keve-suite')`;
  const globalSetupExpr = `resolve(${keveSuiteDir}, 'global-setup.js')`;
  const keveReportExpr = `resolve(${keveSuiteDir}, 'keve-report.js')`;

  return `import { defineConfig } from '@playwright/test';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const taskDir = process.env.KEVE_TASK_DIR
  ? resolve(projectRoot, process.env.KEVE_TASK_DIR)
  : resolve(projectRoot, '.keve/default');

process.env.KEVE_TASK_DIR = taskDir;

const round = process.env.KEVE_ROUND || 'latest';
const resultDir = join(taskDir, 'test-artifacts', \`round-\${round}\`);

const globalSetup = ${globalSetupExpr};
const keveReporter = ${keveReportExpr};

export default defineConfig({
  globalSetup,
  testDir: join(taskDir, 'keve_test_spec'),
  fullyParallel: true,
  workers: ${workers},
  retries: ${retries},
  timeout: ${timeout},
  expect: { timeout: 10000 },
  reporter: [
    ['list'],
    ['json', { outputFile: join(resultDir, 'test-results.json') }],
    [keveReporter],
  ],
  use: {
    baseURL: ${baseURLLine},${cdp ? `\n    // CDP mode: login state preserved via connected Chrome` : `\n    storageState: resolve(projectRoot, '.auth', 'storage-state.json'),`}
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 5000,${cdpBlock}
  },
  outputDir: join(resultDir, 'test-results'),${webServerBlock}
});
`;
}

export function resolveConfigOutputPath(explicitOutput?: string, format: 'ts' | 'mjs' = 'ts'): string {
  const ext = format === 'mjs' ? '.mjs' : '.ts';

  if (explicitOutput) return path.resolve(explicitOutput);

  const keveDir = findKeveDir();
  const taskDir = resolveTaskDir(keveDir);

  if (taskDir) return path.join(taskDir, `keve-test.config${ext}`);
  if (keveDir) {
    const branchDir = getBranchDir(keveDir);
    if (branchDir) return path.join(branchDir, `keve-test.config${ext}`);
    return path.join(keveDir, `keve-test.config${ext}`);
  }
  return path.join(process.cwd(), 'keve_test_spec', `keve-test.config${ext}`);
}

export function findExistingConfig(keveDir: string | null, taskDir: string | null): string | null {
  const searchPaths: string[] = [];
  if (taskDir) {
    searchPaths.push(path.join(taskDir, 'keve-test.config.mjs'));
    searchPaths.push(path.join(taskDir, 'keve-test.config.ts'));
  }
  if (keveDir) {
    searchPaths.push(path.join(keveDir, 'keve-test.config.mjs'));
    searchPaths.push(path.join(keveDir, 'keve-test.config.ts'));
  }
  searchPaths.push(path.join(process.cwd(), 'keve_test_spec', 'keve-test.config.mjs'));
  searchPaths.push(path.join(process.cwd(), 'keve_test_spec', 'keve-test.config.ts'));

  for (const p of searchPaths) {
    if (require('fs').existsSync(p)) return p;
  }
  return null;
}
