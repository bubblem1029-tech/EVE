import { describe, expect, it } from 'vitest';
import { buildCaseIdentity, normalizeGroupName, splitGroupName } from '../src/core/case-identity.js';

describe('case identity', () => {
  it('strips dynamic group counters', () => {
    expect(splitGroupName('(0/42) 参数列表')).toEqual({
      name: '参数列表',
      stats: { passed: 0, total: 42 },
    });
    expect(normalizeGroupName('（12/42）参数列表')).toBe('参数列表');
  });

  it('keeps the immediate parent group and full path separately', () => {
    const identity = buildCaseIdentity({
      caseId: 'S04902',
      title: '访问参数列表',
      groupChain: [
        { id: 1, name: '(0/44) 参数列表' },
        { id: 2, name: '(0/42) 参数列表' },
      ],
    });

    expect(identity.groupId).toBe('2');
    expect(identity.groupName).toBe('参数列表');
    expect(identity.groupPath).toBe('参数列表 / 参数列表');
    expect(identity.groupRawName).toBe('(0/42) 参数列表');
    expect(identity.groupDepth).toBe(2);
    expect(identity.groupStats).toEqual({ passed: 0, total: 42 });
  });

  it('builds a compact readable display name', () => {
    const identity = buildCaseIdentity({
      caseId: 'S04902',
      title: '访问参数列表',
      caseKey: 'parameter-list.access-list',
      groupChain: [{ id: 2, name: '(0/42) 参数列表' }],
    });

    expect(identity.caseName).toBe('parameter-list.access-list');
    expect(identity.displayName).toBe('参数列表 · S04902 · 访问参数列表');
    expect(identity.detailLabel).toBe('参数列表 · S04902 · 访问参数列表');
  });

  it('falls back to a stable case key for titles without ASCII words', () => {
    const identity = buildCaseIdentity({ caseId: 'S04902', title: '访问参数列表' });
    expect(identity.caseName).toBe('case-s04902');
  });
});
