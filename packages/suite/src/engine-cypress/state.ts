/**
 * state — Cypress spec 内的「当前用例」执行状态（浏览器侧）
 *
 * Cypress 没有 Playwright 那样的 fixture 作用域，装饰器宿主、keveGoal、
 * 报告收集三者需要共享同一份状态。这里用模块级单例承载，
 * 由 host.ts 在 beforeEach 里重置、在测试体收口时读取。
 *
 * 约束：零依赖（会被打进 Cypress 浏览器 bundle）。
 */

/** 与 Playwright 附件同形的内存附件（body 为 JSON 字符串） */
export interface CyAttachment {
  name: string;
  contentType: string;
  body: string;
}

export interface CyTestState {
  /** 用例完整标题（`${id}: ${description}`），报告匹配的规范键 */
  title: string;
  /** spec 文件路径（仅展示用） */
  file: string;
  /** 当前用例的附件集合（keveGoalResult 等） */
  attachments: CyAttachment[];
  /** 当前用例的执行日志（对齐 Playwright 侧 test-results.json 的 stdout 字段） */
  logs: string[];
  /** 应用侧未捕获异常（由 Cypress uncaught:exception 事件收集） */
  uncaughtErrors: string[];
  /** keveGoal 在当前用例内的序号 */
  goalOrder: number;
  /** 是否被 skip（前置条件不满足 → blocked，不是 fail） */
  skipReason: string;
}

let current: CyTestState | null = null;

export function beginTestState(title: string, file = ''): CyTestState {
  current = { title, file, attachments: [], logs: [], uncaughtErrors: [], goalOrder: 0, skipReason: '' };
  return current;
}

export function getTestState(): CyTestState | null {
  return current;
}

/** 取当前状态；不在用例内时抛出可诊断的错误 */
export function requireTestState(): CyTestState {
  if (!current) {
    throw new Error('[keve] 当前不在用例执行上下文中：keveGoal 必须在 @keveScene 方法体内调用');
  }
  return current;
}

export function endTestState(): CyTestState | null {
  const out = current;
  current = null;
  return out;
}

export function addAttachment(att: CyAttachment): void {
  requireTestState().attachments.push(att);
}

/** 记录应用侧未捕获异常（Cypress uncaught:exception 事件） */
export function addUncaughtError(message: string): void {
  const state = getTestState();
  if (!state) return;
  state.uncaughtErrors.push(message);
}

/**
 * 记录一行执行日志。
 *
 * Cypress spec 跑在浏览器里，console.log 不会进入 Node 侧进程输出，
 * 因此 Playwright 那份 stdout 轨迹在 Cypress 下会缺失。这里显式收集，
 * 由 reporter 随结果一起送回 Node，保证两端报告同构。
 */
export function addLog(line: string): void {
  const state = getTestState();
  if (!state) return;
  state.logs.push(line.endsWith('\n') ? line : `${line}\n`);
}

export function nextGoalOrder(): number {
  const state = requireTestState();
  return state.goalOrder++;
}

/**
 * 把 JSON 文本编码成 base64。
 *
 * 必须这么做：Playwright 的 JSON reporter 会把 attachment 的 Buffer body 序列化成
 * base64 字符串，reportData.ts 也是无条件按 base64 解码。Cypress 侧直接写明文 JSON
 * 会导致报告里的 keveGoalResult 解析不出来（截图与步骤全丢）。
 */
export function encodeAttachmentBody(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
