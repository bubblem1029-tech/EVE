/**
 * llm-context — 给 OpenAI 兼容请求补充批次/任务上下文
 *
 * backend 的 chat proxy 依赖这些头做批次级 429 熔断；缺失时只能做全局限流。
 */

export interface LlmContextEnv {
  batchId?: string;
  taskId?: string;
  caller?: string;
}

export function resolveLlmContextEnv(env: NodeJS.ProcessEnv = process.env): LlmContextEnv {
  return {
    batchId: String(env.KEVE_BATCH_ID || '').trim(),
    taskId: String(env.KEVE_TASK_ID || '').trim(),
    caller: String(env.KEVE_LLM_CALLER || 'keve-suite').trim(),
  };
}

/** 包装 fetch，统一注入 x-eve-batch-id / x-eve-task-id / x-eve-caller。 */
export function withLlmContextHeaders(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): typeof globalThis.fetch {
  const context = resolveLlmContextEnv(env);
  return (async (url: any, init: any = {}) => {
    const headers = new Headers(init.headers || {});
    if (context.batchId && !headers.has('x-eve-batch-id')) headers.set('x-eve-batch-id', context.batchId);
    if (context.taskId && !headers.has('x-eve-task-id')) headers.set('x-eve-task-id', context.taskId);
    if (context.caller && !headers.has('x-eve-caller')) headers.set('x-eve-caller', context.caller);
    return fetchImpl(url, { ...init, headers });
  }) as typeof globalThis.fetch;
}
