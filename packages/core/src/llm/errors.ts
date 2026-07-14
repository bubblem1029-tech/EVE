/**
 * Error types and error handling for LLM invocations
 */

export const InvokeErrorType = {
	// Retryable
	NETWORK_ERROR: 'network_error',
	RATE_LIMIT: 'rate_limit',
	SERVER_ERROR: 'server_error',
	NO_TOOL_CALL: 'no_tool_call',
	INVALID_TOOL_ARGS: 'invalid_tool_args',
	TOOL_EXECUTION_ERROR: 'tool_execution_error',

	UNKNOWN: 'unknown',

	// Non-retryable
	AUTH_ERROR: 'auth_error',
	CONTEXT_LENGTH: 'context_length',
	CONTENT_FILTER: 'content_filter',
} as const

export type InvokeErrorType = (typeof InvokeErrorType)[keyof typeof InvokeErrorType]

export class InvokeError extends Error {
	type: InvokeErrorType
	retryable: boolean
	statusCode?: number
	rawError?: unknown
	rawResponse?: unknown

	constructor(type: InvokeErrorType, message: string, rawError?: unknown, rawResponse?: unknown) {
		super(message)
		this.name = 'InvokeError'
		this.type = type
		this.retryable = this.isRetryable(type, rawError)
		this.rawError = rawError
		this.rawResponse = rawResponse
	}

	private isRetryable(type: InvokeErrorType, rawError?: unknown): boolean {
		const isAbortError = (rawError as any)?.name === 'AbortError'
		if (isAbortError) return false

		const retryableTypes: InvokeErrorType[] = [
			InvokeErrorType.NETWORK_ERROR,
			InvokeErrorType.RATE_LIMIT,
			InvokeErrorType.SERVER_ERROR,
			InvokeErrorType.NO_TOOL_CALL,
			InvokeErrorType.INVALID_TOOL_ARGS,
			InvokeErrorType.TOOL_EXECUTION_ERROR,
			InvokeErrorType.UNKNOWN,
		]
		return retryableTypes.includes(type)
	}
}