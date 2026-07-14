/**
 * read_files Tool — multi-file reader (reference: gemini-cli ReadManyFilesTool)
 *
 * Reads multiple files at once, with content truncation.
 * Used by skills to read code, configs, wiki content, etc.
 */

import { z } from 'zod/v4'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ToolDefinition } from '../agent-loop/types'

const ReadFilesSchema = z.object({
	/** File paths to read (absolute or relative to cwd) */
	paths: z.array(z.string()).describe('Array of file paths to read'),
	/** Base directory for resolving relative paths */
	cwd: z.string().optional().describe('Base directory for relative paths'),
	/** Max bytes per file (prevents OOM on large files) */
	maxBytes: z.number().default(50_000).describe('Max bytes per file (truncated if larger)'),
})

export const readFilesTool: ToolDefinition = {
	name: 'read_files',
	description: `Read multiple files at once. Returns file contents with path headers.
Files larger than maxBytes are truncated. Non-existent files produce an error message.`,
	inputSchema: ReadFilesSchema,
	async execute(args: z.infer<typeof ReadFilesSchema>): Promise<string> {
		const { paths, cwd, maxBytes = 50_000 } = args
		const baseDir = cwd ?? process.cwd()

		const results: string[] = []

		for (const filePath of paths) {
			const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath)
			const header = `\n=== ${filePath} ===`

			try {
				const content = await fs.readFile(absPath, 'utf-8')
				if (content.length > maxBytes) {
					results.push(`${header}\n${content.slice(0, maxBytes)}\n... [truncated at ${maxBytes} chars]`)
				} else {
					results.push(`${header}\n${content}`)
				}
			} catch (err: any) {
				results.push(`${header}\n[Error: ${err.message}]`)
			}
		}

		return results.join('\n')
	},
}
