import type { Message } from './types'

/**
 * CustomEvent polyfill for Node 18.
 *
 * Node 18 ships EventTarget (used by `LLM extends EventTarget`) but NOT the
 * global CustomEvent class — that only landed in Node 19+. Running on Node 18
 * (e.g. eve-backend's pinned runtime) throws `ReferenceError: CustomEvent is
 * not defined` the moment emitStart/emitEnd fire, which kills every
 * LLM.invoke() call before it ever reaches the network.
 *
 * Installed on globalThis at module load so every unqualified
 * `new CustomEvent(...)` call site picks it up. Browsers and Node 19+ already
 * provide a spec-compliant CustomEvent, so this is a no-op there.
 */
if (typeof (globalThis as any).CustomEvent === 'undefined') {
	class CustomEventPolyfill<T = any> extends Event {
		detail: T | null
		constructor(type: string, params?: CustomEventInit<T>) {
			super(type, params)
			this.detail = params?.detail ?? null
		}
	}
	; (globalThis as any).CustomEvent = CustomEventPolyfill
}

export type LLMCallMethod = 'chat' | 'chatWithTools' | 'invoke'

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
