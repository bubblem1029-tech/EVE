/**
 * Cross-engine locator semantics.
 *
 * DSL is compiled to this vocabulary before Cypress/Playwright adapt it to
 * their native locator APIs.  In particular, portal content must not inherit
 * the DOM scope of its trigger (Element Plus dropdown/dialog/tree-select).
 */
export type LocatorScope = 'document' | 'parent' | 'row' | 'portal' | 'iframe';
export type LocatorInteraction = 'click' | 'hover' | 'input' | 'assert';
export type PortalKind = 'dropdown' | 'dialog' | 'tree-select' | 'date-picker';

export interface LocatorHopPlan {
  type: string;
  value: string;
  index?: number;
}

export interface LocatorPlan {
  hops: LocatorHopPlan[];
  scope: LocatorScope;
  interaction?: LocatorInteraction;
  portal?: {
    kind: PortalKind;
    trigger?: LocatorHopPlan[];
  };
}

export function createLocatorPlan(
  hops: LocatorHopPlan[],
  options: {
    scope?: LocatorScope;
    interaction?: LocatorInteraction;
    portal?: LocatorPlan['portal'];
  } = {},
): LocatorPlan {
  const portalKind = options.portal?.kind || detectPortalKind(hops);
  return {
    hops: [...hops],
    scope: portalKind ? 'portal' : (options.scope || 'document'),
    ...(options.interaction ? { interaction: options.interaction } : {}),
    ...(portalKind ? { portal: options.portal || { kind: portalKind } } : {}),
  };
}

export function planFromRef(ref: LocatorPlan & { scope?: LocatorScope; portalKind?: PortalKind; interaction?: LocatorInteraction }): LocatorPlan {
  const portalKind = ref.portalKind || ref.portal?.kind || detectPortalKind(ref.hops);
  return {
    ...ref,
    scope: portalKind ? 'portal' : (ref.scope || 'document'),
    ...(portalKind ? { portal: ref.portal || { kind: portalKind } } : {}),
  };
}

/** Convert the cross-engine plan back to the platform ElementRef shape. */
export function planToElementRef(plan: LocatorPlan): {
  chain: LocatorHopPlan[];
  scope?: LocatorScope;
  portalKind?: PortalKind;
  interaction?: LocatorInteraction;
} {
  return {
    chain: plan.hops.map((hop) => ({ ...hop })),
    scope: plan.scope,
    portalKind: plan.portal?.kind,
    interaction: plan.interaction,
  };
}

const PORTAL_MARKERS: Array<[string, PortalKind]> = [
  ['el-select-dropdown', 'tree-select'],
  ['tree-select', 'tree-select'],
  ['el-dialog', 'dialog'],
  ['date-picker', 'date-picker'],
  ['dropdown', 'dropdown'],
];

/** Detect whether a hop chain describes content rendered outside its trigger. */
export function detectPortalKind(hops: Array<{ type?: string; value?: unknown }> | undefined): PortalKind | undefined {
  for (const hop of hops || []) {
    const value = String(hop?.value || '').toLowerCase();
    const marker = PORTAL_MARKERS.find(([text]) => value.includes(text));
    if (marker) return marker[1];
  }
  return undefined;
}

/** Child actions in a portal use document scope; ordinary children stay scoped. */
export function scopeForChild(hops: Array<{ type?: string; value?: unknown }> | undefined): LocatorScope {
  return detectPortalKind(hops) ? 'portal' : 'parent';
}
