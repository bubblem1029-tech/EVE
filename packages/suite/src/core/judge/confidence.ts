/**
 * confidence — 用例结论与置信度的**引擎无关**判定
 *
 * 为什么单独成模块：Playwright 侧走 KeveReporter.onTestEnd，Cypress 侧没有
 * in-process reporter，只能在 spec 里把结果经 bridge 送回 Node 后自行落盘。
 * 两端若各写一份分类逻辑，报告必然漂移（同一失败在一边是 env、另一边是
 * unknown）。这里把「附件解析 → Agent 结论 → 错误分类 → confidence 记录」
 * 收敛成唯一实现，两端都只是喂数据。
 *
 * 约束：本模块只依赖类型与纯函数，Node 侧运行（读取 Buffer）。
 */

import { mergeRuntimeDiagnostics, type RuntimeDiagnostics } from '../../page-agent/diagnostics.js';

// ─── 附件契约 ────────────────────────────────────────────────────────

/** keveGoalResult attachment 的数据形态（Playwright / Cypress 完全一致） */
export interface StepResultAttachment {
  step: string;
  expected: string;
  precondition?: string;
  order: number;
  success: boolean;
  conclusion?: 'pass' | 'fail' | 'blocked';
  actions: Array<{
    tool?: string;
    role?: string;
    name?: string;
    url?: string;
    text?: string;
    reason?: string;
    success?: boolean;
    verdict?: string;
    conclusion?: 'pass' | 'fail' | 'blocked';
    result?: string;
    error?: string;
    toolOutput?: string;
    evaluation?: string;
    memory?: string;
    nextGoal?: string;
    screenshotPath?: string;
  }>;
  finalSnapshot?: string;
  diagnosticHints?: string[];
  /** 运行诊断：性能、网络、浏览器错误与质量信号 */
  diagnostics?: RuntimeDiagnostics;
  goalScreenshotBefore?: string;
  goalScreenshotAfter?: string;
  agentScreenshots?: string[];
}

/** 供分类使用的错误摘要（Error 实例跨引擎不可序列化，统一降级成 name+message） */
export interface ConfidenceError {
  message: string;
  name?: string;
}

export interface AttachmentLike {
  name?: string;
  contentType?: string;
  body?: any;
  /** 附件在磁盘上的路径（与 Playwright 报告 attachments[].path 同形） */
  path?: string;
}

export interface ClassifyInput {
  /** 用例完整标题（`${sceneId}: ${description}`） */
  title: string;
  /** 执行状态：passed | failed | timedOut | skipped | unknown（Playwright 语义） */
  status: string;
  /** 失败摘要；无失败传 null */
  error?: ConfidenceError | string | null;
  /** keveGoalResult 附件（已解析或原始附件均可，二选一） */
  steps: StepResultAttachment[];
  /** 原始附件列表（用于诊断提示与 keveScreenshots 标签） */
  attachments?: AttachmentLike[];
  /** 是否跳过 AI 评估（由调用方强制指定，如 Cypress 侧无 AI 阶段） */
  forceSkipAI?: boolean;
}

/** confidence-data.jsonl 的单行记录 */
export interface ConfidenceRecord {
  title: string;
  data: string;
  confidence: number;
  thought: string;
  errorCategory: ErrorCategory;
  keveScreenshots?: string[];
  steps: StepResultAttachment[];
  diagnosticHint?: string;
  /** 运行诊断（用例级聚合：各步骤求和/去重） */
  diagnostics?: RuntimeDiagnostics;
}

export type ErrorCategory =
  | 'script' | 'env' | 'assert' | 'visual' | 'text-mismatch'
  | 'incomplete' | 'pass' | 'unknown';

// ─── 常量 ────────────────────────────────────────────────────────────

/** confidence values by errorCategory — 给出有意义的分值而不是一律 0 */
export const CONFIDENCE_MAP: Record<string, number> = {
  pass: 100,            // 测试通过，确定性最高
  script: 95,           // 脚本代码错误，结果确定性高
  visual: 80,           // 视觉断言已评估，置信度较高
  'text-mismatch': 70,  // UI 文案格式不匹配（功能逻辑正确，措辞变了）
  assert: 50,           // 断言失败，需人工确认
  incomplete: 0,        // 执行被中断（超时/action 耗尽），无法得出结论
  env: 0,               // 环境问题，测试结果不可信
  unknown: 0,           // 未知异常，无参考价值
};

/** 环境/基础设施错误特征（与 keve-decorators 的历史判定保持同源） */
export const ENV_ERROR_PATTERNS =
  /timeout|timed out|locator.*not found|navigation.*intercepted|net::|ERR_|authenticate|redirect|ECONNREFUSED|socket hang up|Cannot navigate to invalid URL|Protocol error.*Page\.navigate/i;

// ─── 附件解析 ────────────────────────────────────────────────────────

