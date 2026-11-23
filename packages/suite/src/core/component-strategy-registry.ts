import type { ComponentStrategy } from './component-strategy.js';
import type { PortalKind } from './locator-plan.js';

export class ComponentStrategyRegistry<TTarget = unknown> {
  private readonly strategies = new Map<PortalKind, ComponentStrategy<TTarget>>();

  register(strategy: ComponentStrategy<TTarget>): this {
    this.strategies.set(strategy.kind, strategy);
    return this;
  }

  get(kind: PortalKind): ComponentStrategy<TTarget> | undefined {
    return this.strategies.get(kind);
  }

  has(kind: PortalKind): boolean {
    return this.strategies.has(kind);
  }
}
