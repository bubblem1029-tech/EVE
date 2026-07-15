/**
 * LLM client with MacroTool support
 *
 * Key features:
 * - Direct fetch to OpenAI API (no LangChain dependency)
 * - Zod schema for tool definitions
 * - toolChoiceName support (force specific tool call)
 * - parallel_tool_calls: false (one tool per step)
 * - Retry with error classification
 * - Model-specific patches (Claude, Qwen, GPT, etc.)
 */

import { OpenAIClient } from './OpenAIClient'
import { DEFAULT_TEMPERATURE, LLM_MAX_RETRIES } from './constants'
import { InvokeError, InvokeErrorType } from './errors'
import { LLM_CALL_START, LLM_CALL_END } from './events'
import type { LLMCallStartDetail, LLMCallEndDetail, LLMCallMethod } from './events'
import type { ChatResult, ContentItem, InvokeOptions, InvokeResult, LLMClient, LLMConfig, Message, Tool } from './types'
import { modelPatch, parseXMLExtractionResponse, extractXMLTag } from './utils'

export { InvokeError, InvokeErrorType }
export { parseXMLExtractionResponse, extractXMLTag }
export type { ChatResult, ContentItem, InvokeOptions, InvokeResult, LLMClient, LLMConfig, Message, Tool }
export { LLM_CALL_START, LLM_CALL_END }
export type { LLMCallStartDetail, LLMCallEndDetail, LLMCallMethod }

export function parseLLMConfig(config: LLMConfig): Required<LLMConfig> {
	if (!config.baseURL || !config.model) {
		throw new Error('[EVEAgent] LLM configuration required. Please provide: baseURL, model.')
	}

	return {
		baseURL: config.baseURL,
		model: config.model,
		apiKey: config.apiKey || '',
		temperature: config.temperature ?? DEFAULT_TEMPERATURE,
		maxRetries: config.maxRetries ?? LLM_MAX_RETRIES,
		disableNamedToolChoice: config.disableNamedToolChoice ?? false,
		customFetch: (config.customFetch ?? fetch).bind(globalThis),
	}
}

export class LLM extends EventTarget {
	config: Required<LLMConfig>
	client: LLMClient

	constructor(config: LLMConfig) {
		super()
		this.config = parseLLMConfig(config)
		this.client = new OpenAIClient(this.config)
	}

	// ─── Event helpers ──────────────────────────────────────────────────────

	private emitStart(method: LLMCallMethod, messages: Message[], toolNames?: string[]): string {
		const callId = crypto.randomUUID()
		const detail: LLMCallStartDetail = {
			callId, method, model: this.config.model, messageCount: messages.length, toolNames, messages, timestamp: Date.now(),
		}
		this.dispatchEvent(new CustomEvent(LLM_CALL_START, { detail }))
		return callId
	}

	private emitEnd(callId: string, method: LLMCallMethod, usage: { promptTokens: number; completionTokens: number; totalTokens: number }, startTime: number, error?: string, response?: string): void {
		const detail: LLMCallEndDetail = {
			callId, method, model: this.config.model, usage,
			duration: Date.now() - startTime, error, response, timestamp: Date.now(),
		}
		this.dispatchEvent(new CustomEvent(LLM_CALL_END, { detail }))
	}

