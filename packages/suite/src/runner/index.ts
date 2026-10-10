/**
 * runner — 平台任务执行的「纯函数」库面：bin 定位 / env 契约 / 用例投影
 *
 * 为什么单独拆出这一层：
 *   run-dsl-task.mjs（cli 面，非交互批跑）和本地调试工具的交互模式（client 面，
 *   cypress.open() / playwright --ui）需要跑出**完全一致**的 spec 脚本和环境变量，
 *   否则同一条用例在两种模式下会有不同行为，调试时看到的和线上跑的不是一回事。
 *
 * 分层约定（见 autotest-core同步新执行链路技术方案.md 2.7 节）：
 *   - suite（本文件）：只负责「给我 cases + env 描述，还你 spec 文件路径和 env 变量」，
 *     零 spawn、零 process.exit、零文件系统之外的副作用。
 *   - cli（run-dsl-task.mjs / 本地调试工具的 execution-adapter.js）：决定「谁来跑、
 *     以什么方式跑（headless / 交互）」，调用本文件的函数拼出可执行动作。
 *   - backend：只消费 cli 入口的输入输出契约（execution-input.json /
 *     execution-result.json），不 import 本文件一个函数。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toDecorator, stepExpectedText, type DslStep, type DslVariableRow } from '../dsl/index.js';

export type ExecutionEngine = 'cypress' | 'playwright';

export interface ResolveEngineBinOptions {
  engine: ExecutionEngine;
  /** 平台执行侧根目录（声明并安装了 cypress / @playwright/test / esbuild） */
  backendRoot: string;
  /** 本 runner 包根目录；本地调试等场景可退回到自身 node_modules */
  suiteRoot: string;
}

/**
 * 按引擎解析可执行文件路径。
 * 候选顺序：环境变量显式指定 → backendRoot/node_modules → suiteRoot/node_modules。
 * 三种调用方（线上 runner / 本地调试 open 模式）共用同一份候选顺序，
 * 避免「平台能跑、本地跑不起来」这类环境差异问题各自排查一遍。
 */
