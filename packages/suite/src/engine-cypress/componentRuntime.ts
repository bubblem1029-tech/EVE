import type { ComponentStrategy, ComponentStrategyRuntime, ComponentStrategyPlan } from '../core/component-strategy.js';
import type { LocatorPlan, PortalKind } from '../core/locator-plan.js';
import { planToElementRef } from '../core/locator-plan.js';
import type { ElementRef } from '../core/page-object/definePage.js';

/** Cypress/AUT 对公共组件策略的最小运行时适配。 */
export interface CypressComponentOps {
  resolve(plan: LocatorPlan): Promise<ElementRef>;
  hover(ref: ElementRef): Promise<void>;
  click(ref: ElementRef): Promise<void>;
  waitForElement(selector: string, timeout?: number): Promise<{ found: boolean }>;
}

export class CypressComponentRuntime implements ComponentStrategyRuntime<ElementRef> {
  constructor(private readonly ops: Omit<CypressComponentOps, 'resolve'>) {}

  async resolve(plan: LocatorPlan): Promise<ElementRef> {
    return planToElementRef(plan) as ElementRef;
  }

  async open(target: ElementRef, plan: ComponentStrategyPlan): Promise<void> {
    if (plan.kind === 'dropdown') await this.ops.hover(target);
    else await this.ops.click(target);
  }

  async waitReady(_target: ElementRef, plan: ComponentStrategyPlan): Promise<void> {
    const selector = plan.content.hops.find((hop) => hop.type === 'selector')?.value;
    if (!selector) return;
    const result = await this.ops.waitForElement(String(selector), plan.timeout || 5000);
    if (!result.found) throw new Error(`Cypress 组件内容未就绪：${selector}`);
  }

  async click(target: ElementRef, _plan?: LocatorPlan): Promise<void> {
    await this.ops.click(target);
  }
}

/**
 * Cypress 组件策略的薄适配层。
 * 组件识别和生命周期由公共层定义，Cypress 只提供 hover/click/wait 原语。
 */
export class CypressPortalStrategy implements ComponentStrategy<ElementRef> {
  constructor(public readonly kind: PortalKind, private readonly runtime: CypressComponentRuntime) {}

  async execute(plan: ComponentStrategyPlan, runtime = this.runtime): Promise<void> {
    const trigger = await runtime.resolve(plan.trigger);
    await runtime.open(trigger, plan);
    await runtime.waitReady(trigger, plan);
    if (plan.content.hops.length) {
      const content = await runtime.resolve(plan.content);
      await runtime.click(content, plan.content);
    }
  }
}

export function createCypressComponentOps(
  callbacks: Omit<CypressComponentOps, 'resolve'>,
): CypressComponentOps {
  return {
    ...callbacks,
    resolve: async (plan) => planToElementRef(plan) as ElementRef,
  };
}
