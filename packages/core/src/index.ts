/**
 * Core module — runtime infrastructure for the agent
 *
 * Layers:
 * - llm/     — OpenAI-compatible LLM client (invoke + chat)
 * - context/ — Token calculation + truncation (from gemini-cli)
 * - agent-loop/ — Universal agent execution engine (while loop + LLM + tools)
 * - skill/   — SKILL.md discovery, loading, and execution (Progressive Disclosure)
 * - tools/   — Built-in tool library (bash, codegraph, git, keve-read-doc, etc.)
 */

// LLM
export { LLM, InvokeError, InvokeErrorType } from './llm/index'
export { LLM_CALL_START, LLM_CALL_END } from './llm/index'
export type {
	ChatResult,
	ContentItem,
	InvokeOptions,
	InvokeResult,
	LLMClient,
	LLMConfig,
	Message,
	Tool,
	LLMCallStartDetail,
	LLMCallEndDetail,
	LLMCallMethod,
} from './llm/index'

// Context
export {
	estimateCharsFromTokens,
	truncateProportionally,
	normalizeFunctionResponse,
	estimateTokenCountSync,
} from './context/index'
export type { TokenEstimationPart } from './context/index'

// Agent Loop
export { AgentLoop } from './agent-loop/index'
export type {
	AgentDefinition,
	AgentEvent,
	AgentEventCallback,
	AgentLoopContext,
	AgentResult,
	AgentTerminateMode,
	ToolDefinition,
} from './agent-loop/index'
export {
	COMPLETE_TASK_TOOL_NAME,
	DEFAULT_MAX_TURNS,
	DEFAULT_MAX_TIME_MINUTES,
	createCompleteTaskTool,
	ToolRegistry,
	detectRuntimeEnvironment,
} from './agent-loop/index'
export type { RuntimeEnvironment, ToolExecutionContext, CompleteTaskToolOptions } from './agent-loop/index'

// Agent
export { AgentLoader, AgentFactory } from './agent/index'
export type { AgentRegistryDefinition } from './agent/index'

// Skill
export { SkillLoader } from './skill/index'
export type { SkillDefinition } from './skill/index'

// Tools (general tools, aligned with gemini-cli)
export { createDefaultToolRegistry, getBuiltinToolNames } from './tools/index'