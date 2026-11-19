import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLlmContextHeaders } from '../src/core/llm-context.js';

const ORIGINAL = {
  batch: process.env.KEVE_BATCH_ID,
  task: process.env.KEVE_TASK_ID,
  caller: process.env.KEVE_LLM_CALLER,
};

afterEach(() => {
  for (const [key, value] of [
    ['KEVE_BATCH_ID', ORIGINAL.batch],
    ['KEVE_TASK_ID', ORIGINAL.task],
    ['KEVE_LLM_CALLER', ORIGINAL.caller],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('llm context headers', () => {
  it('injects batch/task/caller headers without overwriting explicit values', async () => {
    process.env.KEVE_BATCH_ID = 'batch-254';
    process.env.KEVE_TASK_ID = 'task-90061';
    process.env.KEVE_LLM_CALLER = 'keve-playwright';

    const capture = vi.fn(async (_url: any, init: any) => new Response('ok', { status: 200 }));
    const wrapped = withLlmContextHeaders(capture as any);
    await wrapped('http://example.test/chat/completions', {
      method: 'POST',
      headers: { 'x-eve-caller': 'explicit-caller' },
    });

    const headers = new Headers(capture.mock.calls[0][1].headers);
    expect(headers.get('x-eve-batch-id')).toBe('batch-254');
    expect(headers.get('x-eve-task-id')).toBe('task-90061');
    expect(headers.get('x-eve-caller')).toBe('explicit-caller');
  });
});
