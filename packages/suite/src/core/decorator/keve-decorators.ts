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
 *   Model (模块) → test.describe → @keveModel(id, desc, { setup, teardown, precondition?, before? })
 *   Scene (场景) → test → @keveScene(id, desc, { tag?, precondition?, before?, afterHook? })
 *   Goal  (步骤) → 步骤元数据 → keveGoal() 函数调用（在方法体内，支持 precondition）
 *
 * @keveGroup 已消除：
 *   - setup → @keveModel setup 选项（独立 Page，所有 Scene 前执行）
 *   - teardown → @keveModel teardown 选项（所有 Scene 后执行，扫描 E2E_ 前缀）
 *   - identity → Scene 内 keveGoal(fn) 中调用 globalThis.switchIdentity
 *   - afterHook → @keveScene afterHook 选项（Scene 后保证执行）
 */

import { sceneCodeMap, sceneGoalsMap, sceneMetaMap, sceneImplMap, type KeveGoalMeta } from './keve-registry.js';
import { getKeveHost, setKeveHost, hasKeveHost, type KeveHost, type KeveTestInfo } from './keve-host.js';

// ─── Configurable test reference ────────────────────────────────────
// keveModel needs to call test.describe / test — but it must use the EXTENDED test
// (with keveGoal/keveAssert fixtures), not the base @playwright/test.
// 引擎入口在创建好扩展 test 后调用 setKeveTest()/setKeveHost() 完成注册：
//   - Playwright: keve-test.ts → setKeveTest(test)
//   - Cypress:    engine-cypress → setKeveHost(cypressHost)
//
// 装饰器自身不依赖任何测试框架，只面向 KeveHost 接口。

/**
 * 注册宿主（推荐入口，引擎无关）。
 */
export function setKeveTestHost(host: KeveHost) { setKeveHost(host); }

/**
 * Playwright 兼容适配：把 @playwright/test 的 test 对象包成 KeveHost。
 * 保留该名称是为了不破坏既有调用（keve-test.ts / 外部脚本）。
 */
export function setKeveTest(t: any) {
  setKeveHost(adaptPlaywrightTest(t));
}

/** 把 Playwright 的 test 对象适配成引擎无关宿主 */
function adaptPlaywrightTest(t: any): KeveHost {
  const normalizeTitle = (testInfo: any): string => String(testInfo?.title ?? '');
  return {
    describe: (title, fn) => t.describe(title, fn),
    describeSerial: (title, fn) => (t.describe.serial || t.describe)(title, fn),
    beforeAll: (fn) => t.beforeAll(fn),
    beforeEach: (fn) => t.beforeEach(async ({}, testInfo: any) => {
      const info: KeveTestInfo = {
        title: normalizeTitle(testInfo),
        skip: (reason?: string) => testInfo.skip(true, reason),
      };
      await fn(info);
    }),
    afterEach: (fn) => t.afterEach(async ({}, testInfo: any) => {
      const info: KeveTestInfo = {
        title: normalizeTitle(testInfo),
        skip: (reason?: string) => testInfo.skip(true, reason),
      };
      await fn(info);
    }),
    afterAll: (fn) => t.afterAll(fn),
    test: (title, fn) => t(title, fn as any),
  };
}

/** Get the current keve test instance (Playwright 兼容查询；Cypress 下返回宿主) */
export function getKeveTest() { return getKeveHost(); }

/** 是否已注册宿主 */
export function hasKeveTest() { return hasKeveHost(); }

// ─── Types ──────────────────────────────────────────────────────────

// Re-export from registry
export type { KeveGoalMeta, KeveEvalMeta, ErrorCategory } from './keve-registry.js';

export interface KeveModelOptions {
  /**
   * Module 级 setup：在所有 Scene 之前执行一次。
   * 拥有独立 Page（完成后销毁，不与 Scene 共享）。
   * 用 keveGoal(fn) → API 成功零 AI 开销，失败 AI 自愈。
   * 签名：async ({ page, keveGoal }) => { ... }
   * Playwright 将其作为独立 test() 执行，因此可以解构 fixture。
   */
  setup?: Function;
  /**
   * Module 级 teardown：在所有 Scene 之后执行一次。
   * 保证执行（即使 Scene 失败/超时）。
   * 无 Playwright fixture —— 纯异步函数，用于 API 清理、E2E_ 前缀扫描等。
   * 签名：async () => { ... }
   */
  teardown?: Function;
  /**
   * Module 级前置条件（声明式描述）：进入任何 Scene 之前必须满足的条件列表。
   * 仅作元数据声明，供 Reporter/平台侧展示与归因（blocked ≠ fail）。
   * 需要可执行校验时用 before。
   */
  precondition?: string[];
  /**
   * Module 级可执行前置校验：在所有 Scene 之前执行一次（beforeAll）。
   * 返回 false 或抛错 → 整个 Model 下所有 Scene 跳过（skip，不是 fail）。
   * 无 Playwright fixture —— 纯异步函数（可用自有 API client 做环境检查）。
   * 签名：async () => boolean
   */
  before?: () => Promise<boolean>;
}

