/**
 * Agent Loop Core Types
 *
 * Reference: gemini-cli LocalAgentExecutor + AgentProtocol
 * Adapted for OpenAI-compatible API (internal proxy at xxx)
 *
 * Key differences from gemini-cli:
 * - LLM calls use OpenAIClient instead of GeminiChat
 * - Tool definitions reuse core/llm/types.ts Tool interface
 * - No Gemini-specific Content/Part types — use OpenAI Message format
 * - Simplified timeout (no DeadlineTimer pause/resume — we don't wait for user confirmation)
 */

import type { LLMClient, Tool } from '../llm/types'
import type { RuntimeEnvironment } from './runtime'

// ===== Constants (reference: gemini-cli DEFAULT_MAX_TURNS/DEFAULT_MAX_TIME_MINUTES) =====

/** Default maximum number of conversational turns for an agent. */
export const DEFAULT_MAX_TURNS = 30

/** Default maximum execution time for an agent in minutes. */
export const DEFAULT_MAX_TIME_MINUTES = 10

/** Tool name for signaling task completion (reference: gemini-cli CompleteTaskTool) */
export const COMPLETE_TASK_TOOL_NAME = 'complete_task'

// ===== Agent Definition =====

/**
 * Definition of an agent to execute via the loop.
 * Reference: gemini-cli LocalAgentDefinition (agents/types.ts L214-285)
 *
 * Simplified from gemini-cli: removed kind, promptConfig, modelConfig, runConfig,
 * workspaceDirectories, memoryInboxAccess, mcpServers, processOutput, onBeforeTurn.
 * These features can be added incrementally as needed.
 */
export interface AgentDefinition {
	/** Unique identifier for the agent. */
	name: string
	/** Human-readable description. */
	description: string
	/** System prompt injected as the first message. Can include SKILL.md content. */
	systemPrompt?: string
	/** The initial user query/message. Defaults to 'Get Started!' if not provided. */
	query?: string
	/** Maximum number of conversational turns. Defaults to DEFAULT_MAX_TURNS (30). */
	maxTurns?: number
	/** Maximum execution time in minutes. Defaults to DEFAULT_MAX_TIME_MINUTES (10). */
	maxTimeMinutes?: number
	/** Tool names to restrict to. If omitted, all registered tools are available. */
	toolNames?: string[]
	/** Paths that are read-only — bash tool will block write operations targeting these directories */
	readOnlyPaths?: string[]
	/** Working directory for tool execution. Defaults to process.cwd() */
	cwd?: string
}

// ===== Agent Loop Context =====

/**
 * Execution context for the agent loop.
 * Provides the LLM client, tool registry, and config needed to run an agent.
 */
export interface AgentLoopContext {
	/** LLM client for calling the model. Uses core/llm/OpenAIClient. */
	llmClient: LLMClient
	/** Tool registry for executing tool calls from the model. */
	toolRegistry: ToolRegistry
	/** Application configuration. */
	config: Record<string, unknown>
}

// ===== Event System =====

/**
 * Callback for receiving agent events during execution.
 * Events are emitted at key points: start, tool calls, thoughts, end, errors.
 */
export type AgentEventCallback = (event: AgentEvent) => void

/**
 * Events emitted during agent execution.
 * Reference: gemini-cli AgentEvents (agent/types.ts L104-131) and SubagentActivityEvent (agents/types.ts L84-89)
 *
 * Simplified from gemini-cli: merged multiple event interfaces into one,
 * removed display-specific fields (DisplayContent, ToolDisplayFormat).
 */
export interface AgentEvent {
	type: 'agent_start' | 'tool_call_start' | 'tool_call_end'
	| 'thought_chunk' | 'agent_end' | 'agent_error'
	/** Stream identifier (typically the agent name). */
	streamId: string
	/** Event-specific data. */
	data: Record<string, unknown>
}

// ===== Termination Modes =====

/**
 * Describes how an agent's execution ended.
 * Reference: gemini-cli AgentTerminateMode (agents/types.ts L24-31)
 */
