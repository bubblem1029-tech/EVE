import { describe, expect, it } from 'vitest';
import { createLocatorPlan, detectPortalKind, scopeForChild } from './locator-plan.js';

describe('locator plan semantics', () => {
  it('keeps ordinary child actions in parent scope', () => {
    expect(scopeForChild([{ type: 'selector', value: '.row-action' }])).toBe('parent');
    expect(createLocatorPlan([{ type: 'selector', value: '.row-action' }]).scope).toBe('document');
  });

  it('moves dropdown content to portal scope', () => {
    const hops = [{ type: 'selector', value: '.personal-portal-column-more-dropdown' }];
    expect(detectPortalKind(hops)).toBe('dropdown');
    expect(scopeForChild(hops)).toBe('portal');
    expect(createLocatorPlan(hops).portal?.kind).toBe('dropdown');
  });

  it('recognizes tree-select and dialog portal content', () => {
    expect(detectPortalKind([{ type: 'selector', value: '.el-tree-select-input' }])).toBe('tree-select');
    expect(detectPortalKind([{ type: 'selector', value: '.el-dialog__footer' }])).toBe('dialog');
  });

  it('does not default every portal child to dropdown', () => {
    expect(createLocatorPlan([
      { type: 'selector', value: '.el-tree-select-dropdown' },
    ]).portal?.kind).toBe('tree-select');
  });
});
