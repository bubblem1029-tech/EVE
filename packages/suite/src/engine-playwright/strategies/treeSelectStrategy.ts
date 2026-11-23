import type { Locator, Page } from '@playwright/test';
import type { ComponentStrategy, ComponentStrategyPlan, ComponentStrategyRuntime } from '../../core/component-strategy.js';
import type { LocatorPlan } from '../../core/locator-plan.js';

/** Element Plus TreeSelect 的统一展开策略。 */
export class TreeSelectStrategy implements ComponentStrategy<Locator> {
  readonly kind = 'tree-select' as const;
  constructor(private readonly page: Page) {}

  async execute(plan: ComponentStrategyPlan, runtime: ComponentStrategyRuntime<Locator>): Promise<void> {
    const trigger = await runtime.resolve(plan.trigger);
    await runtime.open(trigger, plan);
    const content = await runtime.resolve(plan.content);
    await runtime.waitReady(content, plan);
  }

  async open(trigger: Locator, timeout = 5000): Promise<void> {
    const target = trigger.filter({ visible: true }).first();
    await target.scrollIntoViewIfNeeded();
    await target.click({ force: true }).catch(() => undefined);
    await target.focus().catch(() => undefined);
    await target.press('ArrowDown').catch(() => undefined);
    await target.press('Enter').catch(() => undefined);
    const dropdown = this.page.locator(
      '.el-tree-select-dropdown:visible, .el-select-dropdown:visible, .el-popper:visible',
    ).last();
    await dropdown.waitFor({ state: 'visible', timeout });
    const search = dropdown.locator('input[placeholder*="关键词"]:enabled').first();
    await search.waitFor({ state: 'visible', timeout });
  }

  runtime(): ComponentStrategyRuntime<Locator> {
    return {
      resolve: async (plan: LocatorPlan) => {
        let locator: Locator = this.page.locator('body');
        for (const hop of plan.hops) {
          if (hop.type === 'selector') locator = locator.locator(hop.value);
          else if (hop.type === 'includes' || hop.type === 'text') locator = locator.getByText(hop.value, { exact: false });
          if (hop.index && hop.index > 0) locator = locator.nth(hop.index - 1);
        }
        return locator;
      },
      open: async (target, plan) => { await this.open(target, plan.timeout || 5000); },
      waitReady: async (target, plan) => { await target.waitFor({ state: 'visible', timeout: plan.timeout || 5000 }); },
      click: async (target) => { await target.click({ force: true }); },
    };
  }
}
