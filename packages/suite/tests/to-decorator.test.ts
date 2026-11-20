import { describe, expect, it } from 'vitest';
import { toDecorator } from '../src/dsl/toDecorator';

function render(step: Record<string, any>): string {
  return toDecorator({
    stepGroupId: 90061,
    caseName: 'click target demo',
    env: 'test',
    dslList: [step],
    account: null,
    variableList: [],
  } as any);
}

describe('toDecorator clickTarget', () => {
  it('emits the recorded click target as structured metadata', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击【分析QA专属】测试目录',
      context: [
        { type: 'selector', value: '#app' },
        { type: 'includes', value: '分析QA专属' },
        { type: 'selector', value: '.el-tree-node__content' },
      ],
      expectation: [],
    });
    expect(code).toContain('clickTarget: "分析QA专属"');
  });

  it('does not emit clickTarget for a selector-only chain', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击保存',
      context: [{ type: 'selector', value: '.save-button' }],
      expectation: [],
    });
    expect(code).not.toContain('clickTarget:');
  });
});

describe('toDecorator PAGE_READY', () => {
  it('renders the shared page-ready assertion with options', () => {
    const code = render({
      operation: 'OPEN_PAGE',
      value: 'https://example.test/dashboard',
      expectation: [
        {
          type: 'PAGE_READY',
          text: '页面渲染未出现白屏',
          options: { rootSelector: '#app', allowCanvas: false, stableTimes: 3 },
        },
      ],
    });
    expect(code).toContain('engine.expectPageReady');
    expect(code).toContain('"rootSelector":"#app"');
    expect(code).toContain('"allowCanvas":false');
  });
});

describe('toDecorator STABILIZE_PAGE', () => {
  it('renders the controlled stabilize operation', () => {
    const code = render({
      operation: 'STABILIZE_PAGE',
      text: '固定左侧会话列表动态内容',
      value: {
        type: 'CUSTOM',
        value: {
          replace: [{ selector: '.session-title', text: 'FIXED_TITLE' }],
          cover: ['.session-time'],
          freezeAnimation: true,
        },
      },
      expectation: [],
    });
    expect(code).toContain('engine.stabilizePage');
    expect(code).toContain('"selector":".session-title"');
    expect(code).toContain('"freezeAnimation":true');
  });

  it('refuses an empty stabilize config', () => {
    expect(() => render({
      operation: 'STABILIZE_PAGE',
      text: '空配置',
      value: { type: 'CUSTOM', value: {} },
      expectation: [],
    })).toThrow(/STABILIZE_PAGE 缺少稳定化配置/);
  });
});

describe('toDecorator SCREEN_SHOT_COMPARE options', () => {
  it('passes dual-baseline options to expectScreenshot', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '检查左侧会话列表',
      context: [{ type: 'selector', value: '.session-list' }],
      expectation: [{
        type: 'SCREEN_SHOT_COMPARE',
        text: '左侧会话列表未发生视觉劣化',
        value: { type: 'CUSTOM', value: 'dataagent.agent-515.sidebar' },
        context: [{ type: 'selector', value: '.session-list' }],
        options: {
          baselineMode: 'dual',
          approvedThresholdPct: 2,
          lastRunThresholdPct: 3,
        },
      }],
    });
    expect(code).toContain('engine.expectScreenshot');
    expect(code).toContain('"baselineMode":"dual"');
    expect(code).toContain('"lastRunThresholdPct":3');
  });
});