export interface KeveSceneOptions {
  /** 场景标签（可选，用于分类过滤） */
  tag?: string;
  /**
   * 用例级前置条件（声明式描述）：本 Scene 执行前必须满足的条件列表。
   * 仅作元数据声明，供 Reporter/平台侧展示与归因（对应旧系统 stepGroup.extraInfo.precondition）。
   * 需要可执行校验时用 before。
   */
  precondition?: string[];
  /**
   * Scene 级可执行前置校验：本 Scene 执行前调用一次（beforeEach，仅对本 Scene 生效）。
   * 返回 false 或抛错 → 本 Scene 跳过（skip，不是 fail）。
   * 无 Playwright fixture —— 纯异步函数。
   * 签名：async () => boolean
   */
  before?: () => Promise<boolean>;
  /**
   * Scene 级 afterHook：Scene 执行后保证调用（即使失败/超时）。
   * 无 Playwright fixture —— 纯异步函数，用于 API 清理等。
   * 签名：async () => { ... }
   */
  afterHook?: Function;
}

export interface KeveSceneMeta {
  id: string;
  description: string;
  title: string;
  code: string;
  goals: KeveGoalMeta[];
  fn: Function;
  /** 用例级前置条件描述列表 */
  precondition?: string[];
  /** 可执行前置校验 */
  before?: () => Promise<boolean>;
  afterHook?: Function;
}

// ─── Internal Registry (WeakMap per Model constructor) ─────────────

/** Model → Scene 列表：每个 @keveModel 类下注册的 @keveScene 列表 */
const modelScenesMap = new WeakMap<Function, KeveSceneMeta[]>();

/** Scene title → afterHook：@keveScene 注册的 afterHook 回调 */
const sceneAfterHooks = new Map<string, Function>();

// ─── Error Classification ──────────────────────────────────────────

// Error classification moved to keve-report.ts onTestEnd —
// onTestEnd has access to result.error and result.status, which is more reliable
// than try-catch in the decorator (async rejections, test-level timeouts can bypass decorator catch).

// ─── TC39 Stage 3 Decorators ──────────────────────────────────────

/**
 * @keveModel(id, description, options?) — Class decorator (模块层)
 * Uses context.addInitializer to defer test.describe() registration
 * until AFTER all @keveScene addInitializers have run.
 *
 * options.setup: 第一个 test() 调用，拥有独立 Page + keveGoal
 * options.teardown: test.afterAll 回调，保证执行
 */
