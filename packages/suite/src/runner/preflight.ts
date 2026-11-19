/**
 * preflight — 引擎启动前的环境自检
 *
 * Cypress 初始化失败会表现为「每条用例都失败」，但真实原因是环境或二进制问题。
 * 这里在派发用例前 fail-fast，避免把一次基础设施故障扩散成整批业务失败。
 */

import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ReasonCode } from '../core/verdict.js';

export type PreflightEngine = 'cypress' | 'playwright';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  engine: PreflightEngine;
  checks: PreflightCheck[];
  reasonCode?: ReasonCode;
  message?: string;
}

export interface EnginePreflightOptions {
  engine: PreflightEngine;
  bin: string;
  taskDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function check(name: string, ok: boolean, detail?: string): PreflightCheck {
  return { name, ok, ...(detail ? { detail } : {}) };
}

function exists(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

/**
 * 执行引擎自检。
 *
 * P0 对 Cypress 调用 `cypress verify`；Playwright 只做可执行文件与配置存在性检查，
 * 浏览器安装检查沿用 run 命令原本的自动安装逻辑。
 */
export function runEnginePreflight(options: EnginePreflightOptions): PreflightResult {
  const { engine, bin, taskDir, configPath, env, timeoutMs = 120_000 } = options;
  const checks: PreflightCheck[] = [
    check('engine-binary', Boolean(bin) && exists(bin), bin || 'empty'),
    check('task-dir', exists(taskDir), taskDir),
    check('engine-config', exists(configPath), configPath),
  ];

  const baseFailed = checks.find((item) => !item.ok);
  if (baseFailed) {
    return {
      ok: false,
      engine,
      checks,
      reasonCode: 'infra_engine_init_failed',
      message: `preflight ${baseFailed.name} failed: ${baseFailed.detail || ''}`,
    };
  }

  if (engine === 'cypress') {
    const verified = spawnSync(bin, ['verify'], {
      cwd: taskDir,
      env: env || process.env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const output = `${verified.stdout || ''}\n${verified.stderr || ''}`.trim();
    const ok = !verified.error && verified.status === 0;
    checks.push(check('cypress-verify', ok, output.slice(-1200)));
    if (!ok) {
      return {
        ok: false,
        engine,
        checks,
        reasonCode: /browser|binary|executable/i.test(output)
          ? 'infra_engine_browser_crashed'
          : 'infra_engine_init_failed',
        message: verified.error?.message || `cypress verify exitCode=${verified.status}`,
      };
    }
  }

  return { ok: true, engine, checks };
}