/** 解码附件体：Playwright JSON reporter 会把 Buffer 序列化成 base64 字符串 */
export function decodeAttachmentBody(body: any): string {
  if (typeof body === 'string') {
    // 先按 base64 解一次，仍是 JSON 就用解码结果；否则按原始字符串处理
    try {
      const decoded = Buffer.from(body, 'base64').toString('utf8');
      JSON.parse(decoded);
      return decoded;
    } catch {
      return body;
    }
  }
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'object' && body !== null) return JSON.stringify(body);
  return String(body || '');
}

/** 从附件列表解析全部 keveGoalResult → 统一步骤数组 */
export function parseStepsFromAttachments(attachments: AttachmentLike[] | undefined): StepResultAttachment[] {
  const results: StepResultAttachment[] = [];
  for (const att of attachments || []) {
    if (att?.name !== 'keveGoalResult' || !att.body) continue;
    try {
      results.push(JSON.parse(decodeAttachmentBody(att.body)));
    } catch { /* skip malformed attachment */ }
  }
  return results;
}

/** 从附件提取 Agent 结论（result + text）。串行执行下取最后一步 */
export function extractAgentConclusion(
  steps: StepResultAttachment[],
): { result: 'pass' | 'fail' | 'blocked' | 'incomplete'; text: string } | undefined {
  if (steps.length === 0) return undefined;
  const lastStep = steps[steps.length - 1];

  if (lastStep.conclusion) {
    const doneAction = lastStep.actions?.find((a) => a.tool === 'done');
    return { result: lastStep.conclusion, text: doneAction?.text || '' };
  }

  if (lastStep.actions) {
    for (let j = lastStep.actions.length - 1; j >= 0; j--) {
      const action = lastStep.actions[j];
      if (action?.tool === 'done' && action?.conclusion) {
        return { result: action.conclusion, text: action.text || '' };
      }
    }
  }

  return { result: 'incomplete', text: '执行被中断，Agent未完成目标' };
}

/** 由 keveGoalResult（优先）+ keveDiagnosticHint（兜底）拼诊断提示 */
export function buildDiagnosticHint(attachments: AttachmentLike[] | undefined): string | undefined {
  const allHints: string[] = [];
  for (const gr of parseStepsFromAttachments(attachments)) {
    if (gr.success) continue;
    if (gr.diagnosticHints?.length) allHints.push(...gr.diagnosticHints);
  }
  if (allHints.length) return allHints.join('；');

  const hint = (attachments || []).find((a) => a.name === 'keveDiagnosticHint' && a.body);
  if (!hint) return undefined;
  try {
    const data = JSON.parse(decodeAttachmentBody(hint.body));
    return data.hints?.join('；') || undefined;
  } catch {
    return undefined;
  }
}

/** keveAssert-* 附件 → 截图标签列表（报告只保留 label） */
export function parseKeveScreenshotLabels(attachments: AttachmentLike[] | undefined): string[] {
  const labels: string[] = [];
  for (const att of attachments || []) {
    if (att?.name?.startsWith('keveAssert-') && att.contentType === 'application/json' && att.body) {
      labels.push(att.name.replace('keveAssert-', ''));
    }
  }
  return labels;
}

// ─── 分类主逻辑 ──────────────────────────────────────────────────────

function normalizeError(error: ClassifyInput['error']): ConfidenceError | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return { message: error };
  return { message: String(error.message || ''), name: error.name };
}

/**
 * 分类并生成 confidence 记录。
 *
 * 判定优先级：状态 → Agent 结论 → 错误特征兜底。两端共用同一条链路，
 * 所以「同一个失败模式在 Playwright 与 Cypress 下得到同一个 errorCategory」。
 */
