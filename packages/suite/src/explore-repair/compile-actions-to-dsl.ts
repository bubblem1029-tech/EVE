/**
 * explore-repair —— agent 探索动作序列 → 平台原始 DSL 编译器。
 *
 * 输入：探索任务的 AgentStepEvent 抽取（toolName/toolInput）+ 每个 ref 的 DOM 链捕获。
 * 输出：平台执行 DSL（cases[0].dslList），字段口径与 toDecorator 消费的 compilationInput 一致：
 *   text / operation / context: [{type, value, index}] / value / wait / expectation / children
 * 未支持动作显式跳过并告警，不做静默降级（避免生成假绿候选）。
 *
 * v1 支持映射：navigate→OPEN_PAGE、click→CLICK_ELEMENT、type→INPUT_ELEMENT、
 * wait→等待已 由 wait 字段表达（单跳等待直接并入下一步的 wait）。
 */
import type { CapturedChain, DomChainHop } from './element-chain.js';

export interface MissionAction {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** DOM 链快照（onAfterStep 时捕获；navigate/wait 等无目标元素的动作没有） */
  chain?: CapturedChain;
  /** 动作发生时的 URL（OPEN_PAGE 用） */
  url?: string;
}

export interface PlatformHop {
  type: string;
  value: string;
  index?: number;
}

export interface CompiledStep {
  text: string;
  operation: string;
  context: PlatformHop[];
  value?: unknown;
  wait: Array<{ text: string; waitType?: string; value?: unknown }>;
  expectation: unknown[];
  children: unknown[];
  [key: string]: unknown;
}

export interface CompileOutcome {
  dslList: CompiledStep[];
  skipped: Array<{ toolName: string; reason: string }>;
}

const SUPPORTED = new Set(['navigate', 'click', 'type', 'pressKey', 'wait', 'select_option']);
const IGNORED = new Set(['done', 'visual_assert', 'visual_locate', 'verify_value', 'execute_javascript']);

function hopsToContext(hops?: DomChainHop[]): PlatformHop[] {
  return (hops || []).map((h) => ({ type: h.kind, value: h.value, index: -1 }));
}

function stepText(kind: string, chain?: CapturedChain, extra?: string): string {
  const target = chain?.describe || (chain?.hops.length ? hopsToContext(chain.hops).map((h) => h.value).join(' → ') : '') || extra || kind;
  return `${kind}${target ? ' ' + target : ''}${extra ? ' ' + extra : ''}`;
}

export function compileActionsToDsl(actions: MissionAction[]): CompileOutcome {
  const dslList: CompiledStep[] = [];
  const skipped: CompileOutcome['skipped'] = [];
  let pendingWait = 0;

  for (const action of actions || []) {
    const { toolName } = action;
    if (IGNORED.has(toolName)) continue;
    if (toolName === 'wait') {
      pendingWait += Number(action.toolInput?.seconds ?? action.toolInput?.ms ?? 1) * 1000 || 1000;
      continue;
    }
    if (!SUPPORTED.has(toolName)) {
      skipped.push({ toolName, reason: `动作「${toolName}」暂无 DSL 映射，需扩展编译器或人工确认` });
      continue;
    }
    const wait = pendingWait ? [{ text: `等待${pendingWait}ms`, waitType: 'NUMBER', value: pendingWait }] : [];
    pendingWait = 0;

    if (toolName === 'navigate') {
      const url = String(action.url || action.toolInput?.url || '');
      if (!url) { skipped.push({ toolName, reason: 'navigate 缺 url' }); continue; }
      dslList.push({
        text: stepText('打开页面', undefined, url),
        operation: 'OPEN_PAGE',
        context: [{ type: 'selector', value: 'body', index: -1 }],
        value: { type: 'VALUE', value: url },
        wait,
        expectation: [],
        children: [],
      });
      continue;
    }

    const chain = action.chain;
    if (!chain || !chain.hops.length) {
      skipped.push({ toolName, reason: '目标元素未捕获到稳定定位链（纯 aria-ref 无法可靠还原）' });
      continue;
    }
    const context = hopsToContext(chain.hops);

    if (toolName === 'click') {
      dslList.push({
        text: stepText('点击', chain),
        operation: 'CLICK_ELEMENT',
        context,
        wait,
        expectation: [],
        children: [],
      });
      continue;
    }
    if (toolName === 'type' || toolName === 'select_option') {
      const text = String(action.toolInput?.text ?? '');
      if (!text) { skipped.push({ toolName, reason: `${toolName} 缺输入值` }); continue; }
      dslList.push({
        text: stepText('输入', chain, `「${text.slice(0, 30)}」`),
        operation: 'INPUT_ELEMENT',
        context,
        value: { type: 'VALUE', value: text },
        wait,
        expectation: [],
        children: [],
      });
      continue;
    }
    if (toolName === 'pressKey') {
      const key = String(action.toolInput?.key ?? '');
      dslList.push({
        text: stepText('输入', chain, `按键 ${key}`),
        operation: 'INPUT_ELEMENT',
        context,
        value: { type: 'VALUE', value: key },
        wait,
        expectation: [],
        children: [],
      });
    }
  }
  return { dslList, skipped };
}

/** 组装成与本地基线同形的 execution input（cases[0].dslList），便于直接进候选/验证链路 */
export function buildCandidateInput(
  compiled: CompileOutcome,
  meta: { projectId: number | string; stepGroupId: number | string; caseName: string },
): { cases: Array<Record<string, unknown>>; projectId: string; source?: string } & Record<string, unknown> {
  if (!compiled.dslList.length) throw new Error('探索结果无可编译步骤，拒绝生成空候选');
  return {
    projectId: String(meta.projectId),
    cases: [
      {
        caseName: meta.caseName,
        stepGroupId: Number(meta.stepGroupId),
        dslList: compiled.dslList,
      },
    ],
    source: 'explore_repair',
  };
}