export function keveModel(id: string, description: string, options?: KeveModelOptions) {
  return <T extends { new(...args: any[]): {} }>(ctor: T, context: ClassDecoratorContext) => {
    context.addInitializer(function (this: any) {
      const ctor = this;
      const scenes = modelScenesMap.get(ctor) || [];

      // Merge module-level precondition into each Scene's static meta
      // (scene addInitializers have all run by now — TC39 Stage 3 ordering)
      if (options?.precondition?.length) {
        for (const scene of scenes) {
          const meta = sceneMetaMap.get(scene.title) || {};
          sceneMetaMap.set(scene.title, { ...meta, modelPrecondition: options.precondition });
        }
      }

      // 有 setup 时使用 serial：确保 setup 先执行，setup 失败则 Scene 跳过
      // 无 setup 时使用普通 describe：Scene 可并行（实际 CDP 模式下仍串行）
      const host = getKeveHost();
      const describeFn = options?.setup
        ? host.describeSerial
        : host.describe;

      describeFn(`${id}: ${description}`, () => {
        // ── Module-level before: executable precondition check ──
        // Runs once before all Scenes (beforeAll). Returns false or throws
        // → beforeAll fails → Playwright skips every Scene in this Model.
        // Semantics: precondition unmet = skipped (blocked), NOT failed.
        if (options?.before) {
          host.beforeAll(async () => {
            let ok = false;
            let beforeError: any;
            try {
              ok = await options.before!();
            } catch (err: any) {
              beforeError = err;
            }
            if (!ok) {
              const reason = beforeError
                ? `Module precondition check errored: ${beforeError?.message || beforeError}`
                : `Module precondition not met (before returned false)`;
              console.log(`[keveModel] ⏭️ "${id}" SKIPPED — ${reason}`);
              throw new Error(reason);
            }
            console.log(`[keveModel] ✅ "${id}" module precondition check passed`);
          });
        }

        // ── Setup test (if provided) ──
        // 独立 Page，完成后 Playwright 自动回收；keveGoal fixture 可用
        if (options?.setup) {
          host.test(`${id}: ⚙ Module Setup`, options.setup as any);
        }

        // ── Scene tests ──
        for (const scene of scenes) {
          host.test(scene.title, scene.fn as any);

          // ── Scene-level before: executable precondition check ──
          // Scoped to this Scene by title match. Returns false or throws
          // → skip this Scene only (precondition unmet = blocked, NOT fail).
          if (scene.before) {
            const sceneBefore = scene.before;
            host.beforeEach(async (testInfo) => {
              if (testInfo.title !== scene.title) return;
              let ok = false;
              let beforeError: any;
              try {
                ok = await sceneBefore();
              } catch (err: any) {
                beforeError = err;
              }
              if (!ok) {
                const reason = beforeError
                  ? `Scene precondition check errored: ${beforeError?.message || beforeError}`
                  : `Scene precondition not met (before returned false)`;
                console.log(`[keveScene] ⏭️ "${scene.title}" SKIPPED — ${reason}`);
                testInfo.skip(reason);
              }
            });
          }
        }

        // ── afterEach: run scene afterHooks ──
        // 检查当前 test title 是否注册了 afterHook，有则调用
        // afterHook 无测试框架 fixture —— 纯异步函数
        host.afterEach(async (testInfo) => {
          const afterHook = sceneAfterHooks.get(testInfo.title);
          if (afterHook) {
            try {
              await afterHook();
            } catch (err: any) {
              console.error(`[keveScene] afterHook error for "${testInfo.title}": ${err?.message || err}`);
            }
          }
        });

        // ── afterAll: run module teardown ──
        // 保证执行，即使有 Scene 失败/超时
        if (options?.teardown) {
          host.afterAll(async () => {
            try {
              await options.teardown!();
            } catch (err: any) {
              console.error(`[keveModel] teardown error for "${id}": ${err?.message || err}`);
            }
          });
        }
      });
    });

    return ctor;
  };
}

/**
 * @keveScene(id, description, options?) — Method decorator (场景层, static methods only)
 * Captures fn.toString() as the complete scene script.
 * Registers scene metadata to both WeakMap and global Map.
 * If options.afterHook is provided, registers it in sceneAfterHooks Map
 * for afterEach consumption.
 *
 * Returns the original function unchanged — Playwright resolves fixture dependencies
 * by parsing fn.toString() / AST. Wrapping would break this resolution.
 */
export function keveScene(id: string, description: string, options?: KeveSceneOptions) {
  // fn 用 any：装饰器原样返回方法本体，类型需与方法签名（fixtures 参数）兼容，Function 会触发 TS1270
  return (fn: any, context: ClassMethodDecoratorContext) => {
    const code = fn.toString(); // Capture original code BEFORE any wrapping
    const title = `${id}: ${description}`;

    context.addInitializer(function (this: any) {
      const ctor = this;
      if (!modelScenesMap.has(ctor)) modelScenesMap.set(ctor, []);
      const scene: KeveSceneMeta = {
        id, description, title, code, goals: [], fn,
        precondition: options?.precondition,
        before: options?.before,
        afterHook: options?.afterHook,
      };

      modelScenesMap.get(ctor)!.push(scene);

      // Register to global maps for Reporter access
      sceneCodeMap.set(title, code); // Stores ORIGINAL code, not wrapped

      // Register scene implementation for engine.callScene composition
      sceneImplMap.set(id, fn);

      // Register scene-level static meta (model-level precondition merged
      // later in keveModel's addInitializer, which runs after all scenes registered)
      sceneMetaMap.set(title, { precondition: options?.precondition });

      // Register afterHook for afterEach consumption
      if (options?.afterHook) {
        sceneAfterHooks.set(title, options.afterHook);
      }
    });

    return fn; // Return original function unchanged — preserves fixture parameter signature
  };
}

// ─── Utility ───────────────────────────────────────────────────────

/** 获取 Model 下注册的所有 Scene */
export function getModelScenes(ctor: Function): KeveSceneMeta[] | null {
  return modelScenesMap.get(ctor) || null;
}
