/**
 * Truncation utilities — ported from gemini-cli (Apache-2.0), adapted for
 * our project's message format (OpenAI-compatible instead of Gemini Part).
 *
 * Key differences from the original:
 * - No `Part` type from `@google/genai` → use `TokenEstimationPart` from tokenCalculation
 * - `normalizeFunctionResponse` works on plain JSON objects instead of Gemini's Part structure
 */

import {
	estimateTokenCountSync,
	type TokenEstimationPart,
} from './tokenCalculation';

/** Minimum target tokens to preserve when truncating. */
export const MIN_TARGET_TOKENS = 10;

/** Minimum character count before truncation is applied. */
export const MIN_CHARS_FOR_TRUNCATION = 100;

/** Prefix marker for truncated text content. */
export const TEXT_TRUNCATION_PREFIX =
	'[Message Normalized: Exceeded size limit]';

/** Prefix marker for truncated tool output. */
export const TOOL_TRUNCATION_PREFIX =
	'[Message Normalized: Tool output exceeded size limit]';

/**
 * Estimates the character limit for a target token count, accounting for ASCII vs Non-ASCII.
 * Uses a weighted average based on the provided text to decide how many characters
 * fit into the target token budget.
 *
 * Ported from gemini-cli's `estimateCharsFromTokens`.
 */
export function estimateCharsFromTokens(
	text: string,
	targetTokens: number,
): number {
	if (text.length === 0) return 0;

	// Count ASCII vs Non-ASCII in a sample of the text.
	let asciiCount = 0;
	const sampleLen = Math.min(text.length, 1000);
	for (let i = 0; i < sampleLen; i++) {
		if (text.charCodeAt(i) <= 127) {
			asciiCount++;
		}
	}

	const asciiRatio = asciiCount / sampleLen;
	// Weighted tokens per character:
	const avgTokensPerChar =
		asciiRatio * 0.33 + (1 - asciiRatio) * 1.5; // ASCII_TOKENS_PER_CHAR + NON_ASCII_TOKENS_PER_CHAR

	// Characters = Tokens / (Tokens per Character)
	return Math.floor(targetTokens / avgTokensPerChar);
}

/**
 * Truncates a string to a target length, keeping a proportional amount of the head and tail,
 * and prepending a prefix marker.
 *
 * By default, 20% of the budget goes to the head (beginning) and 80% to the tail (end),
 * which preserves recent context while keeping some original context.
 *
 * Ported from gemini-cli's `truncateProportionally`.
 */
export function truncateProportionally(
	str: string,
	targetChars: number,
	prefix: string = TEXT_TRUNCATION_PREFIX,
	headRatio: number = 0.2,
): string {
	if (str.length <= targetChars) return str;

	const ellipsis = '\n...\n';
	const overhead = prefix.length + ellipsis.length + 1; // +1 for newline after prefix
	const availableChars = Math.max(0, targetChars - overhead);

	if (availableChars <= 0) {
		return prefix; // Safe fallback if target is extremely small
	}

	const headChars = Math.floor(availableChars * headRatio);
	const tailChars = availableChars - headChars;

	return `${prefix}\n${str.substring(0, headChars)}${ellipsis}${str.substring(str.length - tailChars)}`;
}

/**
 * Safely normalizes a function/tool response by truncating large string values
 * within the response object while maintaining its JSON structure (preserving keys
 * like stdout, stderr, etc.).
 *
 * This is the OpenAI-compatible adaptation of gemini-cli's `normalizeFunctionResponse`.
 * Instead of operating on Gemini's `Part.functionResponse`, it operates on plain
 * JSON objects (the `result` field of OpenAI tool_call responses).
 *
 * @param responseObj - The tool response object (e.g., { stdout: "...", stderr: "..." })
 * @param ratio - Retention ratio (e.g., 0.3 means keep ~30% of tokens)
 * @param headRatio - Proportion of head content to keep (default 0.2)
 * @param savedPath - Optional path where full output was saved (added as footer)
 * @param intentSummary - Optional LLM-generated summary appended after truncation
 * @returns The normalized response object with large values truncated
 */
export function normalizeFunctionResponse(
	responseObj: Record<string, unknown>,
	ratio: number,
	headRatio: number = 0.2,
	savedPath?: string,
	intentSummary?: string,
): Record<string, unknown> {
	if (typeof responseObj !== 'object' || responseObj === null) {
		return responseObj;
	}

	let hasChanges = false;
	const newResponse: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(responseObj)) {
		if (typeof value === 'string' && value.length > MIN_CHARS_FOR_TRUNCATION) {
			const valueTokens = estimateTokenCountSync([{ text: value }]);
			const targetValueTokens = Math.max(
				MIN_TARGET_TOKENS,
				Math.floor(valueTokens * ratio),
			);
			const targetChars = estimateCharsFromTokens(value, targetValueTokens);

			if (value.length > targetChars) {
				let truncated = truncateProportionally(
					value,
					targetChars,
					TOOL_TRUNCATION_PREFIX,
					headRatio,
				);
				if (savedPath) {
					truncated += `\n\nFull output saved to: ${savedPath}`;
				}
				if (intentSummary) {
					truncated += intentSummary;
				}
				newResponse[key] = truncated;
				hasChanges = true;
			} else {
				newResponse[key] = value;
			}
		} else {
			newResponse[key] = value;
		}
	}

	return hasChanges ? newResponse : responseObj;
}

/**
 * Truncate a text string to fit within a token budget.
 * Converts the token budget to a character budget using `estimateCharsFromTokens`,
 * then applies `truncateProportionally`.
 *
 * This is a convenience function combining token estimation + truncation,
 * useful for truncating LLM input (a11y tree snapshots, PRD content, etc.)
 * to fit within the model's token limit.
 *
 * @param text - The text to potentially truncate
 * @param maxTokens - Maximum token budget
 * @param prefix - Prefix marker for truncated text
 * @param headRatio - Proportion of head to keep
 * @returns Truncated text if exceeding budget, original text otherwise
 */
export function truncateToTokenBudget(
	text: string,
	maxTokens: number,
	prefix: string = TEXT_TRUNCATION_PREFIX,
	headRatio: number = 0.2,
): string {
	if (text.length <= MIN_CHARS_FOR_TRUNCATION) return text;

	const estimatedTokens = estimateTokenCountSync([{ text }]);
	if (estimatedTokens <= maxTokens) return text;

	const targetChars = estimateCharsFromTokens(text, maxTokens);
	return truncateProportionally(text, targetChars, prefix, headRatio);
}