export function resolveEngineBin({ engine, backendRoot, suiteRoot }: ResolveEngineBinOptions): string | undefined {
  const envVar = engine === 'cypress'
    ? process.env.KEVE_CYPRESS_BIN
    : process.env.KEVE_PLAYWRIGHT_BIN;
  const binName = engine === 'cypress' ? 'cypress' : 'playwright';
  const candidates = [
    envVar,
    path.join(backendRoot, 'node_modules', '.bin', binName),
    path.join(suiteRoot, 'node_modules', '.bin', binName),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

/** esbuild 模块路径解析，Cypress 预处理器依赖。候选顺序与 resolveEngineBin 一致。 */
export function resolveEsbuildModule(backendRoot: string, suiteRoot: string): string | undefined {
  const candidates = [
    process.env.KEVE_ESBUILD_MODULE,
    path.join(backendRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(suiteRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

export interface BuildExecEnvOptions {
  input: {
    backendRoot?: string;
    env?: string;
    targetUrl?: string;
    ssoCookiesJson?: string;
    identitySsoCookies?: Record<string, string>;
    llm?: { baseUrl?: string; model?: string; apiKey?: string };
  };
  taskDir: string;
  round: string | number;
  engine: ExecutionEngine;
  /** 兜底 backendRoot：input.backendRoot 为空时使用 */
  defaultBackendRoot: string;
  suiteRoot: string;
}

/**
 * 两个引擎共用的 KEVE_* 环境变量契约。
 * run（headless 批跑）和 open（交互调试）模式必须拼出完全一致的变量集，
 * 否则同一份静态 cypress.config.mjs / playwright.config.mjs 在两种模式下读到不同的值。
 */
export function buildExecEnv({
  input,
  taskDir,
  round,
  engine,
  defaultBackendRoot,
  suiteRoot,
}: BuildExecEnvOptions): NodeJS.ProcessEnv {
  const backendRoot = input.backendRoot || defaultBackendRoot;
  return {
    ...process.env,
    KEVE_TASK_DIR: taskDir,
    KEVE_RESULT_DIR: path.join(taskDir, 'reports', `round-${round}`),
    KEVE_CASES_DIR: path.join(taskDir, 'cases'),
    KEVE_ARTIFACT_BASE: taskDir,
    KEVE_ROUND: String(round),
    KEVE_ENV: input.env || 'test',
    KEVE_TARGET_URL: input.targetUrl || '',
    KEVE_STORAGE_STATE: path.join(taskDir, '.auth', 'storage-state.json'),
    KEVE_SSO_COOKIES: input.ssoCookiesJson || '[]',
    KEVE_IDENTITY_SSO_COOKIES: JSON.stringify(input.identitySsoCookies || {}),
    KEVE_LLM_BASE_URL: input.llm?.baseUrl || process.env.KEVE_LLM_BASE_URL || '',
    KEVE_LLM_MODEL_NAME: input.llm?.model || process.env.KEVE_LLM_MODEL_NAME || '',
    KEVE_LLM_API_KEY: input.llm?.apiKey || process.env.KEVE_LLM_API_KEY || '',
    KEVE_ENGINE: engine,
    KEVE_ESBUILD_MODULE: resolveEsbuildModule(backendRoot, suiteRoot) || '',
  };
}

export interface CaseInput {
  stepGroupId: number | string;
  caseName?: string;
  dslList: DslStep[];
  variableList?: DslVariableRow[];
  accountInfo?: { accountInfo?: { name?: string; password?: string }; name?: string; password?: string } | null;
}

export interface ProjectCasesOptions {
  cases: CaseInput[];
  engine: ExecutionEngine;
  specDir: string;
  env: string;
  ssoInject?: boolean;
  /** 用例级账号未指定时的兜底账号 */
  defaultAccountInfo?: CaseInput['accountInfo'];
}

export interface CaseEntry {
  caseId: string;
  stepGroupId: number;
  caseName: string;
  specFile: string;
  stepCount: number;
  steps: { step: string; expected: string }[];
}

/** 从账号信息里提取 toDecorator 需要的占位账号（不下发密码到脚本正文以外的位置） */
function resolveAccount(accountInfo: CaseInput['accountInfo']): { name: string; password: string } | undefined {
  const account = (accountInfo as any)?.accountInfo || accountInfo;
  if (!account?.name) return undefined;
  return { name: String(account.name), password: String(account.password || '') };
}

/**
 * 投影 DSL 步骤为报告 outline，语义与 toDecorator 的 keveGoal 参数保持一致。
 * OPEN_PAGE 后紧跟的 WAIT_RESPONSE 会合并进同一个导航步骤，避免报告步骤数
 * 与脚本实际 keveGoal 数不一致。
 */
function buildCaseSteps(
  dslList: DslStep[],
  ctx: { env: string; variableList: DslVariableRow[]; account?: { name: string; password: string } },
): { step: string; expected: string }[] {
  const steps: { step: string; expected: string }[] = [];
  for (let i = 0; i < dslList.length; i++) {
    const d: any = dslList[i];
    const op = String(d?.operation || '');
    if (op === 'OPEN_PAGE') {
      let j = i + 1;
      const gates: any[] = [];
      while (j < dslList.length && String((dslList[j] as any)?.operation || '') === 'WAIT_RESPONSE') {
        gates.push(dslList[j++]);
      }
      if (gates.length) {
        const gateTexts = gates.map((g) => String(g?.text || '')).filter(Boolean);
        const gateExpects = gates
          .filter((g) => (g?.expectation || []).length > 0)
          .map((g) => stepExpectedText(g, ctx))
          .filter(Boolean);
        steps.push({
          step: String(d?.text || 'OPEN_PAGE'),
          expected: [...gateTexts, ...gateExpects].filter(Boolean).join('；') || '打开目标页面并等待就绪响应',
        });
        i = j - 1;
        continue;
      }
    }
    const stepText = String(d?.text || op || '');
    const expected = stepExpectedText(d, ctx);
    if (!stepText) continue;
    steps.push({ step: stepText, expected });
  }
  return steps;
}

/**
 * 逐条用例投影成装饰器脚本，落盘到 specDir，并返回报告索引（caseEntries）。
 * run / open 两种模式共用同一份投影，脚本内容、步骤文案完全一致。
 */
export function projectCasesToSpecs({
  cases,
  engine,
  specDir,
  env,
  ssoInject = true,
  defaultAccountInfo,
}: ProjectCasesOptions): CaseEntry[] {
  fs.mkdirSync(specDir, { recursive: true });
  const importFrom = engine === 'cypress' ? '@kkeve/suite/engine-cypress' : '@kkeve/suite/keve-test';

  const caseEntries: CaseEntry[] = [];
  for (const item of cases) {
    const stepGroupId = Number(item.stepGroupId);
    if (!Number.isFinite(stepGroupId)) {
      throw new Error(`用例缺少合法 stepGroupId: ${JSON.stringify(item.stepGroupId)}`);
    }
    const dslList = Array.isArray(item.dslList) ? item.dslList : [];
    if (!dslList.length) {
      throw new Error(`用例 ${stepGroupId} 的 dslList 为空，拒绝生成空脚本`);
    }

    const account = resolveAccount(item.accountInfo || defaultAccountInfo);
    const variableList = Array.isArray(item.variableList) ? item.variableList : [];
    const renderCtx = { env, variableList, account };
    const caseName = item.caseName || `用例 ${stepGroupId}`;
    const code = toDecorator({
      stepGroupId,
      caseName,
      dslList,
      env,
      variableList,
      account,
      ssoInject,
      importFrom,
    });

    const fileName = `sg${stepGroupId}.spec.ts`;
    fs.writeFileSync(path.join(specDir, fileName), code, 'utf-8');
    caseEntries.push({
      caseId: `S${stepGroupId}`,
      stepGroupId,
      caseName,
      specFile: fileName,
      stepCount: dslList.length,
      steps: buildCaseSteps(dslList, renderCtx),
    });
  }
  return caseEntries;
}

/** 供报告补全步骤文案的最小用例清单（cases/test-cases.yaml） */
export function buildCasesYaml(caseEntries: CaseEntry[]): string {
  const lines = ['modules:', '  - name: plan', '    cases:'];
  for (const entry of caseEntries) {
    lines.push(`      - id: ${entry.caseId}`);
    lines.push(`        title: ${JSON.stringify(entry.caseName)}`);
    if (Array.isArray(entry.steps) && entry.steps.length) {
      lines.push('        steps:');
      for (const step of entry.steps) {
        lines.push(`          - step: ${JSON.stringify(step.step || '')}`);
        lines.push(`            expected: ${JSON.stringify(step.expected || '')}`);
      }
    } else {
      lines.push('        steps: []');
    }
  }
  return lines.join('\n') + '\n';
}
