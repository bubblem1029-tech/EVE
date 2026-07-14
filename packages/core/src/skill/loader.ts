/**
 * Skill Loader — discovers and loads SKILL.md files
 *
 * Reference: gemini-cli skillLoader.ts (skills/skillLoader.ts)
 *
 * Progressive Disclosure three levels:
 * 1. scanSkillDirs() → scan all SKILL.md frontmatter (name + description only)
 * 2. loadSkillContent() → load the full SKILL.md body for a matched skill
 * 3. loadSkillReference() → load a specific reference file from the skill's references/ dir
 *
 * Skill directory scan priority:
 * - packages/agent/skills/x/SKILL.md — project built-in skills (canonical location)
 * - Future: user-defined skill directories (from config)
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { glob } from 'glob'
import { parseSkillFrontmatter } from './frontmatter-parser'

/**
 * A loaded skill definition.
 * Reference: gemini-cli SkillDefinition (skills/skillLoader.ts L17-32)
 */
export interface SkillDefinition {
	/** The unique name of the skill (sanitized from frontmatter). */
	name: string
	/** A concise description of what the skill does. */
	description: string
	/** The absolute path to the skill's SKILL.md file on disk. */
	location: string
	/** The core logic/instructions of the skill (SKILL.md body). */
	body: string
	/** Whether the skill is currently disabled. */
	disabled?: boolean
	/** Whether the skill is a built-in skill. */
	isBuiltin?: boolean
	/** Allowed tools for this skill (from frontmatter). */
	allowedTools?: string[]
	/** Output artifact type for Pipeline routing (e.g. 'code_knowledge', 'case_list'). */
	outputType?: string
}

/**
 * Skill loader for discovering and loading SKILL.md files.
 *
 * Usage:
 * ```typescript
 * const loader = new SkillLoader(['packages/agent/demo/skills'])
 * const skills = await loader.scanSkillDirs()
 * // Find matching skill
 * const matched = loader.matchSkill('test case generation', skills)
 * // Load full content
 * const content = await loader.loadSkillContent(matched.name)
 * ```
 */
export class SkillLoader {
	private skillDirs: string[]
	private skillCache: Map<string, SkillDefinition> = new Map()

	constructor(skillDirs: string[]) {
		this.skillDirs = skillDirs
	}

	/**
	 * Level 1: Scan skill directories and load all SKILL.md frontmatter.
	 * Returns SkillDefinition objects with name, description, location, and body.
	 *
	 * Reference: gemini-cli loadSkillsFromDir (skills/skillLoader.ts L115-159)
	 */
	async scanSkillDirs(): Promise<SkillDefinition[]> {
		const discoveredSkills: SkillDefinition[] = []

		for (const dir of this.skillDirs) {
			const skillsFromDir = await this.loadSkillsFromDir(dir)
			for (const skill of skillsFromDir) {
				this.skillCache.set(skill.name, skill)
				discoveredSkills.push(skill)
			}
		}

		return discoveredSkills
	}

	/**
	 * Level 2: Load the full SKILL.md body content for a specific skill.
	 * If the skill was already scanned, returns the cached body.
	 * Otherwise, loads it from disk.
	 */
	async loadSkillContent(skillName: string): Promise<string | null> {
		const cached = this.skillCache.get(skillName)
		if (cached) {
			return cached.body
		}

		// Try to find and load the skill file
		for (const dir of this.skillDirs) {
			const absoluteSearchPath = path.resolve(dir)
			try {
				const pattern = ['SKILL.md', '*/SKILL.md']
				const skillFiles = await glob(pattern, {
					cwd: absoluteSearchPath,
					absolute: true,
					nodir: true,
					ignore: ['**/node_modules/**', '**/.git/**'],
				})

				for (const skillFile of skillFiles) {
					const skill = await this.loadSkillFromFile(skillFile)
					if (skill && skill.name === skillName) {
						this.skillCache.set(skill.name, skill)
						return skill.body
					}
				}
			} catch (err) {
				console.warn(`[SkillLoader] Failed to search skill '${skillName}' in ${absoluteSearchPath}:`, err instanceof Error ? err.message : err)
			}
		}

		return null
	}

