import { describe, it, expect } from 'vitest';
import { compileActionsToDsl, buildCandidateInput, MissionAction } from './compile-actions-to-dsl.js';

const chain = (describe: string, hops: Array<{ kind: 'selector' | 'class' | 'text'; value: string }>) => ({
  ref: 'ref1',
  describe,
  hops,
});

describe('compileActionsToDsl', () => {
  it('编译 navigate → OPEN_PAGE', () => {
    const out = compileActionsToDsl([
      { toolName: 'navigate', toolInput: {}, url: 'https://kwaibi.corp.kuaishou.com/visual' },
    ]);
    expect(out.dslList).toHaveLength(1);
    expect(out.dslList[0].operation).toBe('OPEN_PAGE');
    expect((out.dslList[0].value as { type: string; value: string }).value).toContain('visual');
    expect(out.skipped).toHaveLength(0);
  });

  it('编译 click → CLICK_ELEMENT 且保留稳定定位链', () => {
    const out = compileActionsToDsl([
      {
        toolName: 'click',
        toolInput: { ref: 'f5e13' },
        chain: chain('button "确定"', [
          { kind: 'class', value: 'el-dialog__footer' },
          { kind: 'class', value: 'footer-button' },
          { kind: 'text', value: '确定' },
        ]),
      },
    ]);
    const step = out.dslList[0];
    expect(step.operation).toBe('CLICK_ELEMENT');
    expect(step.context).toEqual([
      { type: 'class', value: 'el-dialog__footer', index: -1 },
      { type: 'class', value: 'footer-button', index: -1 },
      { type: 'text', value: '确定', index: -1 },
    ]);
    expect(step.text).toContain('确定');
  });

  it('编译 type → INPUT_ELEMENT 并把前置 wait 挂到步骤上', () => {
    const out = compileActionsToDsl([
      { toolName: 'wait', toolInput: { seconds: 2 } },
      {
        toolName: 'type',
        toolInput: { ref: 'a1', text: '看板名称' },
        chain: chain('textbox', [{ kind: 'class', value: 'dashboard-name-input' }]),
      },
    ]);
    const step = out.dslList[0];
    expect(step.operation).toBe('INPUT_ELEMENT');
    expect((step.value as { value: string }).value).toBe('看板名称');
    expect(step.wait).toHaveLength(1);
    expect(step.wait[0].value).toBe(2000);
  });

  it('未支持动作与缺链动作显式跳过并给出原因', () => {
    const out = compileActionsToDsl([
      { toolName: 'drag', toolInput: {} },
      { toolName: 'click', toolInput: { ref: 'x' } },
      { toolName: 'done', toolInput: { verdict: 'pass', text: 'ok' } },
    ]);
    expect(out.dslList).toHaveLength(0);
    expect(out.skipped.map((s) => s.toolName)).toEqual(['drag', 'click']);
    expect(out.skipped[1].reason).toContain('定位链');
  });

  it('全部不可编译时 buildCandidateInput 拒绝生成空候选', () => {
    const compiled = compileActionsToDsl([{ toolName: 'click', toolInput: { ref: 'x' } }]);
    expect(() => buildCandidateInput(compiled, { projectId: 180, stepGroupId: 17, caseName: 'S17' })).toThrow(/空候选/);
  });

  it('buildCandidateInput 产出与基线同形的 cases[0].dslList', () => {
    const compiled = compileActionsToDsl([
      { toolName: 'click', toolInput: { ref: 'x' }, chain: chain('link 导航', [{ kind: 'text', value: '看板概览' }]) },
    ]);
    const input = buildCandidateInput(compiled, { projectId: 180, stepGroupId: 17, caseName: 'S17' });
    expect(input.projectId).toBe('180');
    const first = input.cases[0] as { stepGroupId: number; dslList: unknown[] };
    expect(first.stepGroupId).toBe(17);
    expect(first.dslList).toHaveLength(1);
  });
});
