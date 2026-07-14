/**
 * keve config loader - reads keve_test_spec/keve.yaml
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { execSync } from 'child_process'

export interface KeveConfig {
  project: {
    name: string;
    prd_url?: string;
  };
  state: {
    current_round: number;
    last_run_at?: string;
  };
  llm: {
    model: string;
    base_url: string;
    api_key?: string;
  };
  execution: {
    timeout_ms: number;
    retries: number;
    reporter: string;
    screenshot: string;
  };
  platform?: {
    base_url?: string;
    plan_id?: string | null;
    teamId?: string;
  };
}

/** Per-task run state — stored in .keve/{task}/run-state.yaml */
export interface RunState {
  current_round: number;
  last_run_at?: string;
  rounds: Record<number, {
    status: 'running' | 'completed' | 'failed';
    started_at: string;
    completed_at?: string;
    passed?: number;
    failed?: number;
    skipped?: number;
  }>;
}

const DEFAULT_CONFIG: KeveConfig = {
  project: {
    name: '',
  },
  state: {
    current_round: 0,
  },
  llm: {
    model: process.env.KEVE_LLM_MODEL || '',
    base_url: process.env.KEVE_LLM_BASE_URL || process.env.KONSTRUCTOR_API_BASE || '',
    api_key: process.env.KEVE_LLM_API_KEY || process.env.LLM_API_KEY || '',
  },
  execution: {
    timeout_ms: 1200000,
    retries: 0,
    reporter: 'json',
    screenshot: 'only-on-failure',
  },
};

/**
 * Find keve_test_spec/ directory by walking up from cwd
 */
export function findKeveDir(startDir?: string): string | null {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 20; i++) {
    // Prefer .keve/ directory as the canonical keve home
    const dotKeve = path.join(dir, '.keve');
    if (fs.existsSync(dotKeve)) return dotKeve;
    // Fallback: keve_test_spec/ for legacy projects
    const specDir = path.join(dir, 'keve_test_spec');
    if (fs.existsSync(specDir)) return specDir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load keve.yaml config
 */
export function loadConfig(keveDir?: string | null): KeveConfig {
  const dir = keveDir || findKeveDir();
  if (!dir) return DEFAULT_CONFIG;

  const configPath = path.join(dir, 'keve.yaml');
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;

  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.parse(content);
  return { ...DEFAULT_CONFIG, ...parsed };
}

/**
 * Save keve.yaml config
 */
export function saveConfig(config: KeveConfig, keveDir: string): void {
  const configPath = path.join(keveDir, 'keve.yaml');
  const content = yaml.stringify(config, { lineWidth: 0 });
  fs.writeFileSync(configPath, content, 'utf-8');
}

/**
 * Get current round number, auto-increment
 */
export function getNextRound(keveDir: string): number {
  const config = loadConfig(keveDir);
  const next = config.state.current_round + 1;
  config.state.current_round = next;
  config.state.last_run_at = new Date().toISOString();
  saveConfig(config, keveDir);
  return next;
}

/**
 * Resolve latest round directory
 */
export function getLatestRoundDir(keveDir: string): string | null {
  const artifactsDir = path.join(keveDir, 'test-artifacts');
  const latestLink = path.join(artifactsDir, 'latest');
  try {
    const target = fs.readlinkSync(latestLink);
    return path.resolve(artifactsDir, target);
  } catch {
    return null;
  }
}

/**
 * Get branch-specific directory under .keve/
 * Uses current git branch name to create/find .keve/{branch}/
 */
export function getBranchDir(keveDir: string | null): string | null {
  if (!keveDir) return null;
  // Don't create branch dirs under keve_test_spec/ (legacy keveDir) — only under .keve/
  if (!keveDir.endsWith(path.join('.keve')) && !keveDir.includes(`${path.sep}.keve${path.sep}`)) return null;
  const branch = getCurrentBranch();
  if (!branch) return null;
  const branchDir = path.join(keveDir, branch);
  if (!fs.existsSync(branchDir)) {
    fs.mkdirSync(branchDir, { recursive: true });
  }
  return branchDir;
}

/**
 * Get current git branch name
 */
export function getCurrentBranch(): string | null {
  try {
    return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * 获取 git 用户名
 */
export function getGitUserName(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return process.env.KEVE_USER_NAME || '';
  }
}

/**
 * 获取 git remote origin 仓库名
 */
export function getGitRepoName(): string {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    const parts = url.replace(/\.git$/, '').split('/');
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

/**
 * 获取当前 git 分支名
 */
export function getGitBranchName(): string {
  try {
    return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

// ─── Run State (run-state.yaml) ─────────────────────────────────────────

const RUN_STATE_FILENAME = 'run-state.yaml';

/**
 * Resolve task directory from KEVE_TASK_DIR env or keveDir + branch.
 * Returns absolute path to the task root (e.g. .keve/mr-868-temp).
 */
export function resolveTaskDir(keveDir: string | null): string | null {
  if (process.env.KEVE_TASK_DIR) {
    return path.resolve(process.cwd(), process.env.KEVE_TASK_DIR);
  }
  // Auto-detect: find branch-specific task dir under .keve/{branch}/
  if (keveDir) {
    const branch = getCurrentBranch();
    if (branch) {
      const branchDir = path.join(keveDir, branch);
      if (fs.existsSync(branchDir)) return branchDir;
    }
    // Fallback: keveDir itself if it has run-state.yaml
    if (fs.existsSync(path.join(keveDir, RUN_STATE_FILENAME))) return keveDir;
  }
  return null;
}

/**
 * Read run-state.yaml from task directory.
 * Returns default state if file doesn't exist.
 */
export function readRunState(taskDir: string): RunState {
  const filePath = path.join(taskDir, RUN_STATE_FILENAME);
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.parse(content);
      return {
        current_round: parsed.current_round || 0,
        last_run_at: parsed.last_run_at,
        rounds: parsed.rounds || {},
      };
    } catch {
      // Corrupted file — start fresh
    }
  }
  return { current_round: 0, rounds: {} };
}

/**
 * Write run-state.yaml to task directory.
 */
export function writeRunState(taskDir: string, state: RunState): void {
  const filePath = path.join(taskDir, RUN_STATE_FILENAME);
  fs.writeFileSync(filePath, yaml.stringify(state), 'utf-8');
}

/**
 * Get next round number and update run-state.yaml.
 */
export function getNextRoundFromState(taskDir: string): number {
  const state = readRunState(taskDir);
  const next = state.current_round + 1;
  state.current_round = next;
  state.last_run_at = new Date().toISOString();
  state.rounds[next] = {
    status: 'running',
    started_at: new Date().toISOString(),
  };
  writeRunState(taskDir, state);
  return next;
}

/**
 * Mark a round as completed with stats.
 */
export function completeRound(taskDir: string, round: number, stats: { passed: number; failed: number; skipped: number }): void {
  const state = readRunState(taskDir);
  if (state.rounds[round]) {
    state.rounds[round].status = 'completed';
    state.rounds[round].completed_at = new Date().toISOString();
    state.rounds[round].passed = stats.passed;
    state.rounds[round].failed = stats.failed;
    state.rounds[round].skipped = stats.skipped;
    writeRunState(taskDir, state);
  }
}