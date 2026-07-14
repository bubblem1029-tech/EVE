/**
 * @ks-data/agent-core — context module entry point.
 *
 * Provides truncation and token estimation utilities for managing
 * LLM input size within token budgets.
 */

export {
	// Token calculation
	ASCII_TOKENS_PER_CHAR,
	NON_ASCII_TOKENS_PER_CHAR,
	MSG_OVERHEAD_TOKENS,
	DEFAULT_CHARS_PER_TOKEN,
	estimateTextTokens,
	estimateTokenCountSync,
	estimateTokenCountForText,
	calculateTokenCount,
	type TokenEstimationPart,
} from './tokenCalculation';

export {
	// Truncation
	MIN_TARGET_TOKENS,
	MIN_CHARS_FOR_TRUNCATION,
	TEXT_TRUNCATION_PREFIX,
	TOOL_TRUNCATION_PREFIX,
	estimateCharsFromTokens,
	truncateProportionally,
	normalizeFunctionResponse,
	truncateToTokenBudget,
} from './truncation';