/**
 * Playwright 任务级配置（静态模板）
 *
 * 该文件不再随任务生成，任务差异全部通过环境变量注入：
 *   KEVE_TASK_DIR    任务根（specs 位于其下）
 *   KEVE_RESULT_DIR  当前轮次产物目录
 * 因此任务目录只保留 specs / reports / runs / cases，不再落 package.json 与配置副本。
 */
import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import * as url from 'node:url';

const runtimeDir = path.dirname(url.fileURLToPath(import.meta.url));
const suiteRoot = path.resolve(runtimeDir, '..', '..');

const taskDir = process.env.KEVE_TASK_DIR || path.resolve(suiteRoot, '.keve', 'default');
const resultDir = process.env.KEVE_RESULT_DIR || path.join(taskDir, 'reports', 'round-latest');

export default defineConfig({
  testDir: path.join(taskDir, 'specs'),
  globalSetup: '@kkeve/suite/global-setup',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 10000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(resultDir, 'test-results.json') }],
    ['@kkeve/suite/keve-report'],
  ],
  use: {
    baseURL: process.env.KEVE_TARGET_URL || '',
    storageState: process.env.KEVE_STORAGE_STATE,
    viewport: { width: 2560, height: 1440 },
    trace: 'off',
    screenshot: 'off',
    video: 'on',
    actionTimeout: 10000,
  },
  outputDir: path.join(resultDir, 'test-results'),
});
