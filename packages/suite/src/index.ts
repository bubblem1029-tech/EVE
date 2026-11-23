export { generateReportData, type ReportDataOptions, parseCaseIdFromTitle, extractAllSpecs, buildCaseResultMap, parseYamlSimple } from './core/generateReport/reportData.js';
export {
  buildCaseIdentity,
  normalizeGroupName,
  splitGroupName,
  formatCaseDisplayName,
  type CaseGroupInfo,
  type CaseGroupNode,
  type CaseGroupStats,
  type CaseIdentity,
  type CaseIdentityInput,
} from './core/case-identity.js';
export {
  normalizeVerdict,
  isInfraReason,
  type NormalizedVerdict,
  type NormalizeVerdictInput,
  type ReasonCode,
  type Verdict,
} from './core/verdict.js';
export { resolveLlmContextEnv, withLlmContextHeaders, type LlmContextEnv } from './core/llm-context.js';
export {
  buildCrossEngineDiffReport,
  type CrossEngineDiffEntry,
  type CrossEngineDiffReport,
  type DiffCaseResult,
  type DiffStep,
  type DiffType,
  type StepDiff,
} from './core/cross-engine-diff.js';

// Re-Act loop (refactored to page-agent)
export { KevePageAgent, reactLoop, type AgentResult, type AgentStepEvent, type AgentEvent, type AgentOptions, type AgentHooks } from './page-agent/agent.js';
export { tools, packMacroToolSchema, type PageAgentTool, type MacroToolInput, type ToolContext } from './page-agent/tools.js';

// Aspect registry (new)
export { keveAspect, KeveAspectRegistry, type AspectPhase, type AspectDefinition, type GoalContext, type GoalResult } from './core/decorator/keve-aspect.js';

// Action log (new)
export { ActionLogWriter, type ActionLogRecord } from './core/action-log-writer.js';

// Learned actions (new)
export { learnedActions, LearnedActions } from './core/learned-actions.js';

// Playwright config generator
export { generatePwConfig, resolveConfigOutputPath, findExistingConfig, type PwConfigOptions } from './engine-playwright/pw-config.js';

// Run API
export { run, KeveRunError, type RunOptions, type RunResult } from './commands/run.js';

// Script refine (new)
// script-refine is now part of page-agent/tools

// ─── Code-based Element Management (P0) ──────────────────────────────
export { definePage, type ElementRef, type ElementFactory, type ElementEntry, type ElementRegistry, type PageDefinition, type DefinedPage, type WaitForReady, isElementFactory, getElement } from './core/page-object/definePage.js';
export { resolveElement, resolveChain, resolveFromPage } from './core/page-object/elementResolver.js';
export { createLocatorPlan, detectPortalKind, planFromRef, planToElementRef, scopeForChild, type LocatorPlan, type LocatorScope, type LocatorHopPlan, type PortalKind } from './core/locator-plan.js';
export { isComponentStrategyPlan, type ComponentStrategy, type ComponentStrategyPlan, type ComponentStrategyRuntime } from './core/component-strategy.js';
export { ComponentStrategyRegistry } from './core/component-strategy-registry.js';
export { createComponentStrategyPlan, componentPlanFromRefs } from './core/component-plan.js';
export { CypressComponentRuntime, createCypressComponentOps, type CypressComponentOps } from './engine-cypress/componentRuntime.js';
export { PlaywrightEngine, createEngine, type EngineAdapter } from './engine-playwright/engineAdapter.js';
export { toDecorator, generateDecoratorSpec, type ToDecoratorOptions, type DslStep, type DslExpectation } from './dsl/index.js';

// ─── SSO Cookie 类型（登录 + 缓存在 eve-backend，suite 侧仅注入）──────
export type { SsoCookie } from './core/sso-cookie.js';
