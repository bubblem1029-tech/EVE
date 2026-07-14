/**
 * Utility functions for LLM integration
 */
import { jsonrepair } from 'jsonrepair';
import * as z from 'zod/v4'
import type { Tool } from './types'

/**
 * Convert Zod schema to OpenAI tool format
 */
export function zodToOpenAITool(name: string, tool: Tool) {
	return {
		type: 'function' as const,
		function: {
			name,
			description: tool.description,
			parameters: z.toJSONSchema(tool.inputSchema, { target: 'openapi-3.0' }),
		},
	}
}

/**
 * Patch model specific parameters
 */
export function modelPatch(body: Record<string, any>) {
	const model: string = body.model || ''
	if (!model) return body

	const modelName = normalizeModelName(model)

	if (modelName.startsWith('qwen') || modelName.startsWith('app-')) {
		body.temperature = Math.max(body.temperature || 0, 1.0)
		body.enable_thinking = false
	}

	if (modelName.startsWith('claude')) {
		body.thinking = { type: 'disabled' }
		if (body.tool_choice === 'required') {
			body.tool_choice = { type: 'any' }
		} else if (body.tool_choice?.function?.name) {
			body.tool_choice = { type: 'tool', name: body.tool_choice.function.name }
		}
	}

	if (modelName.startsWith('grok')) {
		delete body.tool_choice
		body.thinking = { type: 'disabled', effort: 'minimal' }
		body.reasoning = { enabled: false, effort: 'low' }
	}

	if (modelName.startsWith('gpt')) {
		if (modelName.startsWith('gpt-52')) {
			body.reasoning_effort = 'none'
		} else if (modelName.startsWith('gpt-51')) {
			body.reasoning_effort = 'none'
		} else if (modelName.startsWith('gpt-54')) {
			delete body.reasoning_effort
		} else if (modelName.startsWith('gpt-5-mini')) {
			body.reasoning_effort = 'low'
			body.temperature = 1
		} else if (modelName.startsWith('gpt-5')) {
			body.reasoning_effort = 'low'
		}
	}

	if (modelName.startsWith('gemini')) {
		body.reasoning_effort = 'minimal'
	}

	if (modelName.startsWith('minimax')) {
		body.temperature = Math.max(body.temperature || 0, 0.01)
		if (body.temperature > 1) body.temperature = 1
		delete body.parallel_tool_calls
	}

	return body
}

function normalizeModelName(modelName: string): string {
	let normalizedName = modelName.toLowerCase()
	if (normalizedName.includes('/')) {
		normalizedName = normalizedName.split('/')[1]
	}
	normalizedName = normalizedName.replace(/_/g, '')
	normalizedName = normalizedName.replace(/\./g, '')
	return normalizedName
}

/**
 * Parse XML response from LLM and convert to AIDataExtractionResponse
 */
export function parseXMLExtractionResponse<T>(
	xmlString: string,
): any {
	const thought = extractXMLTag(xmlString, 'thought');
	const dataJsonStr = extractXMLTag(xmlString, 'data-json');
	const errorsStr = extractXMLTag(xmlString, 'errors');

	let data: any = '';
	if (dataJsonStr) {
		try {
			data = safeParseJson(dataJsonStr, undefined) as T;
		} catch (e) {
			throw new Error(`Failed to parse data-json: ${e}`);
		}
	}

	// Parse errors (optional)
	let errors: string[] | undefined;
	if (errorsStr) {
		try {
			const parsedErrors = safeParseJson(errorsStr, undefined);
			if (Array.isArray(parsedErrors)) {
				errors = parsedErrors;
			}
		} catch (e) {
			// If errors parsing fails, just ignore it
		}
	}

	return {
		...(thought ? { thought } : {}),
		data: data || xmlString,
		...(errors && errors.length > 0 ? { errors } : {}),
	};
}

