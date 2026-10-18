/**
 * 浏览器磁盘缓存目录与总开关契约。
 *
 * 只有 KEVE_BROWSER_CACHE_ENABLED 控制缓存是否开启（默认 true）；
 * KEVE_BROWSER_CACHE_DIR 只是可选目录覆盖，未设置时使用统一的默认目录。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** 默认缓存目录：一个固定根目录，所有站点与引擎共用。 */
export const DEFAULT_BROWSER_CACHE_DIR = path.join(os.homedir(), '.keve', 'browser-cache');

export function browserCacheEnabled(): boolean {
  const raw = (process.env.KEVE_BROWSER_CACHE_ENABLED || '').trim().toLowerCase();
  return raw === '' || !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
}

/**
 * 解析缓存目录。优先 KEVE_BROWSER_CACHE_DIR，否则使用固定的默认目录。
 * 这是根目录；实际缓存目录由 activeBrowserCacheDir 再追加身份与任务隔离层。
 */
export function resolveBrowserCacheDir(): string {
  const override = (process.env.KEVE_BROWSER_CACHE_DIR || '').trim();
  return override || DEFAULT_BROWSER_CACHE_DIR;
}

/** 总的开关关闭时统一返回空目录；开启时返回目录解析结果。 */
export function activeBrowserCacheDir(): string {
  if (!browserCacheEnabled()) return '';
  const base = (process.env.KEVE_BROWSER_CACHE_DIR || '').trim() || DEFAULT_BROWSER_CACHE_DIR;
  return path.join(base, isolationKey());
}

/**
 * 缓存隔离 key：身份 + 任务双层。
 * 身份取 KEVE_IDENTITY_SSO_COOKIES 的 key 集合（账号名，稳定），而不是 cookie 值
 * （SSO cookie 每轮可能重新换取，直接哈希会导致缓存目录每轮漂移、永远冷启动）。
 */
function isolationKey(): string {
  const identityJson = process.env.KEVE_IDENTITY_SSO_COOKIES || '';
  let identityPart = 'default';
  try {
    const identity = JSON.parse(identityJson) as Record<string, unknown>;
    const keys = Object.keys(identity || {}).sort();
    if (keys.length) {
      identityPart = `id-${crypto.createHash('sha256').update(keys.join('|')).digest('hex').slice(0, 16)}`;
    }
  } catch {
    // 解析失败时退化为默认身份，不影响任务执行
  }
  const task = process.env.KEVE_TASK_DIR || 'default';
  const taskPart = `task-${crypto.createHash('sha256').update(task).digest('hex').slice(0, 16)}`;
  return path.join(identityPart, taskPart);
}
