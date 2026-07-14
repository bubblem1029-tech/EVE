/**
 * SKILL.md Frontmatter Parser
 *
 * Reference: gemini-cli skillLoader.ts (skills/skillLoader.ts L34-110)
 * Parses YAML frontmatter from SKILL.md files to extract name, description,
 * and allowed-tools. Uses the 'yaml' npm package for robust YAML parsing,
 * with a fallback simple parser for malformed YAML (e.g. descriptions with colons).
 */

import YAML from 'yaml'

/**
 * Regex for extracting frontmatter from markdown files.
 * Matches ---\n<yaml content>\n--- at the start of the file.
 */
export const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/

/**
 * Parsed frontmatter result.
 */
export interface ParsedFrontmatter {
	name: string
	description: string
	/** Allowed tools for this skill (from frontmatter 'allowed-tools' field). */
	allowedTools?: string[]
	/** Output artifact type for Pipeline routing (e.g. 'code_knowledge', 'case_list'). */
	outputType?: string
	/** The body content after the closing ---. */
	body: string
}

/**
 * Parse frontmatter from a SKILL.md file string.
 *
 * Returns the name, description, allowedTools from the YAML frontmatter,
 * and the body (content after the frontmatter).
 *
 * @param content The full SKILL.md file content
 * @returns Parsed frontmatter and body, or null if no valid frontmatter found
 */
export function parseSkillFrontmatter(
	content: string,
): ParsedFrontmatter | null {
	const match = content.match(FRONTMATTER_REGEX)
	if (!match) {
		return null
	}

	const frontmatter = parseFrontmatterYaml(match[1])
	if (!frontmatter) {
		return null
	}

	// Sanitize name for use as a filename/directory name
	const sanitizedName = frontmatter.name.replace(/[:\\/<>*?"|]/g, '-')

	// Body is the content after the closing ---
	const body = match[2]?.trim() ?? ''

	return {
		name: sanitizedName,
		description: frontmatter.description,
		allowedTools: frontmatter.allowedTools,
		outputType: frontmatter.outputType,
		body,
	}
}

/**
 * Parse YAML frontmatter content using the yaml library
 * with a fallback to simple key-value parsing.
 *
 * Reference: gemini-cli skillLoader.ts parseFrontmatter (L41-61)
 *
 * Uses YAML.parse() (yaml v2 API) instead of the deprecated YAML.load().
 */
export function parseFrontmatterYaml(
	yamlContent: string,
): { name: string; description: string; allowedTools?: string[]; outputType?: string } | null {
	// Try YAML parsing first (handles complex cases like multi-line descriptions, arrays)
	try {
		const parsed = YAML.parse(yamlContent)
		if (parsed && typeof parsed === 'object') {
			const record = parsed as Record<string, unknown>
			const name = typeof record.name === 'string' ? record.name : undefined
			const description = typeof record.description === 'string' ? record.description : undefined

			if (!name || !description) {
				return null
			}

			// Extract allowed-tools (array or string)
			let allowedTools: string[] | undefined
			const allowedToolsRaw = record['allowed-tools']
			if (Array.isArray(allowedToolsRaw)) {
				allowedTools = allowedToolsRaw.map(String)
			} else if (typeof allowedToolsRaw === 'string') {
				allowedTools = allowedToolsRaw.split(/\s+/).filter(Boolean)
			}

			// Extract output-type (string)
			const outputType = typeof record['output-type'] === 'string' ? record['output-type'] as string : undefined

			return { name, description, allowedTools, outputType }
		}
	} catch (yamlError) {
		// YAML parsing failed — fall back to simple parser
		console.warn('[SkillLoader] YAML frontmatter parsing failed, using simple parser:', yamlError)
	}

	return parseSimpleFrontmatter(yamlContent)
}

/**
 * Simple frontmatter parser that extracts name, description, and allowed-tools fields.
 * Handles cases where values contain colons that would break YAML parsing.
 *
 * Reference: gemini-cli skillLoader.ts parseSimpleFrontmatter (L67-110)
 */
function parseSimpleFrontmatter(
	content: string,
): { name: string; description: string; allowedTools?: string[]; outputType?: string } | null {
	const lines = content.split(/\r?\n/)
	let name: string | undefined
	let description: string | undefined
	let allowedTools: string[] | undefined
	let outputType: string | undefined

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		// Match "name:" at the start of the line
		const nameMatch = line.match(/^\s*name:\s*(.*)$/)
		if (nameMatch) {
			name = nameMatch[1].trim()
			continue
		}

		// Match "description:" at the start of the line
		const descMatch = line.match(/^\s*description:\s*(.*)$/)
		if (descMatch) {
			const descLines = [descMatch[1].trim()]

			// Check for multi-line description (indented continuation lines)
			while (i + 1 < lines.length) {
				const nextLine = lines[i + 1]
				// If next line is indented, it's a continuation of the description
				if (nextLine.match(/^[ \t]+\S/)) {
					descLines.push(nextLine.trim())
					i++
				} else {
					break
				}
			}

			description = descLines.filter(Boolean).join(' ')
			continue
		}

		// Match "output-type:" at the start of the line
		const outputMatch = line.match(/^\s*output-type:\s*(.*)$/)
		if (outputMatch) {
			outputType = outputMatch[1].trim()
			continue
		}

		// Match "allowed-tools:" at the start of the line
		const toolsMatch = line.match(/^\s*allowed-tools:\s*(.*)$/)
		if (toolsMatch) {
			const toolsRaw = toolsMatch[1].trim()
			// Simple format: space-separated list (e.g. "Bash(shell:*) Bash(git:*) ask_user_questions")
			if (toolsRaw) {
				allowedTools = toolsRaw.split(/\s+/).filter(Boolean)
			}
			continue
		}
	}

	if (name !== undefined && description !== undefined) {
		return { name, description, allowedTools, outputType }
	}
	return null
}