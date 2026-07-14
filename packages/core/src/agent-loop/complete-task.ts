/**
 * Complete Task Tool — signals that the agent has finished its task.
 *
 * Reference: gemini-cli CompleteTaskTool (tools/complete-task.ts)
 *
 * This tool is automatically registered in every agent loop execution.
 * When the LLM calls this tool, the agent loop terminates with GOAL mode.
 *
 * The `result` parameter can be either:
 * - A structured JSON object (when the agent has a defined output schema)
 * - A plain string summary (for conversational tasks)
 */

import { z } from 'zod/v4'
import type { ToolDefinition } from './types'
import { COMPLETE_TASK_TOOL_NAME } from './types'

export interface CompleteTaskToolOptions {
	outputHint?: string
}

export const CompleteTaskSchema = z.object({
	result: z.any().describe(
		'Your final result. You can provide either a structured JSON object or a text summary. ' +
		'This is the ONLY way to finish the task — call this tool when you are done.'
	),
	_result: z.enum(['PASSED', 'FAILED', 'BLOCKED']).optional().describe(
		'Execution result. "PASSED" = task completed successfully. ' +
		'"FAILED" = task failed (e.g. tests did not pass). ' +
		'"BLOCKED" = unresolved items prevent downstream steps from proceeding safely. ' +
		'Use "BLOCKED" when critical information is missing and proceeding would produce unreliable results.'
	),
	_summary: z.string().optional().describe(
		'Brief human-readable summary of the result (1-2 sentences). Used by the orchestrator to display progress. ' +
		'If omitted, the orchestrator will derive a summary from the result object.'
	),
	_blockedReason: z.string().optional().describe(
		'Reason for blocking. Required when _result is "BLOCKED". ' +
		'Describe what information is missing and what needs to be confirmed before proceeding.'
	),
})

export function createCompleteTaskTool(options?: CompleteTaskToolOptions): ToolDefinition {
	const hint = options?.outputHint

	const baseDescription =
		'Call this tool to submit your final result and complete the task. ' +
		'This is the ONLY way to finish. You MUST call this tool when you ' +
		'have completed your work.'

	const description = hint
		? baseDescription + '\n\n' + hint
		: baseDescription

	const structuredDesc = hint
		? 'Structured JSON result. ' + hint
		: 'Structured JSON result with key fields matching the expected output schema.'

	return {
		name: COMPLETE_TASK_TOOL_NAME,
		description,
		inputSchema: CompleteTaskSchema,
		execute: async (args) => {
			const result = typeof args.result === 'string' ? args.result : args.result
			return { result, taskCompleted: true }
		},
		customJsonSchema: {
			type: 'object',
			properties: {
				result: {
					oneOf: [
						{
							type: 'object',
							description: structuredDesc,
						},
						{
							type: 'string',
							description: 'Plain text summary of what you accomplished.',
						},
					],
					description:
						'Your final result. Provide structured JSON when a schema is defined, or a text summary otherwise.',
				},
			},
			required: ['result'],
		},
	}
}
