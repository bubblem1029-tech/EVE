import { describe, expect, it } from 'vitest';
import { componentPlanFromRefs, createComponentStrategyPlan } from './component-plan.js';

describe('component strategy plan', () => {
  it('creates a shared trigger/content plan', () => {
    const plan = createComponentStrategyPlan(
      'dropdown',
      [{ type: 'selector', value: '.trigger' }],
      [{ type: 'selector', value: '.menu-item' }],
    );
    expect(plan.trigger.scope).toBe('document');
    expect(plan.content.scope).toBe('portal');
    expect(plan.content.portal?.kind).toBe('dropdown');
  });

  it('converts ElementRef chains without changing their hop order', () => {
    const plan = componentPlanFromRefs(
      'tree-select',
      { chain: [{ type: 'selector', value: '.input' }] },
      { chain: [{ type: 'text', value: '目录' }] },
    );
    expect(plan.trigger.hops[0].value).toBe('.input');
    expect(plan.content.hops[0].value).toBe('目录');
    expect(plan.content.portal?.kind).toBe('tree-select');
  });
});
