/**
 * keve-decorators — @keveModel + @keveScene 装饰器
 *
 * 使用 TC39 Stage 3 装饰器 API (Playwright 1.58+ 默认支持)
 * 
 * 执行顺序（TC39 Stage 3 规范）：
 * 1. Method decorator 函数调用 → 注册 addInitializer
 * 2. Class decorator 函数调用 → 注册 addInitializer  
 * 3. Method addInitializers 执行 → @keveScene 注册场景到 WeakMap
 * 4. Class addInitializer 执行 → @keveModel 读取 WeakMap 并调用 test.describe
 *
 * 两层装饰器 + 函数调用：
 *   Model (模块) → test.describe → @keveModel
 *   Scene (场景) → test → @keveScene (fn.toString() 捕获完整脚本)
 *   Goal  (步骤) → 步骤元数据 → keveGoal() 函数调用（在方法体内）
 */

import { test as baseTest } from '@playwright/test';
import { sceneCodeMap, sceneGoalsMap, type KeveGoalMeta } from './keve-registry';

// ─── Configurable test reference ────────────────────────────────────
// keveModel needs to call test.describe / test — but it must use the EXTENDED test
// (with keveGoal/keveAssert fixtures), not the base @playwright/test.
// keve-test.ts calls setKeveTest() after creating the extended test.
let _keveTest: any = baseTest;

/** Called by keve-test.ts to register the extended test instance */
export function setKeveTest(t: any) { _keveTest = t; }

/** Get the current keve test instance (extended with fixtures) */
export function getKeveTest() { return _keveTest; }

// ─── Types ──────────────────────────────────────────────────────────

// Re-export from registry
export type { KeveGoalMeta, KeveEvalMeta, ErrorCategory } from './keve-registry';

export interface KeveSceneMeta {
  id: string;
  description: string;
  title: string;
  code: string;
  goals: KeveGoalMeta[];
  fn: Function;
}

// ─── Internal Registry (WeakMap per Model constructor) ─────────────

/** Model → Scene 列表：每个 @keveModel 类下注册的 @keveScene 列表 */
const modelScenesMap = new WeakMap<Function, KeveSceneMeta[]>();



// ─── Error Classification ──────────────────────────────────────────

// Error classification moved to keve-report.ts onTestEnd — 
// onTestEnd has access to result.error and result.status, which is more reliable
// than try-catch in the decorator (async rejections, test-level timeouts can bypass decorator catch).

// ─── TC39 Stage 3 Decorators ──────────────────────────────────────

/**
 * @keveModel(name) — Class decorator (模块层)
 * Uses context.addInitializer to defer test.describe() registration
 * until AFTER all @keveScene addInitializers have run.
 */
export function keveModel(id: string, description: string) {
  return <T extends { new(...args: any[]): {} }>(ctor: T, context: ClassDecoratorContext) => {
    context.addInitializer(function (this: any) {
      const ctor = this;
      const scenes = modelScenesMap.get(ctor) || [];

      _keveTest.describe(`${id}: ${description}`, () => {
        for (const scene of scenes) {
          _keveTest(scene.title, scene.fn as any);
        }
      });
    });

    return ctor;
  };
}

/**
 * @keveScene(title) — Method decorator (场景层, static methods only)
 * Captures fn.toString() as the complete scene script.
 * Wraps fn with try-catch-finally to classify errors and decide skipAI.
 * Registers scene metadata to both WeakMap and global Map.
 *
 * The wrapper preserves the original function's destructuring signature by
 * extracting the parameter text from fn.toString() and constructing a wrapper
 * via new Function(), so Playwright can correctly resolve fixture dependencies.
 */
export function keveScene(id: string, description: string) {
  return (fn: Function, context: ClassMethodDecoratorContext) => {
    const code = fn.toString(); // Capture original code BEFORE wrapping
    const title = `${id}: ${description}`;

    // Register the original function directly — Playwright resolves fixture dependencies
    // by parsing fn.toString() / AST. Wrapping with new Function() breaks this resolution.
    // Error classification is handled in onTestEnd (keve-report.ts), not here.
    context.addInitializer(function (this: any) {
      const ctor = this;
      if (!modelScenesMap.has(ctor)) modelScenesMap.set(ctor, []);
      const scene: KeveSceneMeta = { id, description, title, code, goals: [], fn };

      modelScenesMap.get(ctor)!.push(scene);

      // Register to global maps for Reporter access
      sceneCodeMap.set(title, code); // Stores ORIGINAL code, not wrapped
    });

    return fn; // Return original function unchanged — preserves fixture parameter signature
  };
}

// ─── Utility ───────────────────────────────────────────────────────

/** 获取 Model 下注册的所有 Scene */
export function getModelScenes(ctor: Function): KeveSceneMeta[] | null {
  return modelScenesMap.get(ctor) || null;
}
