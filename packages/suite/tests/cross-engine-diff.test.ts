import { describe, expect, it } from 'vitest';
import { buildCrossEngineDiffReport } from '../src/core/cross-engine-diff.js';
import type { DiffCaseResult } from '../src/core/cross-engine-diff.js';

function caseResult(overrides: Partial<DiffCaseResult>): DiffCaseResult {
  return {
    caseId: 'S04902',
    caseName: 'parameter-list.access-list',
    title: '访问参数列表',
    groupName: '参数列表',
    groupPath: '参数列表 / 参数列表',
    verdict: 'pass',
    steps: [
      { order: 0, action: 'click', target: '搜索', expected: '下拉展开', verdict: 'pass' },
    ],
    ...overrides,
  };
}

describe('buildCrossEngineDiffReport', () => {
  it('marks identical cases as consistent', () => {
    const report = buildCrossEngineDiffReport(
      [caseResult({})],
      [caseResult({})],
      '2026-11-19T00:00:00.000Z',
    );
    expect(report.totals.consistent).toBe(1);
    expect(report.entries[0].diffType).toBe('consistent');
    expect(report.entries[0].displayName).toBe('参数列表 · S04902 · 访问参数列表');
  });

  it('reports verdict and reason differences before step differences', () => {
    const report = buildCrossEngineDiffReport(
      [caseResult({ verdict: 'pass' })],
      [caseResult({ verdict: 'blocked', reasonCode: 'infra_llm_429' })],
    );
    const entry = report.entries[0];
    expect(entry.diffType).toBe('verdict_diff');
    expect(entry.suggestedCategory).toBe('infra');
  });

  it('locates the first divergent step', () => {
    const report = buildCrossEngineDiffReport(
      [caseResult({})],
      [caseResult({
        steps: [
          { order: 0, action: 'click', target: '搜索', expected: '下拉展开', verdict: 'pass' },
          { order: 1, action: 'click', target: '天玑', expected: '进入详情', verdict: 'fail' },
        ],
      })],
    );
    const entry = report.entries[0];
    expect(entry.diffType).toBe('step_diff');
    expect(entry.firstDiffStep?.index).toBe(1);
    expect(entry.firstDiffStep?.fields).toContain('missing_playwright_step');
  });

  it('records missing engine cases explicitly', () => {
    const report = buildCrossEngineDiffReport([caseResult({})], []);
    expect(report.entries[0].diffType).toBe('case_missing_cypress');
    expect(report.totals.missing).toBe(1);
  });
});
