/**
 * Bash Tool — shell command execution with scope-based permission control
 *
 * Scope patterns (aligned with keve-agent SKILL.md allowed-tools):
 *   Bash(git:*)   → only git commands allowed
 *   Bash(npx:*)   → only npx commands allowed
 *   Bash(npm:*)   → only npm commands allowed
 *   Bash(node:*)  → only node commands allowed
 *   Bash(shell:*)  → any command allowed
 *
 * When LLM calls bash tool, the 'scope' parameter is validated against
 * the skill's allowed-tools list by the ToolCaller.
 */

import { z } from 'zod/v4'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import type { ToolDefinition, ToolExecutionContext } from '../agent-loop/types'

// ===== Schema =====

export const BashInputSchema = z.object({
	/** The shell command to execute */
	command: z.string().describe('Shell command to execute'),
	/** Scope constraint (e.g., 'git', 'npx', 'npm', 'node', 'shell') */
	scope: z.string().default('shell').describe('Command scope: git/npx/npm/node/shell'),
	/** Working directory */
	cwd: z.string().optional().describe('Working directory for command execution'),
	/** Timeout in milliseconds */
	timeout: z.number().default(30_000).describe('Execution timeout in ms'),
})

export type BashInput = z.infer<typeof BashInputSchema>

// ===== Scope Validation =====

/**
 * Validate that a command matches the allowed scope.
 * Extracts the first word (the binary name) and checks against scope.
 *
 * @param command - The shell command to validate
 * @param allowedScopes - Array of allowed scopes (e.g., ['git', 'npx', 'shell'])
 * @returns true if command is within allowed scopes
 */
export function isCommandInScope(command: string, allowedScopes: string[]): boolean {
	// 'shell' scope allows everything
	if (allowedScopes.includes('shell')) return true

	// Extract the first word (binary name)
	const firstWord = command.trim().split(/\s+/)[0]
	// Handle path-like commands: extract basename
	const binaryName = firstWord.split('/').pop() ?? firstWord

	// Check if the binary matches any allowed scope
	return allowedScopes.some(scope => binaryName === scope)
}

/**
 * Parse Bash(scope:*) patterns from allowed-tools list.
 * Input: ['Bash(git:*)', 'Bash(npx:*)', 'codegraph_impact']
 * Output: ['git', 'npx']
 */
export function parseBashScopes(allowedTools: string[]): string[] {
	const scopes: string[] = []
	for (const tool of allowedTools) {
		const match = tool.match(/^Bash\((\w+):\*\)$/)
		if (match) {
			scopes.push(match[1])
		}
	}
	return scopes
}

// ===== Read-Only Path Protection =====

/**
 * Write patterns that indicate a command is trying to modify files.
 * These are checked against readOnlyPaths to prevent writes to protected directories.
 */
const WRITE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	// sed -i (in-place edit)
	{ pattern: /\bsed\s+(-[^-]*i|--in-place)\b/, description: 'sed -i (in-place edit)' },
	// Redirect overwrite: > file (but not >>, > /dev/null, > &)
	{ pattern: /[^>]>[^>]/, description: '> redirect (file overwrite)' },
	// Redirect append: >> file (allowed in general, but block if target is readOnly)
	// Actually >> is also a write, let's block it too for readOnly paths
	{ pattern: />>/, description: '>> redirect (file append)' },
	// tee command
	{ pattern: /\btee\b/, description: 'tee (write to file)' },
	// mv / cp with write target
	{ pattern: /\b(mv|cp)\s+/, description: 'mv/cp (move/copy file)' },
	// rm
	{ pattern: /\brm\s+/, description: 'rm (delete file)' },
	// chmod / chown
	{ pattern: /\b(chmod|chown)\s+/, description: 'chmod/chown (change permissions)' },
	// patch
	{ pattern: /\bpatch\s+/, description: 'patch (apply diff)' },
	// npm install / pnpm install / yarn (adds node_modules)
	{ pattern: /\b(npm|pnpm|yarn)\s+(install|i|add)\b/, description: 'npm/pnpm/yarn install (add dependencies)' },
	// npx playwright install
	{ pattern: /\bnpx\s+playwright\s+install\b/, description: 'npx playwright install (installs browsers)' },
	// pip install
	{ pattern: /\bpip\d*\s+install\b/, description: 'pip install (add Python packages)' },
	// echo > redirect
	{ pattern: /\becho\s+.*>\s*/, description: 'echo > redirect (write to file)' },
	// cat > redirect
	{ pattern: /\bcat\b.*[^>]>[^>]/, description: 'cat > redirect (write to file)' },
	// dd
	{ pattern: /\bdd\s+/, description: 'dd (disk write)' },
	// install command (copy files)
	{ pattern: /\binstall\s+/, description: 'install (copy files)' },
]

