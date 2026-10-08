/**
 * @kkeve/suite/engine-cypress — Cypress 引擎出口（浏览器侧）
 *
 * 与 `@kkeve/suite/keve-test`（Playwright）**同构**：脚本只换 import 路径，
 * 装饰器、keveGoal、附件契约、报告产物全部一致。
 *
 *   // Playwright
 *   import { keveModel, keveScene } from '@kkeve/suite/keve-test';
 *   // Cypress
 *   import { keveModel, keveScene } from '@kkeve/suite/engine-cypress';
 *
 * ⚠️ 本模块被打进 Cypress 的**浏览器 bundle**：不得 import bridge.ts / cdp 之外
 * 任何 Node 模块，也不得 import 任何会间接拉入 `@playwright/test`（含
 * playwright-core → node:fs）的文件。Node 侧入口单独走 `engine-cypress/setup`。
 */

import '../core/decorator/keve-decorators.js';
import { installCypressHost } from './host.js';
import { installCypressReporter } from './reporter.js';

// 安装顺序：结果收集钩子先注册（保证 afterEach 顺序在外层），再装宿主。
installCypressReporter();
installCypressHost();

// ── 装饰器（引擎无关，与 Playwright 侧同一实现） ──
export {
  keveModel,
  keveScene,
  getModelScenes,
  setKeveTestHost,
  getKeveTest,
  hasKeveTest,
} from '../core/decorator/keve-decorators.js';
export type { KeveSceneMeta, KeveModelOptions, KeveSceneOptions } from '../core/decorator/keve-decorators.js';

// ── 场景注册表（报告与组合用例共用） ──
export {
  sceneCodeMap,
  sceneEvalMetaMap,
  sceneMetaMap,
  sceneGoalsMap,
  sceneImplMap,
} from '../core/decorator/keve-registry.js';
export type { KeveGoalMeta, KeveEvalMeta, ErrorCategory, KeveSceneStaticMeta } from '../core/decorator/keve-registry.js';

// ── goal 原语与探索器注册 ──
export {
  createCyKeveGoal,
  setCyGoalExplorer,
  type KeveGoalCallOptions,
  type CyGoalExploreResult,
  type CyGoalExplorer,
  type CyKeveGoal,
} from './keveGoal.js';

// ── 引擎适配器（AI Re-Act / 自定义场景可直接使用） ──
export { CypressEngine, createBridge } from './adapter.js';
export { createCdp, pollUntil } from './cdp.js';
export { createCypressEngine, resolveBaseUrl } from './host.js';

// ── 宿主已安装（副作用），此处保持与 Playwright 侧一致的导入体验 ──
export { getKeveHost, setKeveHost, hasKeveHost } from '../core/decorator/keve-host.js';
export type { KeveHost, KeveTestInfo } from '../core/decorator/keve-host.js';
