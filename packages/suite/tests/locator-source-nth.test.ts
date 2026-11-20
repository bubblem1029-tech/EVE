import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { locatorSource } from '../src/dsl/locatorSource';

describe('locatorSource nth injection', () => {
  it('generates injectable source with working nth-child rewrite', () => {
    const src = locatorSource();
    expect(src).toContain(':nth-child(');
    const sandbox: any = { window: {}, document: {}, console };
    vm.createContext(sandbox);
    const result = vm.runInContext(src, sandbox);
    expect(result).toBe('ok');
    expect(sandbox.window.__keveLocatorSource).toBe('v7');
    expect(sandbox.window.__keveLocator.version).toBeDefined();
  });
});
