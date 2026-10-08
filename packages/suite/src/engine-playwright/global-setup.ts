/**
 * global-setup — 登录态装配（纯数据准备，不启动浏览器）
 *
 * 设计调整（与平台执行链路对齐）：
 *   - 不再由测试侧启动 chromium，也不再通过 CDP 接管已开浏览器。
 *   - 登录态由**服务端**解析（eve-backend account-resolver → SSO cookies），
 *     执行前以环境变量下发，这里只负责把 cookie 写成 Playwright storageState。
 *
 * 环境变量：
 *   KEVE_SSO_COOKIES      — JSON 字符串化的 SsoCookie[]（服务端解析结果，首选）
 *   KEVE_STORAGE_STATE    — storageState 输出路径（默认 ./.auth/storage-state.json）
 *   KEVE_TARGET_URL       — 目标站点 URL（用于派生 cookie domain，缺省 kuaishou.com）
 *
 * 兼容：KEVE_SSO_COOKIES_FILE 指向一个包含同样 JSON 的文件。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SsoCookie } from '../core/sso-cookie.js';

/** 由 storageState 路径解析（默认 .auth/storage-state.json） */
export function resolveStorageStatePath(): string {
  return path.resolve(
    process.cwd(),
    process.env.KEVE_STORAGE_STATE || path.join('.auth', 'storage-state.json'),
  );
}

/** 从 cookie 派生 Playwright cookie 所需的 domain / path */
function toPlaywrightCookie(cookie: SsoCookie, fallbackDomain: string) {
  const domain = (cookie as any).domain || fallbackDomain;
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: (cookie as any).path || '/',
    expires: typeof (cookie as any).expires === 'number' ? (cookie as any).expires : -1,
    httpOnly: !!(cookie as any).httpOnly,
    secure: (cookie as any).secure !== false,
    sameSite: ((cookie as any).sameSite || 'Lax') as 'Strict' | 'Lax' | 'None',
  };
}

/** 目标站点派生 cookie domain：https://foo.kuaishou.com/x → .kuaishou.com */
export function deriveCookieDomain(targetUrl?: string): string {
  const fallback = '.kuaishou.com';
  if (!targetUrl) return fallback;
  try {
    const host = new URL(targetUrl).hostname;
    const parts = host.split('.');
    if (parts.length < 2) return host;
    return `.${parts.slice(-2).join('.')}`;
  } catch {
    return fallback;
  }
}

/** 读取服务端下发的 cookies（环境变量优先，其次文件） */
export function readInjectedCookies(): SsoCookie[] {
  const raw = process.env.KEVE_SSO_COOKIES
    || readCookieFile(process.env.KEVE_SSO_COOKIES_FILE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SsoCookie[]) : [];
  } catch (err: any) {
    console.warn(`[keve global-setup] KEVE_SSO_COOKIES 解析失败：${err?.message || err}`);
    return [];
  }
}

function readCookieFile(file?: string): string {
  if (!file) return '';
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * 写出 storageState（只写文件，不启动浏览器）。
 * 返回实际写入的 cookie 数，供执行侧日志/断言使用。
 */
export function writeStorageState(storageStatePath: string): number {
  const cookies = readInjectedCookies();
  const domain = deriveCookieDomain(process.env.KEVE_TARGET_URL);
  const state = {
    cookies: cookies.map((c) => toPlaywrightCookie(c, domain)),
    origins: [],
  };
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.writeFileSync(storageStatePath, JSON.stringify(state, null, 2));
  return state.cookies.length;
}

export default async function () {
  const storageStatePath = resolveStorageStatePath();
  const count = writeStorageState(storageStatePath);
  if (count > 0) {
    console.log(`[keve global-setup] 注入服务端 cookies ${count} 条 → ${storageStatePath}`);
  } else {
    console.warn(
      `[keve global-setup] 未收到服务端 cookies（KEVE_SSO_COOKIES 为空），`
      + `写入空 storageState → ${storageStatePath}`,
    );
  }
}
