import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('uses runner model name before a legacy model environment variable', async () => {
  vi.stubEnv('KEVE_LLM_MODEL_NAME', 'app-new-provider');
  vi.stubEnv('KEVE_LLM_MODEL', 'old-qwen');
  vi.resetModules();
  const { loadConfig } = await import('../src/config');
  expect(loadConfig('/nonexistent-keve-config-for-test').llm.model).toBe('app-new-provider');
});