// Inline termination mode constants (vite tree-shaking removes cross-module const objects)
export const TM_GOAL = 'GOAL'
export const TM_TIMEOUT = 'TIMEOUT'
export const TM_MAX_TURNS = 'MAX_TURNS'
export const TM_ABORTED = 'ABORTED'
export const TM_ERROR = 'ERROR'
export const TM_ERROR_NO_COMPLETE_TASK = 'ERROR_NO_COMPLETE_TASK'
export type AgentTerminateMode = typeof TM_GOAL | typeof TM_TIMEOUT | typeof TM_MAX_TURNS | typeof TM_ABORTED | typeof TM_ERROR | typeof TM_ERROR_NO_COMPLETE_TASK

// ===== Agent Result =====

/**
 * The final result of an agent's execution.
 * Reference: gemini-cli OutputObject (agents/types.ts L36-41)
 */
export interface AgentResult {
	/** Whether the agent completed successfully (GOAL termination). */
	success: boolean
	/** The final output string from complete_task, if available. */
	output?: string
	/** How the agent's execution ended. */
	terminateReason: AgentTerminateMode
	/** Number of conversational turns completed. */
	turnCount: number
	/** Total execution time in milliseconds. */
	durationMs: number
	/** Error message if the agent failed. */
	error?: string
}

export interface ToolExecutionContext {
	/** Runtime environment (binary paths, config dirs, env vars) */
	runtime: RuntimeEnvironment
	/** Working directory for command execution */
	cwd: string
	/** Timeout in milliseconds */
	timeout?: number
	/** 🆕 Paths that are read-only — bash tool will block write operations to these directories */
	readOnlyPaths?: string[]
}

// ===== Tool Definition =====

/**
 * A tool definition for the agent loop's registry.
 * Compatible with core/llm/types.ts Tool interface.
 */
export interface ToolDefinition {
	/** Tool name (used as the key in OpenAI function_call). */
	name: string
	/** Human-readable description sent to the LLM. */
	description: string
	/** Zod schema for input validation and OpenAI parameter generation. */
	inputSchema: z.ZodType<any>
	/** Execute the tool with validated arguments. */
	execute: (args: any, context?: ToolExecutionContext) => Promise<any>
	/** Custom JSON Schema for the LLM (overrides zod conversion). */
	customJsonSchema?: Record<string, any>
}

// Placeholder — real import added when zod is resolved
import type * as z from 'zod/v4'

/**
 * Tool registry for managing and executing tools during agent execution.
 * Reference: gemini-cli ToolRegistry (tools/tool-registry.ts)
 *
 * Simplified: no message bus, no confirmation policy, no sort, no MCP integration.
 * These can be added incrementally.
 */
export class ToolRegistry {
	private tools: Map<string, ToolDefinition> = new Map()

	/** Register a tool definition. */
	register(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool)
	}

	/** Unregister a tool by name. */
	unregister(name: string): void {
		this.tools.delete(name)
	}

	/** Get all registered tool names. */
	getAllToolNames(): string[] {
		return Array.from(this.tools.keys())
	}

	/** Convert registered tools to the core/llm/types.ts Tool map format for LLM calls. */
	getToolsMap(): Record<string, Tool> {
		const result: Record<string, Tool> = {}
		for (const [name, def] of this.tools) {
			result[name] = {
				description: def.description,
				inputSchema: def.inputSchema,
				execute: def.execute,
				customJsonSchema: def.customJsonSchema,
			}
		}
		return result
	}

	/** Get a subset of tools by name (for agent's toolNames restriction). */
	getToolsMapSubset(names: string[]): Record<string, Tool> {
		const result: Record<string, Tool> = {}
		for (const name of names) {
			const def = this.tools.get(name)
			if (def) {
				result[name] = {
					description: def.description,
					inputSchema: def.inputSchema,
					execute: def.execute,
					customJsonSchema: def.customJsonSchema,
				}
			}
		}
		return result
	}

	/** Execute a registered tool by name with the given arguments and optional context. */
	async execute(name: string, args: any, context?: ToolExecutionContext): Promise<any> {
		const tool = this.tools.get(name)
		if (!tool) {
			throw new Error(`Tool not found: ${name}`)
		}
		// Validate args with zod schema
		const validation = tool.inputSchema.safeParse(args)
		const validatedArgs = validation.success ? validation.data : args
		return tool.execute(validatedArgs, context)
	}

	/** Check if a tool is registered. */
	has(name: string): boolean {
		return this.tools.has(name)
	}

	/** Get a tool definition by name. */
	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name)
	}
}