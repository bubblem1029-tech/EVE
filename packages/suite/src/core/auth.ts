/**
 * Auth utilities — acquire storage state for Playwright tests
 *
 * 1. Existing valid storage-state.json → skip
 * 2. CDP connect to user Chrome → reuse login state
 * 3. Manual browser login → fallback
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';  // getChromeWsUrl 需要用 lsof 检查端口
import { createRequire } from 'node:module';

// ─── Playwright Chromium resolver ───────────────────────────────────────────
async function getChromium() {
  const cwdRequire = createRequire(path.resolve(process.cwd(), 'node_modules'));
  const pwAbsolutePath = cwdRequire.resolve('@playwright/test');
  const pwModule = await import(pwAbsolutePath);
  const chromium = pwModule.chromium || pwModule.default?.chromium;
  if (!chromium) throw new Error('Failed to resolve chromium from @playwright/test');
  return chromium;
}

// ─── Chrome CDP helpers ─────────────────────────────────────────────────────

function getChromeUserDataDir(): string {
  const p = os.platform();
  const h = os.homedir();
  if (p === 'darwin') return path.join(h, 'Library', 'Application Support', 'Google', 'Chrome');
  if (p === 'win32') return path.join(h, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  return path.join(h, '.config', 'google-chrome');
}

/** 读取 DevToolsActivePort 获取 CDP WebSocket URL（端口须正在监听） */
function getChromeWsUrl(): string | null {
  const portFile = path.join(getChromeUserDataDir(), 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  try {
    const [portStr, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n').map(l => l.trim()).filter(Boolean);
    const port = parseInt(portStr, 10);
    if (!port || !wsPath) return null;
    try { execSync(`lsof -P -i TCP:${port} 2>/dev/null | grep LISTEN`, { encoding: 'utf8' }); }
    catch { return null; }
    return `ws://127.0.0.1:${port}${wsPath}`;
  } catch { return null; }
}

/** CDP 连接用户 Chrome → 打开目标页 → 保存 storage-state → 断开
 *  仅连接已运行的 Chrome（keve run 已确保 Chrome 启动 + debug 端口就绪）
 */
async function authViaCDP(targetUrl: string, storageStatePath: string, prefix: string): Promise<boolean> {
  const wsUrl = getChromeWsUrl();
  if (!wsUrl) {
    console.log(`${prefix} Chrome CDP not available`);
    return false;
  }

  console.log(`${prefix} Chrome CDP available, connecting...`);
  try {
    const chromium = await getChromium();
    const browser = await chromium.connectOverCDP(wsUrl, { timeout: 10000 });
    const context = browser.contexts()[0];
    if (!context) { browser.close(); return false; }

    // 访问目标页面，等登录重定向完成
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await waitForLoginRedirect(page);

    const onLoginPage = /login|auth|signin/i.test(page.url());
    if (onLoginPage) {
      console.log(`${prefix} CDP connected but target requires login`);
      await page.close(); browser.close(); return false;
    }

    // 保存 storage-state
    const cookies = await context.cookies();
    const state = { cookies, origins: [] };
    fs.writeFileSync(storageStatePath, JSON.stringify(state, null, 2));

    await page.close(); browser.close();
    console.log(`${prefix} CDP auth success (${cookies.length} cookies) → ${storageStatePath}`);
    return cookies.length > 0;
  } catch (e: any) {
    console.warn(`${prefix} CDP connect failed: ${e.message}`);
    return false;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

interface StorageState { cookies: PlaywrightCookie[]; origins: any[]; }

function isStorageStateValid(statePath: string, targetDomain?: string): boolean {
  if (!fs.existsSync(statePath)) return false;
  try {
    const s: StorageState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (!s.cookies?.length) return false;
    if (targetDomain && !s.cookies.some(c => c.domain?.includes(targetDomain))) return false;
    const now = Date.now() / 1000;
    return s.cookies.some(c => !c.expires || c.expires === -1 || c.expires > now);
  } catch { return false; }
}

function extractDomain(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}

async function waitForLoginRedirect(page: any, maxMs = 30000): Promise<boolean> {
  for (let i = 0; i < maxMs / 500; i++) {
    if (!/login|auth|signin/i.test(page.url())) break;
    await page.waitForTimeout(500);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
  return !/login|auth|signin|sign-in/i.test(page.url());
}

/** 手动登录 → 保存 storage-state */
async function authViaManualLogin(targetUrl: string, storageStatePath: string, prefix: string): Promise<boolean> {
  const loginUrl = targetUrl.replace(/\/?$/, '/login');
  console.log(`${prefix} Opening browser for manual login: ${loginUrl}`);
  console.log(`${prefix} Please login. Waiting up to 2 minutes...`);

  try {
    const browser = await (await getChromium()).launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch(() => page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }));

    let loginDetected = false;
    for (let i = 0; i < 120; i++) {
      if (!/login|auth|signin|sign-in/i.test(page.url())) { loginDetected = true; break; }
      await page.waitForTimeout(1000);
    }
    if (!loginDetected) console.log(`${prefix} Timeout (2min), saving current state...`);

    await waitForLoginRedirect(page);
    await context.storageState({ path: storageStatePath });
    const c = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8')).cookies?.length || 0;
    console.log(`${prefix} Auth saved (${c} cookies) → ${storageStatePath}`);
    await browser.close(); return c > 0;
  } catch (e: any) {
    console.error(`${prefix} Manual login error: ${e.message}`); return false;
  }
}

// ─── Main: acquireStorageState ──────────────────────────────────────────────

export interface AcquireOptions {
  targetUrl?: string;
  storageStatePath?: string;
  logPrefix?: string;
  onLoginDetected?: (url: string) => void;
  onStateSaved?: (cookieCount: number, originCount: number) => void;
  onError?: (msg: string) => void;
  onBrowserFailed?: (msg: string) => void;
}

export async function acquireStorageState(options: AcquireOptions = {}): Promise<boolean> {
  const targetUrl = options.targetUrl || process.env.PWGEN_TARGET_URL || 'http://localhost:3000';
  const storageStatePath = options.storageStatePath || path.resolve(process.cwd(), '.auth/storage-state.json');
  const prefix = options.logPrefix || '[keve]';
  const targetDomain = extractDomain(targetUrl);
  const authDir = path.dirname(storageStatePath);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  // Skip mode
  if (process.env.PWGEN_SKIP_AUTH === '1' || process.env.PWGEN_SKIP_AUTH === 'true') {
    fs.writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }, null, 2));
    console.log(`${prefix} PWGEN_SKIP_AUTH=1 → empty storage state saved`);
    return true;
  }

  // Step 1: 已有有效 storage-state
  if (isStorageStateValid(storageStatePath, targetDomain)) {
    console.log(`${prefix} Storage state valid → ${storageStatePath}`);
    return true;
  }

  // Step 2: CDP 连接用户 Chrome
  if (await authViaCDP(targetUrl, storageStatePath, prefix)) return true;

  // Step 3: 手动登录
  return await authViaManualLogin(targetUrl, storageStatePath, prefix);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface PlaywrightCookie {
  name: string; value: string;
  domain?: string; path?: string;
  secure?: boolean; httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None'; expires?: number;
}
