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

// globalSetup / reporter 不能用 '@kkeve/suite/*' 包名引用：Playwright 以
// require.resolve(id, { paths: [configDir] }) 解析，带 paths 时不走包自引用，
// 本地 Client 经 pnpm link 跨树指向 suite 时必然 MODULE_NOT_FOUND。
// 这里按 suite 自身物理路径解析，平台（node_modules 同树）与本地（pnpm link）都成立。
const suiteGlobalSetup = path.join(suiteRoot, 'dist', 'engine-playwright', 'global-setup.js');
const suiteKeveReport = path.join(suiteRoot, 'dist', 'engine-playwright', 'keve-report.js');

const taskDir = process.env.KEVE_TASK_DIR || path.resolve(suiteRoot, '.keve', 'default');
const resultDir = process.env.KEVE_RESULT_DIR || path.join(taskDir, 'reports', 'round-latest');

export default defineConfig({
  testDir: path.join(taskDir, 'specs'),
  globalSetup: suiteGlobalSetup,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // 用例级超时：DSL 长用例（40+ 步，含拖拽/整页跳转）基线开销可达 ~120s，
  // 2 分钟上限会把清理步骤截断。默认放宽到 10 分钟，可用 KEVE_PW_TEST_TIMEOUT 覆盖。
  timeout: Number(process.env.KEVE_PW_TEST_TIMEOUT) || 600000,
  expect: { timeout: 10000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(resultDir, 'test-results.json') }],
    [suiteKeveReport],
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
