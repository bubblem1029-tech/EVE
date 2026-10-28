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
    expect(out.dslList[0].text).toBe('打开页面 https://kwaibi.corp.kuaishou.com/visual');
    expect((out.dslList[0].value as { type: string; value: string }).value).toContain('visual');
    expect(out.skipped).toHaveLength(0);
  });

  it('连续 navigate 同一地址不重复生成 OPEN_PAGE', () => {
    const url = 'https://kwaibi.corp.kuaishou.com/visual';
    const out = compileActionsToDsl([
      { toolName: 'navigate', toolInput: { url }, url },
      { toolName: 'navigate', toolInput: { url }, url },
      { toolName: 'click', toolInput: { ref: 'a' }, chain: chain('按钮', [{ kind: 'text', value: '查询' }]) },
    ]);
    expect(out.dslList.map((s) => s.operation)).toEqual(['OPEN_PAGE', 'CLICK_ELEMENT']);
  });

  it('隔了交互步骤后回到同一地址，视为真实二次跳转仍生成', () => {
    const url = 'https://kwaibi.corp.kuaishou.com/visual';
    const out = compileActionsToDsl([
      { toolName: 'navigate', toolInput: { url }, url },
      { toolName: 'click', toolInput: { ref: 'a' }, chain: chain('按钮', [{ kind: 'text', value: '查询' }]) },
      { toolName: 'navigate', toolInput: { url }, url },
    ]);
    expect(out.dslList.map((s) => s.operation)).toEqual(['OPEN_PAGE', 'CLICK_ELEMENT', 'OPEN_PAGE']);
  });

  it('不同地址的 navigate 仍各生成一步', () => {
    const out = compileActionsToDsl([
      { toolName: 'navigate', toolInput: {}, url: 'https://a.example.com' },
      { toolName: 'navigate', toolInput: {}, url: 'https://b.example.com' },
    ]);
    expect(out.dslList).toHaveLength(2);
  });

  it('chain.describe 存在时用它生成可读步骤文本', () => {
    const out = compileActionsToDsl([
      {
        toolName: 'click',
        toolInput: { ref: 'f5e13' },
        chain: chain('数据集负责人', [{ kind: 'class', value: 'owner-icon' }]),
      },
    ]);
    expect(out.dslList[0].text).toBe('点击 数据集负责人');
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

  it('buildCandidateInput 传入原始 dslList 时迁移页面级预期到末步', () => {
    const compiled = compileActionsToDsl([
      { toolName: 'click', toolInput: { ref: 'a' }, chain: chain('负责人', [{ kind: 'text', value: '负责人' }]) },
      { toolName: 'click', toolInput: { ref: 'b' }, chain: chain('头像', [{ kind: 'class', value: 'avatar' }]) },
    ]);
    buildCandidateInput(compiled, {
      projectId: 180,
      stepGroupId: 55,
      caseName: 'S55',
      originalDslList: [
        {
          operation: 'CLICK_ELEMENT',
          expectation: [
            { type: 'EXPECTED__PAGET_VALUE', ctype: 'url', cexpression: 'include', value: { type: 'CUSTOM', value: 'username?username=x' }, context: [], text: '页面链接包含username' },
            { type: 'ELEMENT_EXIST', context: [{ type: 'text', value: '某元素' }], text: '元素存在' },
          ],
        },
      ],
    });
    const last = compiled.dslList[compiled.dslList.length - 1];
    expect(last.expectation).toHaveLength(1);
    expect(String((last.expectation[0] as { type: string }).type)).toBe('EXPECTED__PAGET_VALUE');
    expect(compiled.expectationMigration).toEqual({ migrated: 1, dropped: 1 });
  });

  it('重复迁移同一页面级预期不叠加', () => {
    const compiled = compileActionsToDsl([
      { toolName: 'click', toolInput: { ref: 'a' }, chain: chain('负责人', [{ kind: 'text', value: '负责人' }]) },
    ]);
    const original = [
      { operation: 'CLICK_ELEMENT', expectation: [{ type: 'EXPECTED__PAGET_VALUE', ctype: 'url', cexpression: 'include', value: { type: 'CUSTOM', value: 'username=x' } }] },
    ];
    buildCandidateInput(compiled, { projectId: '1', stepGroupId: 1, caseName: 'S1', originalDslList: original });
    const first = JSON.stringify(compiled.dslList[0].expectation);
    buildCandidateInput(compiled, { projectId: '1', stepGroupId: 1, caseName: 'S1', originalDslList: original });
    expect(JSON.stringify(compiled.dslList[0].expectation)).toBe(first);
  });
});