/**
 * Check if a command attempts to write to a read-only path.
 * Uses static analysis of the command string.
 *
 * @param command - The shell command to check
 * @param readOnlyPaths - Array of directory paths that are read-only
 * @returns Error message if write is detected, or null if command is safe
 */
export function checkReadOnlyPathWrite(
	command: string,
	readOnlyPaths: string[],
): string | null {
	if (!readOnlyPaths.length) return null

	// Step 1: Check if command contains any write pattern
	const matchedPattern = WRITE_PATTERNS.find(p => p.pattern.test(command))
	if (!matchedPattern) return null

	// Step 2: Check if the write target falls under a readOnlyPath
	// Normalize readOnly paths (resolve home, remove trailing slash)
	const normalizedROPaths = readOnlyPaths.map(p => {
		const expanded = p.replace(/^~/, process.env.HOME || '/tmp')
		return expanded.replace(/\/+$/, '')
	})

	// Extract potential target paths from the command
	// Simple heuristic: any absolute path or relative path in the command
	// that starts with or contains a readOnlyPath prefix
	const commandHasReadOnlyTarget = normalizedROPaths.some(roPath => {
		// Direct path reference in command
		if (command.includes(roPath + '/') || command.includes(roPath + ' ') || command.endsWith(roPath)) {
			return true
		}
		// If cwd might be a readOnlyPath and command uses relative paths
		// (covered by the general pattern match above — if write pattern
		//  matches AND readOnlyPath is in the command, we block it)
		return false
	})

	if (commandHasReadOnlyTarget) {
		return `[BLOCKED] Write operation blocked: "${matchedPattern.description}" targets read-only path. ` +
			`Protected paths: ${normalizedROPaths.join(', ')}. ` +
			`Write your output to workspaceDir instead.`
	}

	// Even if no explicit path target, some commands are inherently dangerous
	// when executed inside a readOnly directory (e.g., `cd /readOnly && sed -i file`)
	// Check if cwd might be a readOnlyPath
	const cwdInCommand = command.match(/cd\s+(['"]?)(.+?)\1\s+&&/)
	if (cwdInCommand) {
		const cwdPath = cwdInCommand[2].replace(/^~/, process.env.HOME || '/tmp')
		if (normalizedROPaths.some(ro => cwdPath.startsWith(ro))) {
			return `[BLOCKED] Write operation blocked: "${matchedPattern.description}" executed in read-only directory "${cwdPath}". ` +
				`Protected paths: ${normalizedROPaths.join(', ')}. ` +
				`Write your output to workspaceDir instead.`
		}
	}

	return null
}

// ===== Tool Definition =====

export const bashTool: ToolDefinition = {
	name: 'bash',
	description: `Execute a shell command with scope-based permission control.

Scope patterns:
- Bash(git:*): only git commands
- Bash(npx:*): only npx commands  
- Bash(npm:*): only npm commands
- Bash(node:*): only node commands
- Bash(shell:*): any command

The scope parameter is validated against the skill's allowed-tools list.

Read-only path protection:
- If readOnlyPaths is set in context, commands that write to those paths will be blocked.
- This prevents accidental modification of source code repositories.`,
	inputSchema: BashInputSchema,
	customJsonSchema: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'Shell command to execute' },
			scope: { type: 'string', description: 'Command scope: git/npx/npm/node/shell', default: 'shell' },
			cwd: { type: 'string', description: 'Working directory' },
			timeout: { type: 'number', description: 'Timeout in ms', default: 30000 },
		},
		required: ['command'],
	},
	async execute(args: BashInput, context?: ToolExecutionContext): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
		const { command, scope = 'shell', cwd, timeout = 30_000 } = args

		// 🆕 Read-only path protection
		if (context?.readOnlyPaths?.length) {
			const blockReason = checkReadOnlyPathWrite(command, context.readOnlyPaths)
			if (blockReason) {
				return { ok: false, stdout: '', stderr: blockReason, exitCode: 126 }
			}
		}

		try {
			const stdout = execSync(command, {
				cwd,
				timeout,
				encoding: 'utf-8',
				maxBuffer: 1024 * 1024, // 1MB
				stdio: ['pipe', 'pipe', 'pipe'],
			})

			return { ok: true, stdout: stdout.trim(), stderr: '', exitCode: 0 }
		} catch (err: any) {
			const stdout = (err.stdout as string)?.trim() ?? ''
			const stderr = (err.stderr as string)?.trim() ?? ''
			const exitCode = err.status ?? 1

			return { ok: false, stdout, stderr, exitCode }
		}
	},
}
