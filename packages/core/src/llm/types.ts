/**
 * Core types for LLM integration
 */
import type * as z from 'zod/v4'

/**
 * Content item for multimodal messages
 */
export type ContentItem =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

/**
 * Message format - OpenAI standard
 */
export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content?: string | ContentItem[] | null
	tool_calls?: {
		id: string
		type: 'function'
		function: {
			name: string
			arguments: string
		}
	}[]
	tool_call_id?: string
	name?: string
}

/**
 * Tool definition - uses Zod schema
 * Optional customJsonSchema: If provided, this JSON Schema is sent to the LLM
 * instead of converting inputSchema via zodToOpenAITool.
 * This allows detailed tool parameter descriptions while keeping zod validation loose.
 */
export interface Tool<TParams = any, TResult = any> {
	description?: string
	inputSchema: z.ZodType<TParams>
	execute: (args: TParams) => Promise<TResult>
	/** Custom JSON Schema sent to LLM (overrides zodToOpenAITool conversion) */
	customJsonSchema?: Record<string, any>
}

/**
 * Invoke options for LLM call
 */
export interface InvokeOptions {
	/**
	 * Force LLM to call a specific tool by name.
	 * If provided: tool_choice = { type: 'function', function: { name: toolChoiceName } }
	 * If not provided: tool_choice = 'required'
	 */
	toolChoiceName?: string
	/**
	 * Response normalization function.
	 */
	normalizeResponse?: (response: any) => any
}

/**
 * Invoke result
 */
export interface InvokeResult<TResult = unknown> {
	toolCall: {
		name: string
		args: any
	}
	toolResult: TResult
	usage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
		cachedTokens?: number
		reasoningTokens?: number
	}
	rawResponse?: unknown
	rawRequest?: unknown
}

/**
 * Chat result — returns the full assistant message without executing tools.
 * Used by the agent loop to get the LLM's response and then process tool_calls separately.
 */
export interface ChatResult {
	/** The full assistant message from the LLM response. */
	message: Message
	/** Token usage information. */
	usage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
		cachedTokens?: number
		reasoningTokens?: number
	}
	/** The raw API response data. */
	rawResponse?: unknown
}

/**
 * LLM Client interface
 */
export interface LLMClient {
	invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult>

	/**
	 * Call the LLM and return the full assistant message.
	 * Unlike invoke(), this does NOT execute any tools — it just returns
	 * the raw response. The caller (agent loop) processes tool_calls and
	 * executes tools separately via its own ToolRegistry.
	 */
	chat(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<ChatResult>
}

/**
 * LLM configuration
 */
export interface LLMConfig {
	baseURL: string
	model: string
	apiKey?: string
	temperature?: number
	maxRetries?: number
	disableNamedToolChoice?: boolean
	customFetch?: typeof globalThis.fetch
}