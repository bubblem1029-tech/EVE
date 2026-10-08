/**
 * @kkeve/suite/engine-cypress/setup — Cypress 引擎的 Node 侧入口
 *
 * 只给 cypress.config 的 `setupNodeEvents` 使用（Node 环境）：
 *
 *   import { cypressSetup } from '@kkeve/suite/engine-cypress/setup';
 *
 *   export default defineConfig({
 *     e2e: {
 *       setupNodeEvents(on, config) {
 *         return cypressSetup(on, config);
 *       },
 *     },
 *   });
 *
 * 职责：起本地 HTTP 桥（截图对比 / 文件落盘 / 报告汇总），并把端口写回 config.env。
 * ⚠️ 绝不能从浏览器侧入口（@kkeve/suite/engine-cypress）import 本模块 ——
 * 它依赖 node:http / node:fs。
 */

export {
  setupKeveBridge,
  setupKeveBridge as cypressSetup,
  type CypressTestResultRecord,
} from './bridge.js';

export { setupKeveBridge as default } from './bridge.js';
