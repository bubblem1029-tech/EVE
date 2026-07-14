export { generateReportData, type ReportDataOptions, parseCaseIdFromTitle, extractAllSpecs, buildCaseResultMap, parseYamlSimple } from './core/generateReport/reportData';

// Re-Act loop (refactored to page-agent)
export { KevePageAgent, reactLoop, type AgentResult, type AgentStepEvent, type AgentEvent, type AgentOptions, type AgentHooks } from './page-agent/agent';
export { tools, packMacroToolSchema, type PageAgentTool, type MacroToolInput, type ToolContext } from './page-agent/tools';

// Aspect registry (new)
export { keveAspect, KeveAspectRegistry, type AspectPhase, type AspectDefinition, type GoalContext, type GoalResult } from './core/keve-aspect';

// Action log (new)
export { ActionLogWriter, type ActionLogRecord } from './core/action-log-writer';

// Learned actions (new)
export { learnedActions, LearnedActions } from './core/learned-actions';

// Playwright config generator
export { generatePwConfig, resolveConfigOutputPath, findExistingConfig, type PwConfigOptions } from './core/pw-config';

// Run API
export { run, KeveRunError, type RunOptions, type RunResult } from './commands/run';

// Script refine (new)
// script-refine is now part of page-agent/tools
