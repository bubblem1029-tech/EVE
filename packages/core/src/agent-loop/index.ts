/**
 * Agent Loop module — universal agent execution engine
 *
 * Provides the core agent loop runtime that executes an AgentDefinition
 * by calling the LLM in a while loop, processing tool_calls, and
 * terminating when complete_task is called or limits are reached.
 *
 * Reference: gemini-cli LocalAgentExecutor (agents/local-executor.ts)
 */

export { AgentLoop } from './loop'
export { createCompleteTaskTool, CompleteTaskSchema } from './complete-task'
export type { CompleteTaskToolOptions } from './complete-task'
export type {
	AgentDefinition,
	AgentEvent,
	AgentEventCallback,
	AgentLoopContext,
	AgentResult,
	AgentTerminateMode,
	ToolDefinition,
	ToolExecutionContext,
} from './types'
export {
	ToolRegistry,
	// Constants
	COMPLETE_TASK_TOOL_NAME,
	DEFAULT_MAX_TURNS,
	DEFAULT_MAX_TIME_MINUTES,
} from './types'

// Runtime Environment
export { detectRuntimeEnvironment } from './runtime'
export type { RuntimeEnvironment } from './runtime'