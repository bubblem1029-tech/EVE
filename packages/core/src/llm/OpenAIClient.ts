/**
 * OpenAI Client implementation

不需要工具 → LLM.chat()        → 直接调 API，不带 tools
需要工具循环 → LLM.chatWithTools() → 调 OpenAIClient.chat()，tool_choice: auto
需要强制工具 → LLM.invoke()      → 调 OpenAIClient.invoke()，tool_choice: required

 */
import * as z from 'zod/v4'

import { InvokeError, InvokeErrorType } from './errors'
import type { ChatResult, InvokeOptions, InvokeResult, LLMClient, LLMConfig, Message, Tool } from './types'
import { modelPatch, zodToOpenAITool } from './utils'

/**
 * Client for OpenAI compatible APIs
 */
export class OpenAIClient implements LLMClient {
	config: Required<LLMConfig>
	private fetch: typeof globalThis.fetch

	constructor(config: Required<LLMConfig>) {
		this.config = config
		this.fetch = config.customFetch
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		// 1. Convert tools to OpenAI format
		// If a Tool has customJsonSchema, use it directly (detailed schema for LLM)
		// Otherwise, convert from zod inputSchema via zodToOpenAITool
		const openaiTools = Object.entries(tools).map(([name, t]) => {
			if (t.customJsonSchema) {
				return {
					type: 'function' as const,
					function: {
						name,
						description: t.description,
						parameters: t.customJsonSchema,
					},
				}
			}
			return zodToOpenAITool(name, t)
		})

		// Build request body
		let toolChoice: unknown = 'required'
		if (options?.toolChoiceName && !this.config.disableNamedToolChoice) {
			toolChoice = { type: 'function', function: { name: options.toolChoiceName } }
		} else if (this.config.disableNamedToolChoice) {
			toolChoice = undefined
		}

		const requestBody: Record<string, unknown> = {
			model: this.config.model,
			temperature: this.config.temperature,
			messages,
			tools: openaiTools,
			parallel_tool_calls: false,
			...(toolChoice !== undefined && { tool_choice: toolChoice }),
		}

		modelPatch(requestBody)

		// 2. Call API
		let response: Response
		try {
			response = await this.fetch(`${this.config.baseURL}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			const isAbortError = (error as any)?.name === 'AbortError'
			const errorMessage = isAbortError ? 'Network request aborted' : 'Network request failed'
			if (!isAbortError) console.error(error)
			throw new InvokeError(InvokeErrorType.NETWORK_ERROR, errorMessage, error)
		}

		// 3. Handle HTTP errors
		if (!response.ok) {
			const errorData = await response.json().catch()
			const errorMessage =
				(errorData as { error?: { message?: string } }).error?.message || response.statusText

			if (response.status === 401 || response.status === 403) {
				throw new InvokeError(InvokeErrorType.AUTH_ERROR, `Authentication failed: ${errorMessage}`, errorData)
			}
			if (response.status === 429) {
				throw new InvokeError(InvokeErrorType.RATE_LIMIT, `Rate limit exceeded: ${errorMessage}`, errorData)
			}
			if (response.status >= 500) {
				throw new InvokeError(InvokeErrorType.SERVER_ERROR, `Server error: ${errorMessage}`, errorData)
			}
			throw new InvokeError(InvokeErrorType.UNKNOWN, `HTTP ${response.status}: ${errorMessage}`, errorData)
		}

		// 4. Parse and validate response
		const data = await response.json()

		const choice = data.choices?.[0]
		if (!choice) {
			throw new InvokeError(InvokeErrorType.UNKNOWN, 'No choices in response', data)
		}

		// Check finish_reason
		switch (choice.finish_reason) {
			case 'tool_calls':
			case 'function_call':
			case 'stop':
				break
			case 'length':
				throw new InvokeError(InvokeErrorType.CONTEXT_LENGTH, 'Response truncated: max tokens reached', undefined, data)
			case 'content_filter':
				throw new InvokeError(InvokeErrorType.CONTENT_FILTER, 'Content filtered by safety system', undefined, data)
			default:
				throw new InvokeError(InvokeErrorType.UNKNOWN, `Unexpected finish_reason: ${choice.finish_reason}`, undefined, data)
		}

		// Apply normalizeResponse if provided
		const normalizedData = options?.normalizeResponse ? options.normalizeResponse(data) : data
		const normalizedChoice = (normalizedData as any).choices?.[0]

		// Get tool name from response
		const toolCallName = normalizedChoice?.message?.tool_calls?.[0]?.function?.name
		if (!toolCallName) {
			// When LLM returns no valid tool_call (finish_reason: 'stop', empty tool_calls, etc.),
			// treat it as a graceful fallback rather than throwing an error.
			const textContent = normalizedChoice?.message?.content
			// Try to find a suitable tool for synthetic call:
			// 1. Prefer "done" or "AgentOutput" (main loop tools)
			// 2. Fall back to the first available tool (sub-tool calls like VerifyResult)
			const doneTool = tools['done'] || tools['AgentOutput'] || Object.values(tools)[0]
			if (doneTool) {
				// For "done"/"AgentOutput", wrap as { text, success }
				// For other tools, try to parse textContent as JSON; fallback to minimal valid input
				let syntheticArgs: unknown
				const toolName = doneTool === tools['done'] ? 'done'
					: doneTool === tools['AgentOutput'] ? 'AgentOutput'
						: Object.keys(tools)[0]

				if (toolName === 'done' || toolName === 'AgentOutput') {
					syntheticArgs = { text: textContent || '', success: true }
				} else {
					// Try to extract JSON from the text content (LLM sometimes outputs JSON in text)
					if (textContent) {
						const jsonMatch = textContent.match(/\{[\s\S]*\}/)
						if (jsonMatch) {
							try { syntheticArgs = JSON.parse(jsonMatch[0]) } catch { syntheticArgs = {} }
						} else {
							syntheticArgs = {}
						}
					} else {
						syntheticArgs = {}
					}
				}

				const validation = doneTool.inputSchema.safeParse(syntheticArgs)
				const toolInput = validation.success ? validation.data : syntheticArgs
				let toolResult: unknown
				try {
					toolResult = validation.success ? await doneTool.execute(toolInput) : toolInput
				} catch {
					toolResult = toolInput
				}
				return {
					toolCall: {
						name: toolName,
						args: toolInput,
					},
					toolResult,
					usage: {
						promptTokens: data.usage?.prompt_tokens ?? 0,
						completionTokens: data.usage?.completion_tokens ?? 0,
						totalTokens: data.usage?.total_tokens ?? 0,
						cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
						reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
					},
					rawResponse: data,
				}
			}
			throw new InvokeError(InvokeErrorType.NO_TOOL_CALL, 'No tool call found in response', undefined, data)
		}

		const tool = tools[toolCallName]
		if (!tool) {
			throw new InvokeError(InvokeErrorType.UNKNOWN, `Tool "${toolCallName}" not found in tools`, undefined, data)
		}

		// Extract and parse tool arguments
		const argString = normalizedChoice.message?.tool_calls?.[0]?.function?.arguments
		if (!argString) {
			throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, 'No tool call arguments found', undefined, data)
		}

		let parsedArgs: unknown
		try {
			parsedArgs = JSON.parse(argString)
		} catch (jsonError) {
			// LLM sometimes generates slightly malformed JSON (e.g. trailing characters, 
			// mismatched quotes, or extra text after the closing brace).
			// Attempt to recover by extracting the first valid JSON object from the string.
			const recovered = this.tryRecoverJSON(argString)
			if (recovered !== undefined) {
				parsedArgs = recovered
			} else {
				throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, 'Failed to parse tool arguments as JSON', jsonError, data)
			}
		}

		// Validate with schema
		const validation = tool.inputSchema.safeParse(parsedArgs)
		if (!validation.success) {
			console.error(z.prettifyError(validation.error))
			throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, 'Tool arguments validation failed', validation.error, data)
		}
		const toolInput = validation.data

		// 5. Execute tool
		let toolResult: unknown
		try {
			toolResult = await tool.execute(toolInput)
		} catch (e) {
			throw new InvokeError(InvokeErrorType.TOOL_EXECUTION_ERROR, `Tool execution failed: ${(e as Error).message}`, e, data)
		}

		// Return result
		return {
			toolCall: {
				name: toolCallName,
				args: toolInput,
			},
			toolResult,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
				reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
			},
			rawResponse: data,
			rawRequest: requestBody,
		}
	}

	/**
	 * Attempt to recover a valid JSON object from a malformed LLM response.
	 * Handles common LLM JSON errors:
	 * 1. Extra text after closing brace (e.g. "...}{extra")
	 * 2. Trailing commas inside objects
	 * 3. Unbalanced braces — find the deepest matching pair
	 * 4. Mixed quote styles (single quotes instead of double quotes)
	 */
	private tryRecoverJSON(argString: string): unknown | undefined {
		// Strategy 1: Find the first complete JSON object using brace matching
		const firstBrace = argString.indexOf('{')
		if (firstBrace === -1) return undefined

		let depth = 0
		let inString = false
		let escapeNext = false
		for (let i = firstBrace; i < argString.length; i++) {
			const ch = argString[i]
			if (escapeNext) { escapeNext = false; continue }
			if (ch === '\\') { escapeNext = true; continue }
			if (ch === '"' && !escapeNext) { inString = !inString; continue }
			if (inString) continue
			if (ch === '{') depth++
			if (ch === '}') {
				depth--
				if (depth === 0) {
					// Extract the matched JSON object
					const candidate = argString.substring(firstBrace, i + 1)
					try {
						return JSON.parse(candidate)
					} catch {
						// Strategy 2: Fix common issues
						let fixed = candidate
						// Remove trailing commas before } or ]
						fixed = fixed.replace(/,\s*([}\]])/g, '$1')
						// Replace single-quoted property names with double quotes
						fixed = fixed.replace(/'([^']+)'\s*:/g, '"$1":')
						// Replace single-quoted string values with double quotes (careful with nested)
						fixed = fixed.replace(/:\s*'([^']*)'/g, ': "$1"')
						try {
							return JSON.parse(fixed)
						} catch {
							continue // try deeper nesting
						}
					}
				}
			}
		}
		return undefined
	}

	/**
	 * Call the LLM and return the full assistant message without executing any tools.
	 * Used by the agent loop to get the LLM's response and process tool_calls separately.
	 *
	 * This method:
	 * 1. Sends messages + tools to the OpenAI-compatible API
	 * 2. Returns the full assistant Message (with content + tool_calls)
	 * 3. Does NOT execute any tools or validate tool args
	 *
	 * The agent loop handles tool execution via its own ToolRegistry.
	 */
	async chat(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions,
	): Promise<ChatResult> {
		// Convert tools to OpenAI format (same as invoke)
		const openaiTools = Object.entries(tools).map(([name, t]) => {
			if (t.customJsonSchema) {
				return {
					type: 'function' as const,
					function: {
						name,
						description: t.description,
						parameters: t.customJsonSchema,
					},
				}
			}
			return zodToOpenAITool(name, t)
		})

		// Build request body
		let toolChoice: unknown = 'required'
		if (options?.toolChoiceName && !this.config.disableNamedToolChoice) {
			toolChoice = { type: 'function', function: { name: options.toolChoiceName } }
		} else if (this.config.disableNamedToolChoice) {
			toolChoice = undefined
		}

		// For agent loop, we want the LLM to have freedom to respond
		// with text or tool_calls. Use 'auto' instead of 'required'.
		if (!options?.toolChoiceName) {
			toolChoice = 'auto'
		}

		const requestBody: Record<string, unknown> = {
			model: this.config.model,
			temperature: this.config.temperature,
			messages,
			tools: openaiTools,
			parallel_tool_calls: false,
			...(toolChoice !== undefined && { tool_choice: toolChoice }),
		}

		modelPatch(requestBody)

		// Call API
		let response: Response
		try {
			response = await this.fetch(`${this.config.baseURL}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			const isAbortError = (error as any)?.name === 'AbortError'
			const errorMessage = isAbortError ? 'Network request aborted' : 'Network request failed'
			if (!isAbortError) console.error(error)
			throw new InvokeError(InvokeErrorType.NETWORK_ERROR, errorMessage, error)
		}

		// Handle HTTP errors (same as invoke)
		if (!response.ok) {
			const errorData = await response.json().catch()
			const errorMessage =
				(errorData as { error?: { message?: string } }).error?.message || response.statusText
			if (response.status === 401 || response.status === 403) {
				throw new InvokeError(InvokeErrorType.AUTH_ERROR, `Authentication failed: ${errorMessage}`, errorData)
			}
			if (response.status === 429) {
				throw new InvokeError(InvokeErrorType.RATE_LIMIT, `Rate limit exceeded: ${errorMessage}`, errorData)
			}
			if (response.status >= 500) {
				throw new InvokeError(InvokeErrorType.SERVER_ERROR, `Server error: ${errorMessage}`, errorData)
			}
			throw new InvokeError(InvokeErrorType.UNKNOWN, `HTTP ${response.status}: ${errorMessage}`, errorData)
		}

		// Parse response and extract full assistant message
		const data = await response.json()
		const choice = data.choices?.[0]
		if (!choice) {
			throw new InvokeError(InvokeErrorType.UNKNOWN, 'No choices in response', data)
		}

		// Build the assistant Message from the response
		const assistantMessage: Message = {
			role: 'assistant',
			content: choice.message?.content ?? null,
		}

		// Include tool_calls if present
		if (choice.message?.tool_calls?.length) {
			assistantMessage.tool_calls = choice.message.tool_calls.map((tc: any) => ({
				id: tc.id,
				type: 'function' as const,
				function: {
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
			}))
		}

		return {
			message: assistantMessage,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
				reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
			},
			rawResponse: data,
		}
	}
}