import { describe, expect, it } from 'vitest';
import {
  finalizeStabilizePageResult,
  normalizeStabilizePageOptions,
  stabilizeConfigHash,
  stabilizePageSource,
} from '../src/core/page-object/stabilizePage';

describe('stabilizePage', () => {
  it('normalizes nested DSL values', () => {
    const options = normalizeStabilizePageOptions({
      type: 'CUSTOM',
      value: {
        replace: [{ selector: ' .title ', text: '固定标题' }],
        cover: [' .time '],
        strict: true,
        timeoutMs: 1200,
      },
    });
    expect(options.replace).toEqual([{ selector: '.title', text: '固定标题', required: false }]);
    expect(options.cover).toEqual(['.time']);
    expect(options.strict).toBe(true);
    expect(options.timeoutMs).toBe(1200);
  });

  it('generates a browser-safe evaluate expression', () => {
    const source = stabilizePageSource({ hide: ['.loading'] });
    expect(source).toContain('MutationObserver');
    expect(source).toContain('".loading"');
    expect(() => new Function(source)).not.toThrow();
  });

  it('keeps the config hash stable for equivalent configs', () => {
    const a = stabilizeConfigHash({ hide: [' .loading '], freezeAnimation: true });
    const b = stabilizeConfigHash({ freezeAnimation: true, hide: ['.loading'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^stabilize:[0-9a-f]{8}$/);
  });

  it('fails strict configs when selectors are missing', () => {
    expect(() => finalizeStabilizePageResult(
      { strict: true },
      { replaced: 0, hidden: 0, covered: 0, missingSelectors: ['.missing'] },
    )).toThrow(/选择器缺失/);
  });
});
