/**
 * Agent Loop — universal agent execution engine
 *
 * Reference: gemini-cli LocalAgentExecutor (agents/local-executor.ts L120-1518)
 * Key adaptation: uses OpenAIClient.chat() instead of GeminiChat,
 * decoupled tool execution via ToolRegistry, simplified timeout.
 *
 * Core loop:
 * 1. Build messages (system prompt + user query)
 * 2. While (!done):
 *    a. Check termination (max turns, timeout, abort)
 *    b. Call LLM via chatWithTools → get assistant message
 *    c. If no tool_calls → ERROR_NO_COMPLETE_TASK (or handle text-only response)
 *    d. For each tool_call:
 *       - If complete_task → done, extract result
 *       - Otherwise → execute via ToolRegistry → append tool response
 *    e. Emit events (thought_chunk, tool_call_start/end)
 * 3. Return AgentResult with termination mode and output
 */

import type { Message } from '../llm/types'
import type {
	AgentDefinition,
	AgentEvent,
	AgentEventCallback,
	AgentLoopContext,
	AgentResult,
	AgentTerminateMode,
	ToolExecutionContext,
} from './types'
import { COMPLETE_TASK_TOOL_NAME, DEFAULT_MAX_TURNS, DEFAULT_MAX_TIME_MINUTES, TM_GOAL, TM_TIMEOUT, TM_MAX_TURNS, TM_ABORTED, TM_ERROR, TM_ERROR_NO_COMPLETE_TASK, ToolRegistry } from './types'
import { createCompleteTaskTool } from './complete-task'
import type { LLM } from '../llm/index'
import { InvokeError } from '../llm/index'

/**
 * Universal agent execution engine.
 *
 * Usage:
 * ```typescript
 * const loop = new AgentLoop(llm, toolRegistry)
 * const result = await loop.execute(
 *   { name: 'my-agent', systemPrompt: '...', query: 'Do X' },
 *   (event) => { }
 */
const FILE_CONTENT_TRUNCATE = 80

function truncateFileContent(data: Record<string, unknown>, toolName?: string): Record<string, unknown> {
	if (!toolName) return data
	const result: Record<string, unknown> = { ...data }
	// 截断顶层 content（read_files 返回结果等）
	if ((toolName === 'write_file' || toolName === 'edit_file') && typeof data.content === 'string' && data.content.length > FILE_CONTENT_TRUNCATE) {
		result.content = data.content.slice(0, FILE_CONTENT_TRUNCATE) + `... (${data.content.length} chars)`
	}
	// 截断 args.content（tool_call_start 中 write_file/edit_file 的参数）
	if ((toolName === 'write_file' || toolName === 'edit_file') && data.args && typeof (data.args as any).content === 'string' && (data.args as any).content.length > FILE_CONTENT_TRUNCATE) {
		result.args = { ...(data.args as Record<string, unknown>) }
		;(result.args as any).content = (data.args as any).content.slice(0, FILE_CONTENT_TRUNCATE) + `... (${(data.args as any).content.length} chars)`
	}
	if (toolName === 'read_files' && typeof data.result === 'string' && data.result.length > FILE_CONTENT_TRUNCATE) {
		result.result = data.result.slice(0, FILE_CONTENT_TRUNCATE) + `... (${data.result.length} chars)`
	}
	return result
}

export class AgentLoop {
	private llm: LLM
	private toolRegistry: ToolRegistry

	constructor(llm: LLM, toolRegistry: ToolRegistry) {
		this.llm = llm
		this.toolRegistry = toolRegistry
	}