	/**
	 * Level 3: Load a reference file from a skill's directory.
	 * Reference files are typically in a references/ subdirectory next to SKILL.md.
	 */
	async loadSkillReference(skillName: string, referencePath: string): Promise<string | null> {
		const cached = this.skillCache.get(skillName)
		if (!cached) {
			return null
		}

		// The skill's location is the SKILL.md file path
		// References are in the same directory or a references/ subdirectory
		const skillDir = path.dirname(cached.location)
		const refAbsolutePath = path.resolve(skillDir, referencePath)

		try {
			return await fs.readFile(refAbsolutePath, 'utf-8')
		} catch {
			console.warn(`[SkillLoader] Reference file not found: ${refAbsolutePath}`)
			return null
		}
	}

	/**
	 * Match a skill by query string against available skills' names and descriptions.
	 * Uses simple keyword matching — finds the skill whose name or description
	 * best matches the query.
	 */
	matchSkill(query: string, availableSkills: SkillDefinition[]): SkillDefinition | null {
		if (availableSkills.length === 0) {
			return null
		}

		const lowerQuery = query.toLowerCase()
		const queryWords = lowerQuery.split(/\s+/)

		// Score each skill by how many query words appear in name/description
		let bestMatch: SkillDefinition | null = null
		let bestScore = 0

		for (const skill of availableSkills) {
			if (skill.disabled) continue

			const searchableText = `${skill.name} ${skill.description}`.toLowerCase()
			let score = 0
			for (const word of queryWords) {
				if (searchableText.includes(word)) {
					score++
				}
			}

			// Bonus for exact name match
			if (skill.name.toLowerCase() === lowerQuery) {
				score += 10
			}

			// Bonus for name being a substring of query
			if (lowerQuery.includes(skill.name.toLowerCase())) {
				score += 5
			}

			if (score > bestScore) {
				bestScore = score
				bestMatch = skill
			}
		}

		return bestMatch
	}

	/**
	 * Get a cached skill definition by name.
	 */
	getCachedSkill(skillName: string): SkillDefinition | undefined {
		return this.skillCache.get(skillName)
	}

	/**
	 * Get all cached skill definitions.
	 */
	getAllCachedSkills(): SkillDefinition[] {
		return Array.from(this.skillCache.values())
	}

	// ===== Private methods =====

	/**
	 * Load all skills from a directory.
	 * Reference: gemini-cli loadSkillsFromDir (skills/skillLoader.ts L115-159)
	 */
	private async loadSkillsFromDir(dir: string): Promise<SkillDefinition[]> {
		const discoveredSkills: SkillDefinition[] = []

		try {
			const absoluteSearchPath = path.resolve(dir)
			const stats = await fs.stat(absoluteSearchPath).catch(() => null)
			if (!stats || !stats.isDirectory()) {
				return []
			}

			const pattern = ['SKILL.md', '*/SKILL.md']
			const skillFiles = await glob(pattern, {
				cwd: absoluteSearchPath,
				absolute: true,
				nodir: true,
				ignore: ['**/node_modules/**', '**/.git/**'],
			})

			for (const skillFile of skillFiles) {
				const skill = await this.loadSkillFromFile(skillFile)
				if (skill) {
					discoveredSkills.push(skill)
				}
			}
		} catch (error) {
			console.warn(`[SkillLoader] Error discovering skills in ${dir}:`, error)
		}

		return discoveredSkills
	}

	/**
	 * Load a single skill from a SKILL.md file.
	 * Reference: gemini-cli loadSkillFromFile (skills/skillLoader.ts L164-192)
	 */
	private async loadSkillFromFile(filePath: string): Promise<SkillDefinition | null> {
		try {
			const content = await fs.readFile(filePath, 'utf-8')
			const parsed = parseSkillFrontmatter(content)
			if (!parsed) {
				return null
			}

			return {
				name: parsed.name,
				description: parsed.description,
				location: filePath,
				body: parsed.body,
				allowedTools: parsed.allowedTools,
				outputType: parsed.outputType,
			}
		} catch (error) {
			console.warn(`[SkillLoader] Error parsing skill file ${filePath}:`, error)
			return null
		}
	}
}