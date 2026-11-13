import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge } from '../src/engine-cypress/adapter.js';
import { resolveBaseUrl } from '../src/engine-cypress/host.js';

afterEach(() => vi.unstubAllGlobals());

describe('Cypress 16 public runtime configuration', () => {
  it('reads the bridge port from expose without calling the removed env API', async () => {
    const legacyEnv = vi.fn(() => { throw new Error('Cypress.env was removed'); });
    vi.stubGlobal('Cypress', {
      expose: (key: string) => key === 'KEVE_BRIDGE_PORT' ? 12345 : undefined,
      env: legacyEnv,
    });
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ json: async () => ({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createBridge().post('/smoke')).toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:12345/smoke');
    expect(legacyEnv).not.toHaveBeenCalled();
  });

  it('reads the target URL from expose', () => {
    vi.stubGlobal('Cypress', {
      config: () => '',
      expose: (key: string) => key === 'KEVE_TARGET_URL' ? 'https://example.test' : undefined,
    });
    expect(resolveBaseUrl()).toBe('https://example.test');
  });

  it('retains the legacy bridge configuration for older Cypress consumers', () => {
    vi.stubGlobal('Cypress', { env: () => 12345 });
    expect(createBridge()).toHaveProperty('post');
  });

  it('rejects missing bridge configuration rather than silently connecting elsewhere', () => {
    vi.stubGlobal('Cypress', { expose: () => undefined });
    expect(() => createBridge()).toThrow('KEVE_BRIDGE_PORT');
  });
});
