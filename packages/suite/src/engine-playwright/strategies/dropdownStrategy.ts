import type { Locator, Page } from '@playwright/test';
import type { ComponentStrategy, ComponentStrategyPlan, ComponentStrategyRuntime } from '../../core/component-strategy.js';
import type { LocatorPlan } from '../../core/locator-plan.js';

/** Element Plus Dropdown 的统一打开策略。 */
export class DropdownStrategy implements ComponentStrategy<Locator> {
  readonly kind = 'dropdown' as const;

  constructor(private readonly page: Page) {}

  async execute(plan: ComponentStrategyPlan, runtime: ComponentStrategyRuntime<Locator>): Promise<void> {
    const trigger = await runtime.resolve(plan.trigger);
    await runtime.open(trigger, plan);
    const content = await runtime.resolve(plan.content);
    await runtime.waitReady(content, plan);
    await runtime.click(content, plan.content);
  }

  async open(trigger: Locator, timeout = 5000): Promise<Locator> {
    const target = trigger.filter({ visible: true }).first();
    await target.scrollIntoViewIfNeeded();
    // 表格横向滚动容器不会总被 Playwright 的 auto-scroll 居中；
    // 先由 DOM 强制 inline: center，再读取新坐标，避免 hover 落在 viewport 外。
    await target.evaluate((el) => {
      (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
    });
    await this.page.waitForTimeout(100);
    const box = await target.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('Dropdown 触发器不可见或尺寸无效');
    }
    const menuId = await target.getAttribute('aria-controls');
    await target.hover({ force: true });
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const menu = menuId
      ? this.page.locator(`#${menuId}`)
      : this.page.locator('.el-dropdown-menu:visible, .el-popper:visible').last();
    try {
      await menu.waitFor({ state: 'visible', timeout: Math.min(timeout, 1500) });
    } catch (hoverError) {
      // Element Plus 某些版本在自动化 mouseenter 下不打开 Dropdown，
      // 对当前 trigger 做一次受限 click fallback；不使用全局文本点击，
      // 避免误操作其它看板行。
      await target.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
      try {
        await menu.waitFor({ state: 'visible', timeout: Math.max(1000, timeout - 1500) });
        return menu;
      } catch {
        const error = hoverError;
      const detail = await target.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const id = el.getAttribute('aria-controls');
        const controlled = id ? document.getElementById(id) : null;
        const menuRect = controlled?.getBoundingClientRect();
        return {
          tag: el.tagName,
          className: String((el as HTMLElement).className || ''),
          ariaControls: id,
          rect: [rect.x, rect.y, rect.width, rect.height],
          menuRect: menuRect ? [menuRect.x, menuRect.y, menuRect.width, menuRect.height] : null,
          outerHTML: el.outerHTML.slice(0, 500),
        };
      }).catch(() => null);
      throw new Error(`Dropdown 菜单未展开：${JSON.stringify(detail)}；原因：${String((error as Error)?.message || error)}`);
      }
    }
    return menu;
  }

  /** Playwright runtime bridge used by the cross-engine strategy contract. */
  runtime(): ComponentStrategyRuntime<Locator> {
    return {
      resolve: async (plan: LocatorPlan) => this.resolvePlan(plan),
      open: async (target, plan) => { await this.open(target, plan.timeout || 5000); },
      waitReady: async (target, plan) => { await target.waitFor({ state: 'visible', timeout: plan.timeout || 5000 }); },
      click: async (target) => { await target.click(); },
    };
  }

  private resolvePlan(plan: LocatorPlan): Locator {
    let locator: Locator = this.page.locator('body');
    for (const hop of plan.hops) {
      if (hop.type === 'selector') locator = locator.locator(hop.value);
      else if (hop.type === 'includes' || hop.type === 'text') locator = locator.getByText(hop.value, { exact: false });
      // Portal content leaves hidden historical menus in the DOM. Resolve each
      // hop against the current visible instance before the next hop, otherwise
      // Playwright enters strict-mode with dozens of stale menu copies.
      if (plan.scope === 'portal') locator = locator.locator('visible=true');
      if (hop.index && hop.index > 0) locator = locator.nth(hop.index - 1);
    }
    return plan.scope === 'portal' ? locator.first() : locator;
  }
}
