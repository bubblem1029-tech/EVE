/**
 * RuntimeEnvironment — runtime environment detection
 *
 * Detects available system binaries (git/codegraph/playwright/node),
 * and provides config paths (env).
 *
 * Tools (core/tools/*) get paths via ToolExecutionContext.runtime,
 * instead of resolving binaries themselves.
 *
 * Design decisions:
 * D02: Layer 1: RuntimeEnvironment provides binary paths
 *      Layer 2: Tool execute() gets paths from runtime
 *      Layer 3: Skill only ctx.tools.call(), no path awareness
 * D04: Business-specific paths (keveWikiDir/reposBaseDir) removed from core.
 *      Agent package can add them in its own runtime extension.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { execSync } from 'node:child_process'

// ===== RuntimeEnvironment Interface =====

export interface RuntimeEnvironment {
	/** Git binary path */
	gitBin: string
	/** Codegraph binary path */
	codegraphBin: string
	/** Playwright binary path (usually in agent's node_modules/.bin) */
	playwrightBin: string
	/** Node binary path */
	nodeBin: string
	/** Package manager (pnpm/npm/yarn) */
	packageManager: string
	/** Environment variables (tokens, configs) */
	env: Record<string, string>
}

// ===== Detection =====

/**
 * Find a binary on the system PATH.
 * Returns the absolute path or the binary name if not found (will fail at exec time).
 */
function findBinary(name: string): string {
	try {
		return execSync(`which ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim()
	} catch {
		return name
	}
}

/**
 * Detect package manager from lockfile
 */
function detectPackageManager(projectDir: string): string {
	if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm'
	if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn'
	if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) return 'npm'
	return 'pnpm'
}

/**
 * Load environment variables from .env file (if present)
 */
function loadEnvFile(envPath: string): Record<string, string> {
	const env: Record<string, string> = {}
	if (!fs.existsSync(envPath)) return env

	try {
		const content = fs.readFileSync(envPath, 'utf-8')
		for (const line of content.split('\n')) {
			const trimmed = line.trim()
			if (!trimmed || trimmed.startsWith('#')) continue
			const eqIndex = trimmed.indexOf('=')
			if (eqIndex > 0) {
				const key = trimmed.slice(0, eqIndex).trim()
				let value = trimmed.slice(eqIndex + 1).trim()
				if ((value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))) {
					value = value.slice(1, -1)
				}
				env[key] = value
			}
		}
	} catch {
		// Ignore .env read errors
	}
	return env
}

/**
 * Detect the runtime environment.
 *
 * Scans for binaries, loads env vars.
 * Called once at startup (entry.ts) and passed to Pipeline → SkillContext.
 *
 * @param cwd - Starting directory (defaults to process.cwd())
 * @param agentDir - Agent package directory for finding node_modules binaries
 */
export function detectRuntimeEnvironment(
	cwd?: string,
	agentDir?: string,
): RuntimeEnvironment {
	const startDir = cwd ?? process.cwd()
	const pkgDir = agentDir ?? findPkgDir(startDir)

	// Find playwright binary: prefer agent's node_modules, fallback to global
	const localPlaywright = path.join(pkgDir, 'node_modules', '.bin', 'playwright')
	const playwrightBin = fs.existsSync(localPlaywright)
		? localPlaywright
		: findBinary('playwright')

	// Load .env from agent/pkg dir
	const env: Record<string, string> = {
		...loadEnvFile(path.join(pkgDir, '.env')),
	}

	// Also inherit relevant process.env
	for (const key of ['GITLAB_TOKEN', 'HOME', 'PATH', 'NODE_ENV']) {
		if (process.env[key]) env[key] = process.env[key]!
	}

	return {
		gitBin: findBinary('git'),
		codegraphBin: findBinary('codegraph'),
		playwrightBin,
		nodeBin: process.execPath,
		packageManager: detectPackageManager(pkgDir),
		env,
	}
}

/**
 * Walk up from startDir to find the nearest package directory
 * (contains package.json with node_modules)
 */
function findPkgDir(startDir: string): string {
	let dir = startDir
	for (let i = 0; i < 15; i++) {
		const pkgPath = path.join(dir, 'package.json')
		if (fs.existsSync(pkgPath) && fs.existsSync(path.join(dir, 'node_modules'))) {
			return dir
		}
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return startDir
}
