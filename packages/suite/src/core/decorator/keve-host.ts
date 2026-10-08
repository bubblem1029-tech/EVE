/**
 * keve-host — 装饰器宿主抽象
 *
 * @keveModel / @keveScene 只依赖本接口，不直接依赖任何测试框架：
 *   - Playwright: keve-test.ts 把扩展后的 test 适配成 KeveHost
 *   - Cypress:    engine-cypress/host.ts 把 cy / describe / it 适配成 KeveHost
 *
 * 这样同一份装饰器脚本可同时跑在两个引擎下，且注册进 keve-registry 的
 * 场景元数据完全一致 —— 这是两端报告能够对齐的根本原因。
 *
 * 本模块必须保持零依赖（浏览器安全），Cypress spec 会直接打包它。
 */

/** 用例信息：装饰器在 beforeEach / afterEach 中需要的子集 */
export interface KeveTestInfo {
  /** 用例完整标题（`${id}: ${description}`），用于与 scene.title 匹配 */
  title: string;
  /** 标记跳过。前置条件不满足 → blocked（跳过），不是 fail */
  skip(reason?: string): void;
}

/**
 * 测试框架宿主能力：恰好是 @keveModel/@keveScene 需要的全部注册原语。
 * 刻意保持最小 —— 任何新增能力都必须同时能被 Playwright 与 Cypress 表达。
 */
export interface KeveHost {
  /** 注册一个 describe 分组 */
  describe(title: string, fn: () => void): void;
  /** 注册串行 describe：Model 带 setup 时使用，保证 setup 先于各 Scene 执行 */
  describeSerial(title: string, fn: () => void): void;
  beforeAll(fn: () => Promise<void> | void): void;
  beforeEach(fn: (testInfo: KeveTestInfo) => Promise<void> | void): void;
  afterEach(fn: (testInfo: KeveTestInfo) => Promise<void> | void): void;
  afterAll(fn: () => Promise<void> | void): void;
  /** 注册一个 Scene 用例 */
  test(title: string, fn: Function): void;
}

let _host: KeveHost | null = null;

/** 由引擎入口调用（keve-test.ts / engine-cypress）。后注册者生效。 */
export function setKeveHost(host: KeveHost): void {
  _host = host;
}

/** 获取当前宿主；未注册时抛出可诊断的错误（而非 undefined 崩溃） */
export function getKeveHost(): KeveHost {
  if (!_host) {
    throw new Error(
      '[keve] 测试宿主未注册：请先 import 引擎入口'
      + '（@kkeve/suite/keve-test 或 @kkeve/suite/engine-cypress）再做场景注册',
    );
  }
  return _host;
}

export function hasKeveHost(): boolean {
  return _host !== null;
}
