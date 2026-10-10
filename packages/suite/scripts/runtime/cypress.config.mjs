/**
 * Cypress 任务级配置（静态模板）
 *
 * 以 `--project <taskDir> --config-file <本文件>` 方式加载：
 * 项目根仍是任务目录（specPattern 相对它解析），
 * 轮次产物目录则通过 KEVE_RESULT_DIR 注入。
 */
import * as path from 'node:path';
import * as url from 'node:url';
import { cypressSetup } from '../../dist/engine-cypress/setup.js';
import { preprocess } from './cypress-preprocessor.mjs';

const runtimeDir = path.dirname(url.fileURLToPath(import.meta.url));
const suiteRoot = path.resolve(runtimeDir, '..', '..');
const taskDir = process.env.KEVE_TASK_DIR || path.resolve(suiteRoot, '.keve', 'default');
const resultDir = process.env.KEVE_RESULT_DIR || path.join(taskDir, 'reports', 'round-latest');
const targetUrl = process.env.KEVE_TARGET_URL || '';

export default {
  viewportWidth: 2560,
  viewportHeight: 1440,
  e2e: {
    ...(targetUrl ? { baseUrl: targetUrl } : {}),
    specPattern: 'specs/**/*.spec.ts',
    supportFile: false,
    video: true,
    videosFolder: path.join(resultDir, 'videos'),
    screenshotsFolder: path.join(resultDir, 'screenshots'),
    downloadsFolder: path.join(resultDir, 'downloads'),
    screenshotOnRunFailure: false,
    defaultCommandTimeout: 10000,
    setupNodeEvents(on, config) {
      on('file:preprocessor', preprocess);
      return cypressSetup(on, config);
    },
  },
};
