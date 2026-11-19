import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import { LLM } from '../../core/src/llm/index';
import { estimateRequestTokens, isContextLengthError } from '../../core/src/llm/budget';
import { compactHistory, fitContext, selectSnapshot, recordedClickTarget, clickMatchesTarget, canHandOffRecordedClick } from '../src/page-agent/context-budget';

describe('context budget', () => {
  it('retains the recorded specific target and rejects substituted click evidence', () => {
    expect(recordedClickTarget("await page.locator('text=订单示例数据集demo').click()" )).toBe('订单示例数据集demo');
    expect(recordedClickTarget('await engine.click(C({ type: "includes", value: "订单示例数据集demo" }))')).toBe('订单示例数据集demo');
    // Cypress 投影是 JSON 链，键名/值都带引号 —— 与 Playwright 内联对象同一口径解析
    expect(recordedClickTarget('await engine.click({ chain: [{ "type": "selector", "value": "#app" }, { "type": "includes", "value": "分析QA专属" }] })'))
      .toBe('分析QA专属');
    expect(recordedClickTarget('await engine.click({ chain: [{ "value": "分析QA专属", "type": "includes" }] })'))
      .toBe('分析QA专属');
    expect(recordedClickTarget("await page.getByText('订单示例数据集demo').count()" )).toBeUndefined();
    expect(clickMatchesTarget('- main:\n  - button "盖亚数据集" [ref=e1]', 'e1', '订单示例数据集demo')).toBe(false);
    expect(clickMatchesTarget('- main:\n  - row "订单示例数据集demo":\n    - button "选择" [ref=e2]', 'e2', '订单示例数据集demo')).toBe(true);
    expect(clickMatchesTarget('- main:\n  - textbox "订单示例数据集demo" [ref=e3]', 'e3', '订单示例数据集demo', 'c-dataset-item')).toBe(false);
    expect(clickMatchesTarget('- treeitem "订单示例数据集demo" [ref=e4]', 'e4', '订单示例数据集demo', 'c-dataset-item')).toBe(true);
  });

  it('hands off only an exact recorded click with no additional business assertion', () => {
    const source = 'await engine.click(C({ type: "includes", value: "订单示例数据集demo" }))';
    const tree = '- button "订单示例数据集demo" [ref=e1]\n- button "盖亚数据集" [ref=e2]';
    expect(canHandOffRecordedClick('操作完成，页面正常响应', source, tree, 'e1')).toBe(true);
    expect(canHandOffRecordedClick('操作完成，页面正常响应', source, tree, 'e2')).toBe(false);
    expect(canHandOffRecordedClick('数据集切换成功', source, tree, 'e1')).toBe(false);
    // 编译器下发的 clickTarget 优先于源码反推：Cypress JSON 链也能走同一套交接语义
    const cypressSource = 'await engine.click({ chain: [{ "type": "includes", "value": "订单示例数据集demo" }] })';
    expect(canHandOffRecordedClick('操作完成，页面正常响应', cypressSource, tree, 'e1')).toBe(true);
    expect(canHandOffRecordedClick('操作完成，页面正常响应', cypressSource, tree, 'e2', '订单示例数据集demo')).toBe(false);
  });
  it('counts schemas and images without counting base64 as text', () => {
    const a = estimateRequestTokens({ messages: [{ content: [{ image_url: { url: 'data:' + 'a'.repeat(100) } }] }] });
    const b = estimateRequestTokens({ messages: [{ content: [{ image_url: { url: 'data:' + 'a'.repeat(10000) } }] }] });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(4096);
    expect(estimateRequestTokens({ tools: [{ description: 'x'.repeat(3000) }] })).toBeGreaterThan(1000);
  });

  it('retains target refs and ancestors and marks partial trees', () => {
    const snapshot = '- main:\n' + Array.from({ length: 80 }, (_, i) => `  - button "item ${i}" [ref=e${i}]`).join('\n') +
      '\n  - dialog "编辑":\n    - button "确认" [ref=target]';
    const selected = selectSnapshot(snapshot, '确认', 180);
    expect(selected.partial).toBe(true);
    expect(selected.text).toContain('[ref=target]');
    expect(selected.text).toContain('dialog "编辑"');
    expect(() => parseYaml(selected.text)).not.toThrow();
    expect(selected.text.length).toBeLessThanOrEqual(180);
  });

  it('fits a large page without truncating the request or inventing absence', () => {
    const tree = '- main:\n' + Array.from({ length: 100 }, (_, i) => `  - button "确认 ${i}" [ref=e${i}]`).join('\n');
    const original = `<user_request>点击确认</user_request>\n<agent_history></agent_history>\nAccessibility Tree (YAML):\n\`\`\`yaml\n${tree}\n\`\`\``;
    const result = fitContext('test', original, [], 500);
    expect(result.estimatedTokens).toBeLessThanOrEqual(500);
    expect(result.user).toContain('<user_request>点击确认</user_request>');
    expect(result.user).toContain('PARTIAL');
  });

  it('deduplicates repeated observations while preserving recent actions', () => {
    const h = '<sys>timeout</sys>'.repeat(20) + '<step_1>\nAction: click target\nMemory: not submitted\n</step_1>';
    expect(compactHistory(h).match(/<sys>/g)).toHaveLength(1);
    expect(compactHistory(h)).toContain('click target');
  });

  it('reserves current page space when old reflection grows', () => {
    const history = Array.from({ length: 10 }, (_, i) => `<step_${i}>\nMemory: ${'重复记录'.repeat(200)}\nAction: click previous ${i}\n</step_${i}>`).join('\n');
    const tree = '- main:\n' + Array.from({ length: 100 }, (_, i) => `  - button "确认 ${i}" [ref=e${i}]`).join('\n');
    const result = fitContext('test', `<user_request>确认</user_request><agent_history>${history}</agent_history>Accessibility Tree (YAML):\n\`\`\`yaml\n${tree}\n\`\`\``, [], 900);
    expect(result.estimatedTokens).toBeLessThanOrEqual(900);
    expect(result.user).toContain('[ref=');
    expect(result.user).toContain('click previous 9');
  });

  it('never erases the latest action to satisfy an unattainable page reserve', () => {
    const tree = '- main:\n' + Array.from({ length: 100 }, (_, i) => `  - button "确认 ${i}" [ref=e${i}]`).join('\n');
    const original = `<user_request>确认</user_request><agent_history><step_1>\nAction: click target succeeded\nMemory: ${'历史'.repeat(500)}\n</step_1></agent_history>Accessibility Tree (YAML):\n\`\`\`yaml\n${tree}\n\`\`\``;
    const result = fitContext('x'.repeat(8000), original, [], 3200);
    expect(result.estimatedTokens).toBeLessThanOrEqual(3200);
    expect(result.user).toContain('click target succeeded');
  });

  it('does not classify an unspecified finish error as context overflow', () => {
    expect(isContextLengthError({ choices: [{ finish_reason: 'error' }] })).toBe(false);
    expect(isContextLengthError({ error: { code: 'INPUT_LENGTH_ERROR' } })).toBe(true);
  });

  it('rejects over-budget input without performing a network request or retry', async () => {
    const fetch = vi.fn();
    const llm = new LLM({ baseURL: 'https://test', model: 'test', customFetch: fetch,
      contextWindowTokens: 1000, maxOutputTokens: 500, contextSafetyTokens: 100 });
    await expect(llm.invoke([{ role: 'user', content: 'x'.repeat(10000) }], {})).rejects.toMatchObject({ type: 'context_length' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not synthesize successful completion from empty or free text output', async () => {
    const execute = vi.fn();
    const llm = new LLM({ baseURL: 'https://test', model: 'test', maxRetries: 0,
      customFetch: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }) });
    await expect(llm.invoke([], { done: { inputSchema: z.object({ success: z.boolean() }), execute } }))
      .rejects.toMatchObject({ type: 'no_tool_call' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not retry an explicit context error returned with HTTP 200', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: 'INPUT_LENGTH_ERROR' } }));
    const llm = new LLM({ baseURL: 'https://test', model: 'test', customFetch: fetch });
    await expect(llm.invoke([], {})).rejects.toMatchObject({ type: 'context_length' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
