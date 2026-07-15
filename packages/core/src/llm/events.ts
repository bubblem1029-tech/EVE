/**
 * LLM call lifecycle events — emitted by LLM class for observability bridges.
 *
 * keve-core stays dependency-free; consumers (e.g. eve-llm langfuse-bridge)
 * listen to these events and forward to their own observability backend.
 */

export type LLMCallMethod = 'chat' | 'chatWithTools' | 'invoke'

import type { Message } from './types'

export interface LLMCallStartDetail {
	/** Unique ID to pair start/end events */
	callId: string
	method: LLMCallMethod
	model: string
	/** Number of messages in the request */
	messageCount: number
	/** Tool names available (chatWithTools / invoke only) */
	toolNames?: string[]
	/** Full messages array (for observability) */
	messages: Message[]
	/** ms since epoch */
	timestamp: number
}

export interface LLMCallEndDetail {
	callId: string
	method: LLMCallMethod
	model: string
	usage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
	}
	/** Duration in ms */
	duration: number
	/** Error message if the call failed */
	error?: string
	/** LLM response content (assistant message or tool call result) */
	response?: string
	timestamp: number
}

/** Event name constants */
export const LLM_CALL_START = 'llm-call-start'
export const LLM_CALL_END = 'llm-call-end'