	/**
	 * Call LLM API once, invoke tool call once, return the result.
	 * This is the core method used by gui-agent's MacroTool loop.
	 */
	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		const signal = abortSignal || new AbortController().signal
		const callId = this.emitStart('invoke', messages, Object.keys(tools))
		const startTime = Date.now()
		try {
			const result = await withRetry(
				async () => {
					if (signal.aborted) throw new Error('AbortError')
					return await this.client.invoke(messages, tools, signal, options)
				},
				{
					maxRetries: this.config.maxRetries,
					onRetry: (attempt: number) => {
						this.dispatchEvent(new CustomEvent('retry', { detail: { attempt, maxAttempts: this.config.maxRetries } }))
					},
					onError: (error: Error) => {
						this.dispatchEvent(new CustomEvent('error', { detail: { error } }))
					},
				}
			)
			this.emitEnd(callId, 'invoke', result.usage, startTime, undefined, JSON.stringify(result.toolCall))
			return result
		} catch (e) {
			this.emitEnd(callId, 'invoke', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, startTime, (e as Error).message)
			throw e
		}
	}

	/**
	 * Simple chat call — no tools, just text generation.
	 * Used for validation and other non-tool-call LLM tasks.
	 */
	async chat(messages: Message[], abortSignal?: AbortSignal): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
		const callId = this.emitStart('chat', messages)
		const startTime = Date.now()
		const requestBody = {
			model: this.config.model,
			temperature: this.config.temperature,
			messages,
		}

		modelPatch(requestBody)

		try {
			const response = await this.config.customFetch(`${this.config.baseURL}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			})

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}))
				throw new Error(`LLM chat failed: HTTP ${response.status} - ${(errorData as any).error?.message || response.statusText}`)
			}

			const data = await response.json()
			const content = data.choices?.[0]?.message?.content || ''

			const usage = {
				prompt_tokens: data.usage?.prompt_tokens ?? 0,
				completion_tokens: data.usage?.completion_tokens ?? 0,
				total_tokens: data.usage?.total_tokens ?? 0,
			}

			this.emitEnd(callId, 'chat', {
				promptTokens: usage.prompt_tokens,
				completionTokens: usage.completion_tokens,
				totalTokens: usage.total_tokens,
			}, startTime, undefined, content)

			return { content, usage }
		} catch (e) {
			this.emitEnd(callId, 'chat', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, startTime, (e as Error).message)
			throw e
		}
	}

	/**
	 * Agent loop chat — call LLM with tools and return the full assistant message.
	 * Unlike invoke(), this does NOT execute tools. The agent loop handles tool
	 * execution via its own ToolRegistry after getting the response.
	 *
	 * Uses tool_choice: 'auto' by default (LLM can choose text or tool_calls).
	 * Includes retry logic with exponential backoff.
	 */
	async chatWithTools(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<ChatResult> {
		const signal = abortSignal || new AbortController().signal
		const callId = this.emitStart('chatWithTools', messages, Object.keys(tools))
		const startTime = Date.now()
		try {
			const result = await withRetry(
				async () => {
					if (signal.aborted) throw new Error('AbortError')
					return await this.client.chat(messages, tools, signal, options)
				},
				{
					maxRetries: this.config.maxRetries,
					onRetry: (attempt: number) => {
						this.dispatchEvent(new CustomEvent('retry', { detail: { attempt, maxAttempts: this.config.maxRetries } }))
					},
					onError: (error: Error) => {
						this.dispatchEvent(new CustomEvent('error', { detail: { error } }))
					},
				}
			)
			this.emitEnd(callId, 'chatWithTools', result.usage, startTime, undefined, JSON.stringify(result.message))
			return result
		} catch (e) {
			this.emitEnd(callId, 'chatWithTools', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, startTime, (e as Error).message)
			throw e
		}
	}
}

async function withRetry<T>(
	fn: () => Promise<T>,
	settings: {
		maxRetries: number
		onRetry: (attempt: number) => void
		onError: (error: Error) => void
	}
): Promise<T> {
	let attempt = 0
	let lastError: Error | null = null
	while (attempt <= settings.maxRetries) {
		if (attempt > 0) {
			settings.onRetry(attempt)
			// Exponential backoff: 1s, 2s, 4s, 8s...
			const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000)
			console.log(`[Retry] Attempt ${attempt}/${settings.maxRetries}, waiting ${delay}ms...`)
			await new Promise((resolve) => setTimeout(resolve, delay))
		}

		try {
			return await fn()
		} catch (error: unknown) {
			if ((error as any)?.rawError?.name === 'AbortError') throw error

			settings.onError(error as Error)

			if (error instanceof InvokeError && !error.retryable) throw error

			// Rate limit (429): use longer backoff
			if (error instanceof InvokeError && error.type === 'rate_limit') {
				const rateLimitDelay = Math.min(5000 * attempt + 5000, 60000) // 5s, 10s, 15s...
				console.log(`[Retry] Rate limit hit, waiting ${rateLimitDelay}ms...`)
				await new Promise((resolve) => setTimeout(resolve, rateLimitDelay))
			}

			lastError = error as Error
			attempt++
		}
	}

	throw lastError!
}