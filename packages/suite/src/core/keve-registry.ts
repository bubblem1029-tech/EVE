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
export type ErrorCategory = 'script' | 'env' | 'assert' | 'visual' | 'text-mismatch' | 'react-fail' | 'pass' | 'unknown';

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
