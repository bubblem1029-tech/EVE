/**
 * keve-registry — Global scene metadata registry
 *
 * Shared between keve-decorators (writes) and keve-report (reads).
 * This module has NO dependency on @playwright/test, so the Reporter
 * can import it without pulling Playwright into the report build.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface KeveGoalMeta {
  precondition?: string;
  step: string;
  expected: string;
  order: number;
}

/** 错误分类类型 */
export type ErrorCategory = 'script' | 'env' | 'assert' | 'visual' | 'text-mismatch' | 'incomplete' | 'pass' | 'unknown';

/** 场景执行后的评估元数据，由 @keveScene 装饰器写入，Reporter 读取 */
export interface KeveEvalMeta {
  /** 错误分类 */
  errorCategory: ErrorCategory;
  /** 是否跳过 AI 评估（脚本错误时为 true） */
  skipAI: boolean;
  /** 原始错误信息（可选，未截断） */
  errorMessage?: string;
}

// ─── Global Registry ──────────────────────────────────────────────

/**
 * 场景代码映射: scene title → scene code (fn.toString())
 * Reporter 通过 sceneCodeMap.get(title) 获取场景脚本
 */
export const sceneCodeMap = new Map<string, string>();

/**
 * 场景目标映射: scene title → goal metadata array
 */
export const sceneGoalsMap = new Map<string, KeveGoalMeta[]>();

/**
 * 场景评估元数据映射: scene title → KeveEvalMeta
 * @keveScene 装饰器在执行后写入分类结果，Reporter 在 onTestEnd 中读取
 */
export const sceneEvalMetaMap = new Map<string, KeveEvalMeta>();

/** 场景静态元数据（编译期已知，不依赖执行） */
export interface KeveSceneStaticMeta {
  /** 用例级前置条件描述列表（声明式，来自 @keveScene options） */
  precondition?: string[];
  /** 所属 Model 的模块级前置条件描述列表 */
  modelPrecondition?: string[];
}

/**
 * 场景静态元数据映射: scene title → KeveSceneStaticMeta
 * @keveScene 装饰器在注册期写入，Reporter/平台解析侧读取
 * （Reporter 无需等待场景执行即可拿到前置条件，用于报告展示与 blocked 归因）
 */
export const sceneMetaMap = new Map<string, KeveSceneStaticMeta>();

/**
 * 场景实现映射: scene id（如 'S4'）→ 场景静态方法本体
 * @keveScene 装饰器在注册期写入；engine.callScene(id, keveGoal) 运行时查找调用，
 * 实现「用例组合用例」而无需 spec 文件互相 import（避免重复注册测试）
 */
export const sceneImplMap = new Map<string, Function>();
