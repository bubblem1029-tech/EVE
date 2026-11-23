import type { LocatorPlan, PortalKind } from './locator-plan.js';

/** 跨引擎组件策略契约：公共层只描述语义，不依赖 Playwright/Cypress API。 */
export interface ComponentStrategyPlan {
  kind: PortalKind;
  trigger: LocatorPlan;
  content: LocatorPlan;
  timeout?: number;
}

export interface ComponentStrategyRuntime<TTarget = unknown> {
  resolve(plan: LocatorPlan): Promise<TTarget>;
  open(target: TTarget, plan: ComponentStrategyPlan): Promise<void>;
  waitReady(target: TTarget, plan: ComponentStrategyPlan): Promise<void>;
  click(target: TTarget, plan: LocatorPlan): Promise<void>;
}

export interface ComponentStrategy<TTarget = unknown> {
  readonly kind: PortalKind;
  execute(plan: ComponentStrategyPlan, runtime: ComponentStrategyRuntime<TTarget>): Promise<void>;
}

export function isComponentStrategyPlan(value: unknown): value is ComponentStrategyPlan {
  const plan = value as ComponentStrategyPlan | null;
  return Boolean(plan && plan.trigger && plan.content && plan.kind);
}
