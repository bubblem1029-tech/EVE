/**
 * Skill module — SKILL.md discovery, loading, and execution
 *
 * Provides the SkillLoader for discovering SKILL.md files with
 * Progressive Disclosure (frontmatter scan → full content → references),
 * and the SkillExecutor for running skills through the AgentLoop.
 *
 * Reference: gemini-cli skillLoader.ts + skill-extraction-agent.ts
 */

export { SkillLoader } from './loader'
export type { SkillDefinition } from './loader'
export { parseSkillFrontmatter, FRONTMATTER_REGEX } from './frontmatter-parser'