/**
 * ask_user Tool — ask the user a question and wait for confirmation
 *
 * Publishes an input_required event via eventBus,
 * handled by the upper layer (Server) for user interaction.
 */

import { z } from 'zod/v4'
import type { ToolDefinition } from '../agent-loop/types'

const AskUserSchema = z.object({
	/** Question to ask the user */
	question: z.string().describe('Question to ask the user'),
	/** Optional choices for the user */
	options: z.array(z.object({
		label: z.string().describe('Option label'),
		description: z.string().optional().describe('Option description'),
	})).optional().describe('Array of options for the user to choose from'),
	/** Type of confirmation needed */
	type: z.enum(['confirm', 'choice', 'text']).default('choice').describe('Type: confirm (yes/no), choice (select), text (free input)'),
})

export const askUserTool: ToolDefinition = {
	name: 'ask_user',
	description: `Ask the user a question and wait for their response.
Use this when:
- PRD and code implementation are inconsistent and need confirmation
- Multiple approaches are possible and user preference is needed
- Information is missing and cannot be determined from available context

The skill execution pauses until the user responds.`,
	inputSchema: AskUserSchema,
	async execute(args: z.infer<typeof AskUserSchema>): Promise<{
		answer: string
		confirmed: boolean
	}> {
		// In AgentLoop mode, this would be handled by the event system
		// For Phase 1 (hybrid mode), we use a callback approach
		const callback = (globalThis as any).__askUserCallback as
			((q: string, opts?: Array<{label: string; description?: string}>) => Promise<string>) | undefined

		if (callback) {
			const answer = await callback(args.question, args.options)
			return { answer, confirmed: true }
		}

		// Fallback: no user interaction available — tell LLM to decide on its own
		console.warn(`[ask_user] No callback registered. Question: ${args.question}`)
		return {
			answer: `Unable to reach user. Please decide based on available information and continue. Do not call ask_user again.`,
			confirmed: true,
		}
	},
}
