import type { ComponentStrategyPlan } from './component-strategy.js';
import { createLocatorPlan, type LocatorHopPlan, type PortalKind } from './locator-plan.js';

/**
 * 将 DSL 产出的 trigger/content 定位链统一编译成组件策略计划。
 * 该层只处理语义，不依赖 Cypress 或 Playwright API。
 */
export function createComponentStrategyPlan(
  kind: PortalKind,
  trigger: LocatorHopPlan[],
  content: LocatorHopPlan[],
  timeout = 5000,
): ComponentStrategyPlan {
  return {
    kind,
    trigger: createLocatorPlan(trigger, { scope: 'document', interaction: 'hover' }),
    content: createLocatorPlan(content, { scope: 'portal', interaction: 'click', portal: { kind } }),
    timeout,
  };
}

export function componentPlanFromRefs(
  kind: PortalKind,
  trigger: { chain?: LocatorHopPlan[] },
  content: { chain?: LocatorHopPlan[] },
  timeout = 5000,
): ComponentStrategyPlan {
  return createComponentStrategyPlan(kind, trigger.chain || [], content.chain || [], timeout);
}
