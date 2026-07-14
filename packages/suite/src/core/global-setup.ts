import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireStorageState } from './auth';

// ─── CDP 共享 Browser 对象 ────────────────────────────────────────
// CDP 模式下在 global-setup 中连接一次，所有用例共享同一个 Browser 对象
// 避免每个用例重复 connectOverCDP 导致的不稳定

declare global {
  var __keve_cdp_browser: import('@playwright/test').Browser | undefined;
}

export async function getCdpBrowser(): Promise<import('@playwright/test').Browser> {
  // 如果已有共享的 browser 对象，直接复用
  if (globalThis.__keve_cdp_browser && globalThis.__keve_cdp_browser.isConnected()) {
    return globalThis.__keve_cdp_browser;
  }

  const { chromium } = await import('@playwright/test');
  let wsUrl = process.env.KEVE_CDP_WS_ENDPOINT;

  // 如果只提供了 HTTP endpoint，自动获取 WebSocket URL
  if (!wsUrl && process.env.KEVE_CDP_ENDPOINT) {
    const httpUrl = process.env.KEVE_CDP_ENDPOINT.replace(/\/$/, '');
    try {
      const resp = await fetch(`${httpUrl}/json/version`);
      const data = await resp.json() as any;
      wsUrl = data.webSocketDebuggerUrl;
      console.log(`[keve CDP] Resolved WS endpoint: ${wsUrl}`);
    } catch (e: any) {
      throw new Error(`Failed to resolve CDP WebSocket URL from ${httpUrl}: ${e.message}`);
    }
  }
  if (!wsUrl) throw new Error('No CDP endpoint configured');

  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 15000 });
  console.log(`[keve CDP] Connected via ${wsUrl}`);
  globalThis.__keve_cdp_browser = browser;
  return browser;
}

export function isCdpMode(): boolean {
  return !!process.env.KEVE_CDP_WS_ENDPOINT || !!process.env.KEVE_CDP_ENDPOINT;
}

export default async function () {
  const projectRoot = path.resolve(process.cwd());
  const storageStatePath = path.resolve(projectRoot, '.auth/storage-state.json');

  const cdpEndpoint = process.env.KEVE_CDP_ENDPOINT || process.env.KEVE_CDP_WS_ENDPOINT;
  if (cdpEndpoint) {
    console.log(`[keve global-setup] CDP endpoint detected: ${cdpEndpoint}`);
    // CDP 模式：在 global-setup 中提前连接一次，缓存 Browser 对象
    try {
      const browser = await getCdpBrowser();
      const contexts = browser.contexts();
      const pages = contexts.length > 0 ? contexts[0].pages() : [];
      console.log(`[keve global-setup] CDP connected. contexts=${contexts.length}, pages=${pages.length}`);
      if (pages.length > 0) {
        console.log(`[keve global-setup] Existing tabs: ${pages.map(p => p.url()).join(', ')}`);
      }
    } catch (e: any) {
      console.warn(`[keve global-setup] CDP connection failed: ${e.message}`);
    }

    if (!fs.existsSync(storageStatePath)) {
      const authDir = path.dirname(storageStatePath);
      if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
    }
    return;
  }

  console.log(`[keve global-setup] Acquiring fresh auth state...`);
  const success = await acquireStorageState({
    logPrefix: '[keve global-setup]',
  });
  if (!success) {
    console.warn(`[keve global-setup] Auth acquisition failed. Tests may fail due to auth issues.`);
    if (!fs.existsSync(storageStatePath)) {
      const authDir = path.dirname(storageStatePath);
      if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
      console.log(`[keve global-setup] Created empty storage state → ${storageStatePath}`);
    }
  }
}
