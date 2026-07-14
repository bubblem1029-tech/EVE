/**
 * Token estimation constants — ported from gemini-cli (Apache-2.0).
 *
 * ASCII characters (0-127) are roughly 3-4 chars per token.
 * We use 0.33 (~3 chars/token) as a conservative baseline for mixed text and code.
 */
export const ASCII_TOKENS_PER_CHAR = 0.33;

/**
 * Non-ASCII characters (including CJK) are often 1-2 tokens per char.
 * We use 1.5 as a conservative estimate to avoid underestimation.
 */
export const NON_ASCII_TOKENS_PER_CHAR = 1.5;

/** Structural overhead per message turn (role prefixes, separators). */
export const MSG_OVERHEAD_TOKENS = 5;

/** Default chars-per-token ratio used as fallback. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Maximum number of characters to process with the full character-by-character heuristic.
 * Above this, we use a faster approximation to avoid performance bottlenecks.
 */
const MAX_CHARS_FOR_FULL_HEURISTIC = 100_000;

/**
 * Heuristic estimation of tokens for a text string.
 * Uses char-by-char scan for strings ≤ 100K chars, length/charsPerToken for larger strings.
 */
export function estimateTextTokens(
	text: string,
	charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
	if (text.length > MAX_CHARS_FOR_FULL_HEURISTIC) {
		return text.length / charsPerToken;
	}

	let tokens = 0;
	const asciiTokensPerChar = 1 / charsPerToken;

	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) <= 127) {
			tokens += asciiTokensPerChar;
		} else {
			tokens += NON_ASCII_TOKENS_PER_CHAR;
		}
	}
	return tokens;
}

/**
 * Synchronous token-count estimation for an array of message-like parts.
 * Adapted from gemini-cli's `estimateTokenCountSync`, but uses our own
 * message-part representation instead of Gemini's `Part` type.
 *
 * Each "part" can be:
 *   - `{ text: string }`          → text token estimation
 *   - `{ functionResponse: ... }` → tool response estimation
 *   - other objects               → JSON string length / charsPerToken fallback
 */
export interface TokenEstimationPart {
	text?: string;
	functionResponse?: {
		name?: string;
		response?: unknown;
	};
	[key: string]: unknown;
}

export function estimateTokenCountSync(
	parts: TokenEstimationPart[],
	charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
	let totalTokens = 0;

	for (const part of parts) {
		if (typeof part.text === 'string') {
			totalTokens += estimateTextTokens(part.text, charsPerToken);
		} else if (part.functionResponse) {
			const fr = part.functionResponse;
			let frTokens = (fr.name?.length ?? 0) / charsPerToken;
			const response = fr.response;

			if (typeof response === 'string') {
				frTokens += response.length / charsPerToken;
			} else if (response !== undefined && response !== null) {
				frTokens += JSON.stringify(response).length / charsPerToken;
			}

			totalTokens += frTokens;
		} else {
			// Fallback: JSON-serialize the whole part and estimate by length.
			totalTokens += JSON.stringify(part).length / charsPerToken;
		}
	}

	return Math.floor(totalTokens);
}

/**
 * Asynchronous token count calculation for a text string or message array.
 * For text-only content, this simply delegates to `estimateTokenCountSync`.
 * For content with media references (future: image/PDF), we would call
 * an external tokenizer — but for now, everything is text-only estimation.
 *
 * This replaces gemini-cli's `calculateRequestTokenCount` which uses
 * the Gemini `countTokens` API. We don't have an equivalent API for
 * our internal OpenAI-compatible proxy, so we rely on heuristic estimation.
 */
export async function calculateTokenCount(
	content: string | TokenEstimationPart[],
	charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): Promise<number> {
	if (typeof content === 'string') {
		return estimateTokenCountSync([{ text: content }], charsPerToken);
	}
	return estimateTokenCountSync(content, charsPerToken);
}

/**
 * Convenience: estimate token count for a single text string.
 */
export function estimateTokenCountForText(
	text: string,
	charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
	return Math.floor(estimateTextTokens(text, charsPerToken));
}