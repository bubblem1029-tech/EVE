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
