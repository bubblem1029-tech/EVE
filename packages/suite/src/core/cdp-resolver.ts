import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface CdpResolverOptions {
  endpoint?: string;
  wsEndpoint?: string;
}

// TODO: consolidate doc-reading logic into keve-suite/spec

function getChromeUserDataDir(): string {
  const p = os.platform();
  const h = os.homedir();
  if (p === 'darwin') return path.join(h, 'Library', 'Application Support', 'Google', 'Chrome');
  if (p === 'win32') return path.join(h, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  return path.join(h, '.config', 'google-chrome');
}

function getChromeWsUrlFromPort(): string | null {
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

async function fetchWsUrlFromHttpEndpoint(endpoint: string): Promise<string | null> {
  try {
    const url = endpoint.replace(/\/$/, '') + '/json/version';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json() as any;
    return data.webSocketDebuggerUrl || null;
  } catch (e: any) {
    console.warn(`[cdp-resolver] Failed to fetch from ${endpoint}: ${e.message}`);
    return null;
  }
}

export async function resolveCdpWsUrl(options: CdpResolverOptions): Promise<string | null> {
  if (options.wsEndpoint) return options.wsEndpoint;

  if (options.endpoint) {
    const wsUrl = await fetchWsUrlFromHttpEndpoint(options.endpoint);
    if (wsUrl) return wsUrl;
  }

  return getChromeWsUrlFromPort();
}