describe('toDecorator legacy UI compat', () => {
  it('maps the retired widget placeholder selector and copy', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击“确定”按钮',
      context: [{ type: 'text', value: '确定' }],
      expectation: [
        {
          text: '【图表区】存在“开始创建图表吧”文案',
          type: 'ELEMENT_EXIST',
          value: { type: '', value: '' },
          context: [
            { type: 'selector', index: -1, value: '.c-widget-placeholder-text-name' },
            { type: 'text', index: -1, value: '开始创建图表吧' },
          ],
        },
      ],
    });
    expect(code).toContain('.c-widget-placeholder');
    expect(code).toContain('手动快速添加');
    expect(code).not.toContain('c-widget-placeholder-text-name');
    expect(code).not.toContain('开始创建图表吧');
  });

  it('leaves unrelated selectors and copy untouched', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击新建看板',
      context: [{ type: 'selector', value: '[data-e2e-name="新建看板"]' }],
      expectation: [
        {
          text: '页面存在新建看板按钮',
          type: 'ELEMENT_EXIST',
          value: { type: '', value: '' },
          context: [{ type: 'selector', value: '[data-e2e-name="新建看板"]' }],
        },
      ],
    });
    expect(code).toContain('新建看板');
    expect(code).not.toContain('c-widget-placeholder');
    expect(code).not.toContain('手动快速添加');
  });

  it('repairs the classname attribute selector typo', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击指标',
      context: [
        { type: 'selector', value: '[classname="field-metric-tree"]' },
        { type: 'includes', value: '10' },
        { type: 'selector', value: '[data-e2e-name="列表项"]' },
      ],
      expectation: [],
    });
    expect(code).toContain('field-metric-tree');
    expect(code).not.toContain('classname');
  });

  it('lets MOVE_ELEMENT children inherit the parent iframe context', () => {
    const code = render({
      operation: 'MOVE_ELEMENT',
      text: '移动到分组规则表单项，点击请选择字段',
      context: [
        { type: 'iframe-url', value: 'https://example.test/compute-col-config' },
        { type: 'includes', value: '分组规则' },
        { type: 'selector', value: '[data-e2e-name="列表项"]' },
      ],
      children: [
        {
          operation: 'CLICK_ELEMENT',
          context: [{ type: 'selector', value: 'input[placeholder="请选择字段"]' }],
        },
      ],
      expectation: [],
    });
    const clickLine = code.split('\n').find((line) => line.includes('engine.click(')) || '';
    expect(clickLine).toContain('iframe-url');
    expect(clickLine).toContain('请选择字段');
  });

  it('scopes single-class hover assertions to the hovered row', () => {
    const code = render({
      operation: 'MOVE_ELEMENT',
      text: '移动到维度2列表项',
      context: [
        { type: 'selector', value: '[data-e2e-name="维度列表"]' },
        { type: 'includes', value: '维度2' },
        { type: 'selector', value: '[data-e2e-name="列表项"]' },
      ],
      expectation: [
        {
          text: 'icon不存在',
          type: 'ELEMENT_NOT_EXIST',
          value: { type: '', value: '' },
          context: [{ type: 'class', value: 'iconfont-bi' }],
        },
      ],
    });
    const expectLine = code.split('\n').find((line) => line.includes('expectNotExists')) || '';
    expect(expectLine).toContain('维度列表');
    expect(expectLine).toContain('iconfont-bi');
  });
});

describe('toDecorator jQuery :nth(N) compatibility', () => {
  it('converts a trailing :nth(N) selector into 1-based hop index', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击日期下拉第0项',
      context: [{ type: 'selector', value: '.item:nth(0)' }],
      expectation: [],
    });
    const clickLine = code.split('\n').find((line) => line.includes('engine.click(')) || '';
    expect(clickLine).toContain('value: ".item"');
    expect(clickLine).toContain('index: 1');
    expect(clickLine).not.toContain(':nth(');
  });

  it('converts :nth(N) on a class hop and keeps larger indexes', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击第二行',
      context: [{ type: 'class', value: 'row2:nth(1)' }],
      expectation: [],
    });
    const clickLine = code.split('\n').find((line) => line.includes('engine.click(')) || '';
    expect(clickLine).toContain('value: "row2"');
    expect(clickLine).toContain('index: 2');
    expect(clickLine).not.toContain(':nth(');
  });

  it('leaves normal selectors without :nth() untouched', () => {
    const code = render({
      operation: 'CLICK_ELEMENT',
      text: '点击保存',
      context: [{ type: 'selector', value: '.btn-primary' }],
      expectation: [],
    });
    const clickLine = code.split('\n').find((line) => line.includes('engine.click(')) || '';
    expect(clickLine).toContain('value: ".btn-primary"');
    expect(clickLine).not.toContain('index:');
  });
});