	/**
	 * Execute an agent definition with the given event callback and optional abort signal.
	 *
	 * Reference: gemini-cli LocalAgentExecutor.run() (L537-566) and runInternal() (L568-730)
	 */
	async execute(
		definition: AgentDefinition,
		onEvent?: AgentEventCallback,
		signal?: AbortSignal,
	): Promise<AgentResult> {
		const startTime = Date.now()
		const maxTurns = definition.maxTurns ?? DEFAULT_MAX_TURNS
		const maxTimeMs = (definition.maxTimeMinutes ?? DEFAULT_MAX_TIME_MINUTES) * 60 * 1000
		let turnCounter = 0
		let terminateReason: AgentTerminateMode = TM_ERROR
		let finalResult: string | null = null

		// 1. Build initial messages
		const messages: Message[] = []
		if (definition.systemPrompt) {
			messages.push({ role: 'system', content: definition.systemPrompt })
		}
		const query = definition.query ?? 'Get Started!'
		messages.push({ role: 'user', content: query })

		// 2. Use a local tool registry copy to avoid mutating the shared one
		const localRegistry = new ToolRegistry()
		// Copy all tools from the shared registry
		for (const name of this.toolRegistry.getAllToolNames()) {
			const tool = this.toolRegistry.get(name)
			if (tool) localRegistry.register(tool)
		}

		// Ensure complete_task is registered (check if caller already registered one)
		if (!localRegistry.has(COMPLETE_TASK_TOOL_NAME)) {
			localRegistry.register(createCompleteTaskTool())
		}

		// Determine which tools are available for this agent
		const toolsMap = definition.toolNames
			? localRegistry.getToolsMapSubset([...definition.toolNames, COMPLETE_TASK_TOOL_NAME])
			: localRegistry.getToolsMap()

		// 3. Emit start event
		this.emitEvent(onEvent, 'agent_start', definition.name, {
			agentName: definition.name,
			maxTurns,
			maxTimeMinutes: maxTimeMs / 60000,
			toolNames: Object.keys(toolsMap),
		})

		// 4. Main loop (reference: gemini-cli runInternal L667-726)
		try {
			while (true) {
				// 4a. Check termination conditions
				const terminationCheck = this.checkTermination(
					turnCounter, maxTurns, startTime, maxTimeMs, signal
				)
				if (terminationCheck) {
					terminateReason = terminationCheck
					break
				}

				// 4b. Call LLM
				this.emitEvent(onEvent, 'thought_chunk', definition.name, {
					turn: turnCounter,
					message: `Turn ${turnCounter + 1}/${maxTurns}: Calling model...`,
				})

				const chatResult = await this.llm.chatWithTools(
					messages,
					toolsMap,
					signal,
				)

				// 4c. Process assistant response
				const assistantMessage = chatResult.message
				messages.push(assistantMessage)

				// 4d. Handle text-only response (no tool_calls)
				if (!assistantMessage.tool_calls?.length) {
					// The LLM responded with text instead of calling any tool.
					// This means it didn't call complete_task → ERROR_NO_COMPLETE_TASK.
					// But if there's meaningful text content, we can treat it as the final result.
					const textContent = typeof assistantMessage.content === 'string'
						? assistantMessage.content
						: null

					if (textContent) {
						// The LLM gave a text answer but didn't follow the protocol.
						// Treat it as a soft completion.
						this.emitEvent(onEvent, 'thought_chunk', definition.name, {
							message: 'Model returned text content without calling complete_task. Treating as final answer.',
						})
						finalResult = textContent
						terminateReason = TM_GOAL
					} else {
						terminateReason = TM_ERROR_NO_COMPLETE_TASK
					}
					break
				}

				// 4e. Process each tool_call
				let taskCompleted = false
				for (const toolCall of assistantMessage.tool_calls) {
					const toolName = toolCall.function.name
					let toolArgs: any

					try {
						toolArgs = JSON.parse(toolCall.function.arguments)
					} catch {
						// Handle malformed JSON (common with LLM outputs)
						toolArgs = {}
					}

					// Check if this is the termination signal
					if (toolName === COMPLETE_TASK_TOOL_NAME) {
						finalResult = JSON.stringify(toolArgs)
						taskCompleted = true

						// Append tool response to messages (for history completeness)
						messages.push({
							role: 'tool',
							tool_call_id: toolCall.id,
							name: COMPLETE_TASK_TOOL_NAME,
							content: JSON.stringify({ result: finalResult, taskCompleted: true }),
						})
						break
					}

					// Execute the tool via registry
					this.emitEvent(onEvent, 'tool_call_start', definition.name, {
						callId: toolCall.id,
						tool: toolName,
						args: toolArgs,
						turn: turnCounter,
					}, toolName)

					let toolResult: any
					try {
						const toolContext: ToolExecutionContext = {
							runtime: (globalThis as any).__runtime ?? {},
							cwd: definition.cwd ?? process.cwd(),
							readOnlyPaths: definition.readOnlyPaths,
						}
						toolResult = await localRegistry.execute(toolName, toolArgs, toolContext)
					} catch (error: any) {
						toolResult = { error: error.message || String(error), isError: true }
						this.emitEvent(onEvent, 'agent_error', definition.name, {
							tool: toolName,
							error: error.message,
						})
					}

					this.emitEvent(onEvent, 'tool_call_end', definition.name, {
						callId: toolCall.id,
						tool: toolName,
						result: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
						turn: turnCounter,
					}, toolName)

					// Append tool response to messages
					messages.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						name: toolName,
						content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
					})
				}

				if (taskCompleted) {
					terminateReason = TM_GOAL
					break
				}

				turnCounter++
			}
		} catch (error: any) {
			// Check if it's an abort error
			if (error?.name === 'AbortError' || signal?.aborted) {
				terminateReason = TM_ABORTED
			} else {
				terminateReason = TM_ERROR
				finalResult = null
				// Enhanced error logging for debugging
				const errorDetail = error instanceof InvokeError
					? `[InvokeError type=${error.type} retryable=${error.retryable}] ${error.message}`
					: error?.message || String(error)
				console.error(`[AgentLoop] Agent "${definition.name}" terminated with ERROR: ${errorDetail}`)
				if (error instanceof InvokeError && error.rawResponse) {
					console.error(`[AgentLoop] InvokeError rawResponse:`, JSON.stringify(error.rawResponse).slice(0, 500))
				}
				this.emitEvent(onEvent, 'agent_error', definition.name, {
					error: errorDetail,
					errorType: error?.type || error?.constructor?.name || 'unknown',
					phase: 'execution',
					turn: turnCounter,
				})
			}
		}

		// 5. Emit end event
		this.emitEvent(onEvent, 'agent_end', definition.name, {
			terminateReason,
			turnCount: turnCounter,
			durationMs: Date.now() - startTime,
			output: finalResult ?? undefined,
		})

		// 6. Return result
		return {
			success: terminateReason === TM_GOAL,
			output: finalResult ?? undefined,
			terminateReason,
			turnCount: turnCounter,
			durationMs: Date.now() - startTime,
			error: terminateReason !== TM_GOAL
				? `Agent terminated: ${terminateReason}${terminateReason === TM_ERROR_NO_COMPLETE_TASK ? ' (model stopped calling tools without complete_task)' : ''}`
				: undefined,
		}
	}

	/**
	 * Check if the agent should terminate.
	 * Returns a terminate reason if termination is needed, null otherwise.
	 */
	private checkTermination(
		turnCounter: number,
		maxTurns: number,
		startTime: number,
		maxTimeMs: number,
		signal?: AbortSignal,
	): AgentTerminateMode | null {
		if (turnCounter >= maxTurns) {
			return TM_MAX_TURNS
		}
		if (signal?.aborted) {
			return TM_ABORTED
		}
		if (Date.now() - startTime >= maxTimeMs) {
			return TM_TIMEOUT
		}
		return null
	}

	/**
	 * Emit an event to the callback, if provided.
	 */
	private emitEvent(
		onEvent: AgentEventCallback | undefined,
		type: AgentEvent['type'],
		streamId: string,
		data: Record<string, unknown>,
		toolName?: string,
	): void {
		if (onEvent) {
			const processed = (type === 'tool_call_start' || type === 'tool_call_end')
				? truncateFileContent(data, toolName)
				: data
			onEvent({ type, streamId, data: processed })
		}
	}
}