export function buildConfidenceRecord(input: ClassifyInput): { record: ConfidenceRecord; skipAI: boolean; log: string } {
  const attachments = input.attachments || [];
  const steps = input.steps?.length ? input.steps : parseStepsFromAttachments(attachments);
  const agentConclusion = extractAgentConclusion(steps);
  const diagnosticHint = buildDiagnosticHint(attachments);
  const diagnostics = mergeRuntimeDiagnostics(steps.map((s) => s.diagnostics));

  let effectiveCategory: ErrorCategory = 'unknown';
  let skipAI = false;
  let classifiedMessage = '';

  if (input.status === 'skipped') {
    const record: ConfidenceRecord = {
      title: input.title,
      data: '跳过',
      confidence: 0,
      thought: '用例被跳过（非自动执行）',
      errorCategory: 'unknown',
      steps,
      diagnosticHint: undefined,
      diagnostics,
    };
    return { record, skipAI: true, log: 'SKIPPED' };
  }

  if (input.status === 'passed') {
    effectiveCategory = 'pass';
  } else if (agentConclusion) {
    classifiedMessage = agentConclusion.text.substring(0, 500);
    if (agentConclusion.result === 'pass') {
      // Agent 说通过但用例仍失败 → 脚本问题
      effectiveCategory = 'pass'; skipAI = true;
    } else if (agentConclusion.result === 'blocked') {
      effectiveCategory = 'env'; skipAI = true;
    } else if (agentConclusion.result === 'incomplete') {
      effectiveCategory = 'incomplete'; skipAI = true;
    } else {
      if (diagnosticHint && (diagnosticHint.includes('实际显示') || diagnosticHint.includes('页面实际') || diagnosticHint.includes('而非预期'))) {
        effectiveCategory = 'text-mismatch'; skipAI = false;
      } else {
        effectiveCategory = 'assert'; skipAI = false;
      }
    }
  } else {
    const err = normalizeError(input.error);
    if (err) {
      const rawError = err.message || '';
      classifiedMessage = rawError.substring(0, 500);
      const errName = err.name || '';

      if (errName === 'TypeError' || errName === 'ReferenceError' || errName === 'SyntaxError') {
        effectiveCategory = 'script'; skipAI = true;
      } else if (rawError.includes('视觉断言失败')) {
        effectiveCategory = 'visual'; skipAI = true;
      } else if (rawError.includes('expect(') || errName === 'AssertionError') {
        effectiveCategory = 'assert'; skipAI = false;
      } else if (ENV_ERROR_PATTERNS.test(rawError.substring(0, 300))) {
        effectiveCategory = 'env'; skipAI = true;
      } else if (rawError.includes('Re-Act loop did not achieve') || rawError.includes('Expected not achieved after agent explore')) {
        effectiveCategory = 'incomplete'; skipAI = true;
      } else if (rawError.includes('Expected not achieved')) {
        if (diagnosticHint && (diagnosticHint.includes('实际显示') || diagnosticHint.includes('页面实际'))) {
          effectiveCategory = 'text-mismatch'; skipAI = false;
        } else {
          effectiveCategory = 'incomplete'; skipAI = true;
        }
      } else {
        effectiveCategory = 'unknown'; skipAI = true;
      }
    }
  }

  const keveScreenshots = parseKeveScreenshotLabels(attachments);

  if (skipAI) {
    const thought = effectiveCategory === 'script'
      ? `脚本本身存在代码错误(${classifiedMessage})，测试结果无效`
      : effectiveCategory === 'env'
        ? `环境/基础设施异常(${classifiedMessage})，非应用功能问题`
        : effectiveCategory === 'visual'
          ? `视觉断言失败(${classifiedMessage})，已由keveAssert评估`
          : effectiveCategory === 'unknown'
            ? `无法分类的异常(${classifiedMessage})，跳过AI评估`
            : effectiveCategory === 'pass'
              ? `Agent判定通过但fn脚本执行失败(${classifiedMessage})，脚本需修复`
              : effectiveCategory === 'incomplete'
                ? `Agent执行超过探索上限(${classifiedMessage})，未完成目标，需要人工确认`
                : `无法分类的异常(${classifiedMessage})`;
    // AI 评估列：assert/text-mismatch → 不通过；其余无法得出结论 → 阻塞
    const aiData = (effectiveCategory === 'assert' || effectiveCategory === 'text-mismatch') ? '不通过' : '阻塞';
    return {
      record: {
        title: input.title,
        data: aiData,
        confidence: CONFIDENCE_MAP[effectiveCategory] ?? 0,
        thought,
        errorCategory: effectiveCategory,
        ...(keveScreenshots.length > 0 ? { keveScreenshots } : {}),
        steps,
        diagnosticHint,
        diagnostics,
      },
      skipAI: true,
      log: `SHORT-CIRCUIT skipAI (category=${effectiveCategory})`,
    };
  }

  return {
    record: {
      title: input.title,
      data: input.status === 'passed' ? '通过' : '不通过',
      confidence: CONFIDENCE_MAP[effectiveCategory] ?? 0,
      thought: input.status === 'passed' && agentConclusion?.result === 'pass' ? agentConclusion.text : '',
      errorCategory: effectiveCategory,
      ...(keveScreenshots.length > 0 ? { keveScreenshots } : {}),
      steps,
      diagnosticHint,
      diagnostics,
    },
    skipAI: false,
    log: `${input.status} (category=${effectiveCategory})`,
  };
}

/**
 * 落盘前的记录清洗：剔除大字段（base64 截图与整页快照），
 * 截图以文件路径形式存在于 goalScreenshotBefore/After 与 actions[].screenshotPath。
 */
export function sanitizeRecord(record: ConfidenceRecord): ConfidenceRecord {
  if (!record.steps) return record;
  record.steps = record.steps.map((step: any) => {
    const { screenshotBase64, finalSnapshot, ...stepRest } = step;
    if (stepRest.actions) {
      stepRest.actions = stepRest.actions.map((a: any) => {
        const { snapshotPreview, ...actionRest } = a;
        return actionRest;
      });
    }
    return stepRest;
  });
  return record;
}
