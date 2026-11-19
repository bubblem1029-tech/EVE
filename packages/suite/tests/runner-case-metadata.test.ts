import { describe, expect, it } from 'vitest';
import { buildCasesYaml, runEnginePreflight, type CaseEntry } from '../src/runner/index.js';
import { parseYamlSimple } from '../src/core/generateReport/reportData.js';

function entry(overrides: Partial<CaseEntry> = {}): CaseEntry {
  return {
    caseId: 'S04902',
    caseKey: 'parameter-list.access-list',
    stepGroupId: 4902,
    caseName: '访问参数列表',
    title: '访问参数列表',
    displayName: '参数列表 · S04902 · 访问参数列表',
    detailLabel: '参数列表 / 参数列表 · S04902 · 访问参数列表',
    groupId: 'G_8291',
    groupName: '参数列表',
    groupPath: '参数列表 / 参数列表',
    groupRawName: '(0/42) 参数列表',
    groupDepth: 2,
    specFile: 'sg4902.spec.ts',
    stepCount: 1,
    steps: [{ step: '访问参数列表', expected: '页面打开' }],
    ...overrides,
  };
}

describe('runner case metadata', () => {
  it('writes group metadata into test-cases.yaml', () => {
    const parsed = parseYamlSimple(buildCasesYaml([entry()]));
    expect(parsed.modules[0].cases[0]).toMatchObject({
      id: 'S04902',
      caseKey: 'parameter-list.access-list',
      groupId: 'G_8291',
      groupName: '参数列表',
      groupPath: '参数列表 / 参数列表',
      groupRawName: '(0/42) 参数列表',
      groupDepth: 2,
    });
  });

  it('fails preflight before dispatch when the engine binary is missing', () => {
    const result = runEnginePreflight({
      engine: 'cypress',
      bin: '/definitely/missing/cypress',
      taskDir: process.cwd(),
      configPath: process.cwd(),
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('infra_engine_init_failed');
    expect(result.checks.some((item) => item.name === 'engine-binary' && !item.ok)).toBe(true);
  });
});
