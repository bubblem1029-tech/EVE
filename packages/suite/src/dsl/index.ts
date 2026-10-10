/**
 * dsl — 平台 DSL ↔ @kkeve/suite 装饰器脚本的双向投影入口
 *
 * 本目录保持**零 IO、零框架依赖**，因此可以同时被打进：
 *   - Playwright 执行产物（@kkeve/suite/keve-test）
 *   - Cypress 浏览器 bundle（@kkeve/engine-cypress）
 *   - eve-backend 的生成器 service 层（Node 侧）
 *
 * 分层：DB 装载 / 内嵌场景展开 / 元素库 source 跳解析 / 变量表查询全部留在
 * 调用方（见 eve-backend 的 dslLoader）。这里只做纯函数投影。
 */

export {
  toDecorator,
  stepExpectedText,
  type DslHop,
  type DslValue,
  type DslExpectation,
  type DslStep,
  type DslVariableRow,
  type ExpectedRenderContext,
  type ToDecoratorOptions,
} from './toDecorator.js';

/** 语义别名：调用方按「生成一份装饰器 spec」的语义引用时更直观 */
export { toDecorator as generateDecoratorSpec } from './toDecorator.js';

export {
  STEP_OPERATIONS,
  ASSERT_OPERATIONS,
  TEXT_ONLY_ASSERT_OPERATIONS,
  EXPECTED_VALUE_CTYPES,
  COMPARISON_EXPRESSIONS,
  isKnownOperation,
  isKnownAssert,
  isTextOnlyAssert,
  parseComparison,
  type StepOperation,
} from './ops.js';