export function safeParseJson(
	input: string,
	modelFamily: any | undefined,
) {
	const cleanJsonString = extractJSONFromCodeBlock(input);
	// match the point
	if (cleanJsonString?.match(/\((\d+),(\d+)\)/)) {
		return cleanJsonString
			.match(/\((\d+),(\d+)\)/)
			?.slice(1)
			.map(Number);
	}

	let parsed: any;
	let lastError: unknown;
	try {
		parsed = JSON.parse(cleanJsonString);
		return normalizeJsonObject(parsed);
	} catch (error) {
		lastError = error;
	}
	try {
		parsed = JSON.parse(jsonrepair(cleanJsonString));
		return normalizeJsonObject(parsed);
	} catch (error) {
		lastError = error;
	}

	if (modelFamily === 'doubao-vision' || isUITars(modelFamily)) {
		const jsonString = preprocessDoubaoBboxJson(cleanJsonString);
		try {
			parsed = JSON.parse(jsonrepair(jsonString));
			return normalizeJsonObject(parsed);
		} catch (error) {
			lastError = error;
		}
	}
	throw Error(
		`failed to parse LLM response into JSON. Error - ${String(
			lastError ?? 'unknown error',
		)}. Response - \n ${input}`,
	);
}


/**
 * Extract content from an XML tag in a string
 * @param xmlString - The XML string to parse
 * @param tagName - The name of the tag to extract (case-insensitive)
 * @returns The trimmed content of the tag, or undefined if not found
 */
export function extractXMLTag(
	xmlString: string,
	tagName: string,
): string | undefined {
	const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i');
	const match = xmlString.match(regex);
	return match ? match[1].trim() : undefined;
}

function extractJSONFromCodeBlock(response: string) {
	try {
		// First, try to match a JSON object directly in the response
		const jsonMatch = response.match(/^\s*(\{[\s\S]*\})\s*$/);
		if (jsonMatch) {
			return jsonMatch[1];
		}

		// If no direct JSON object is found, try to extract JSON from a code block
		const codeBlockMatch = response.match(
			/```(?:json)?\s*(\{[\s\S]*?\})\s*```/,
		);
		if (codeBlockMatch) {
			return codeBlockMatch[1];
		}

		// If no code block is found, try to find a JSON-like structure in the text
		const jsonLikeMatch = response.match(/\{[\s\S]*\}/);
		if (jsonLikeMatch) {
			return jsonLikeMatch[0];
		}
	} catch { }
	// If no JSON-like structure is found, return the original response
	return response;
}

/**
 * Normalize a parsed JSON object by trimming whitespace from:
 * 1. All object keys (e.g., " prompt " -> "prompt")
 * 2. All string values (e.g., " Tap " -> "Tap")
 * This handles LLM output that may include leading/trailing spaces.
 */
function normalizeJsonObject(obj: any): any {
	// Handle null and undefined
	if (obj === null || obj === undefined) {
		return obj;
	}

	// Handle arrays - recursively normalize each element
	if (Array.isArray(obj)) {
		return obj.map((item) => normalizeJsonObject(item));
	}

	// Handle objects
	if (typeof obj === 'object') {
		const normalized: any = {};

		for (const [key, value] of Object.entries(obj)) {
			// Trim the key to remove leading/trailing spaces
			const trimmedKey = key.trim();

			// Recursively normalize the value
			let normalizedValue = normalizeJsonObject(value);

			// Trim all string values
			if (typeof normalizedValue === 'string') {
				normalizedValue = normalizedValue.trim();
			}

			normalized[trimmedKey] = normalizedValue;
		}

		return normalized;
	}

	// Handle primitive strings
	if (typeof obj === 'string') {
		return obj.trim();
	}

	// Return other primitives as-is
	return obj;
}

function preprocessDoubaoBboxJson(input: string) {
	if (input.includes('bbox')) {
		// when its values like 940 445 969 490, replace all /\d+\s+\d+/g with /$1,$2/g
		while (/\d+\s+\d+/.test(input)) {
			input = input.replace(/(\d+)\s+(\d+)/g, '$1,$2');
		}
	}
	return input;
}

/**
 * Check if the modelFamily is a UI-TARS variant
 * @param modelFamily The model family to check
 * @returns true if modelFamily is any UI-TARS variant
 */
function isUITars(modelFamily: any | undefined): boolean {
	return (
		modelFamily === 'vlm-ui-tars' ||
		modelFamily === 'vlm-ui-tars-doubao' ||
		modelFamily === 'vlm-ui-tars-doubao-1.5'
	);
}