/**
 * KEVE Summary Report Data Generator
 *
 * Reads test-results.json, confidence-data.jsonl, and test-cases.yaml,
 * merges them into a structured report-data.json.
 *
 * This file handles ONLY data processing — no HTML rendering.
 * Rendering is handled by generate-html-renderer.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sceneGoalsMap } from '../keve-registry';

// ─── Configuration ───────────────────────────────────────────────
export interface ReportDataOptions {
  projectRoot: string;
  resultsPath: string;
  confidencePath?: string;
  casesPath?: string;
}

function resolveOptions(opts: ReportDataOptions) {
  const PROJECT_ROOT = opts.projectRoot;
  const TEST_RESULTS_JSON = opts.resultsPath;
  const CONFIDENCE_DATA_JSONL = opts.confidencePath || path.join(path.dirname(TEST_RESULTS_JSON), 'confidence-data.jsonl');
  const TEST_CASES_YAML = opts.casesPath || path.join(PROJECT_ROOT, 'test-cases.yaml');
  // REPORTS_DIR = parent of round-N dirs (e.g. .keve/{plan}/test-artifacts/)
  // test-results.json is inside round-N dir, so go up one level
  const RESULT_PARENT_DIR = path.dirname(path.dirname(TEST_RESULTS_JSON));
  const SCREENSHOTS_DIR = path.join(RESULT_PARENT_DIR, 'screenshots');
  const REPORTS_DIR = RESULT_PARENT_DIR;
  return { PROJECT_ROOT, TEST_RESULTS_JSON, CONFIDENCE_DATA_JSONL, TEST_CASES_YAML, SCREENSHOTS_DIR, REPORTS_DIR };
}

// ─── Types ───────────────────────────────────────────────────────
interface TestCaseStep { step: string; expected: string; }
interface TestCaseDef {
  id: string; title: string; priority: string; type: string;
  precondition: string[]; steps: TestCaseStep[]; notes: string;
}
interface TestModule { name: string; description: string; cases: TestCaseDef[]; }
interface TestCaseYaml {
  version: string; mr_id: string; description: string; docs_url: string;
  generated_at: string; modules: TestModule[];
}
interface SpecTest {
  status: string; duration: number; startTime: string;
  error: string; errors: string[]; stdout: string;
  steps: { title: string; duration: number; error: string | null; attachments: any[] }[];
  attachments: any[];
}
interface PlaywrightSpec {
  title: string; file: string; suitePath: string; tests: SpecTest[];
}
interface CaseResult {
  caseId: string; title: string; status: string; duration: number; startTime: string;
  error: string; errors: string[]; stdout: string;
  pwSteps: any[]; screenshotPath: string; videoPath: string; tracePath: string;
  attachments: any[]; keveScreenshots: { label: string; path: string }[];
  /** @deprecated 旧版 keveGoals attachment 数据，仅用于向后兼容合并 */
  keveGoals?: any[] | null;
  pwModuleTitle: string;
  /** @keveModel 提取的模块ID（如 'AG'） */
  pwModuleId: string;
  /** @keveModel 提取的模块描述（如 '智能应用列表筛选'） */
  pwModuleDescription: string;
  errorCategory?: string;
}

/**
 * StepReportItem: 单个步骤在报告中的完整数据契约（含截图）。
 * 从 confidence-data.jsonl 的 steps 提取，供前端报告精确渲染。
 */
export interface StepReportItem {
  step: string;
  expected: string;
  precondition?: string;
  order?: number;
  success?: boolean;
  /** fn 执行前截图路径（goal-before，页面原始状态） */
  goalScreenshotBefore?: string;
  /** 目标结果截图路径（keveGoal 执行后截图，来自 goalScreenshotPath / goalScreenshotAfter） */
  goalScreenshotPath?: string;
  /** 验证截图路径列表（agent 每步操作后截图，来自 verifyScreenshots / agentScreenshots） */
  verifyScreenshots?: string[];
  /** agent 操作步骤（含每步操作截图路径） */
  actions?: Array<{
    tool?: string;
    role?: string;
    name?: string;
    url?: string;
    text?: string;
    key?: string;
    reason?: string;
    success?: boolean;
    result?: string;
    error?: string;
    /** 工具执行返回结果（如 execute_javascript 的 JS 执行输出） */
    toolOutput?: string;
    evaluation?: string;
    memory?: string;
    nextGoal?: string;
    /** 操作截图路径 */
    screenshotPath?: string;
  }>;
  duration?: number;
  status?: string;
  error?: string | null;
}

/**
 * CaseReportItem: 报告数据与前端渲染之间的数据契约。
 * reportData 负责填充所有字段，前端报告只消费这些字段。
 * 任何渲染需要的字段必须在此定义，避免隐式依赖和字段错位。
 */
export interface CaseReportItem {
  /** 用例ID，如 "NA-10" */
  caseId: string;
  /** 模块标识符（YAML module.name 或 Playwright suitePath 提取） */
  module: string;
  /** 模块描述（YAML module.description 或 module.name） */
  moduleDescription: string;
  /** 用例标题（不含ID前缀，纯文字） */
  title: string;
  /** 优先级 */
  priority: string;
  /** 类型 */
  type: string;
  /** 前置条件列表 */
  precondition: string[];
  /** 统一步骤列表（含截图路径、agent 操作等完整数据） */
  steps: StepReportItem[];
  /** 备注 */
  notes: string;
  /** 执行状态: "passed" | "failed" | "skipped" | "missing" */
  status: string;
  /** 执行耗时(ms) */
  duration: number;
  /** 执行开始时间 */
  startTime: string;
  /** 错误信息 */
  error: string;
  /** 错误列表 */
  errors: string[];
  /** 标准输出 */
  stdout: string;
  /** Playwright 步骤 */
  pwSteps: any[];
  /** AI评估结论: "通过" | "不通过" | "待确认" */
  data: string;
  /** AI评估置信度 0-100 */
  confidence: number;
  /** AI评估推理过程 */
  confidenceReason: string;
  /** 步骤截图路径列表（前端按需加载，不再内嵌 base64） */
  stepScreenshots: { path: string }[];
  /** Playwright 失败截图路径（前端按需加载） */
  screenshotPath: string;
  /** 视频路径 */
  videoPath: string;
  /** Trace 路径 */
  tracePath: string;
  /** keveAssert 截图列表（仅保留 label + path，不再内嵌 base64） */
  keveScreenshots: { label: string; path: string }[];
  /** 错误分类（来自 @keveScene decorator） */
  errorCategory?: string;
  /** AI 观察到的诊断提示（如 disabled 按钮、SSO 重定向等） */
  diagnosticHint?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────
// 支持两种 caseId 格式：
//   1. LLM 生成的 AG-01 / WW-01 / REG-01 等：「字母-数字」用 dash 分隔
//   2. ktest 原始的 TCDPQA100195 / TCDPQA100189 等：「大写字母+数字」连续无分隔
//      （ktest 命名规则：TC=TestCase DPQA=数据平台QA 100195=序列号）
function parseCaseIdFromTitle(title: string): string | null {
  const colonMatch = title.match(/^([A-Z]+(?:-[A-Z]+)*-\d+|[A-Z]+\d+):/);
  const bracketMatch = title.match(/\[([A-Z]+(?:-[A-Z]+)*-\d+|[A-Z]+\d+)\]/);
  const spaceMatch = title.match(/^([A-Z]+(?:-[A-Z]+)*-\d+|[A-Z]+\d+)\s/);
  return colonMatch?.[1] || bracketMatch?.[1] || spaceMatch?.[1] || null;
}

/**
 * Strip surrounding quotes from YAML string values.
 * YAML uses quotes like id: "AG-01" which parseYamlSimple captures as "AG-01"
 * with the double quotes included. This strips them.
 */
function stripYamlQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Convert absolute path to relative path (relative to baseDir).
 *  Frontend uses /api/ai/task/:taskId/screenshot?path=... which rejects absolute paths,
 *  so all screenshot paths in report-data.json must be relative to the workspace root. */
function toRelativePath(absOrRelPath: string | undefined, baseDir: string): string {
  if (!absOrRelPath) return '';
  // Already relative? Return as-is
  if (!path.isAbsolute(absOrRelPath)) return absOrRelPath;
  // Convert absolute → relative
  return path.relative(baseDir, absOrRelPath);
}

function findScreenshotsForCase(caseId: string, screenshotsDir?: string, taskDir?: string): string[] {
  if (!screenshotsDir) return [];
  const files = fs.existsSync(screenshotsDir) ? fs.readdirSync(screenshotsDir) : [];
  const prefix = caseId.replace('-', '_');
  return files
    .filter(f => f.startsWith(prefix + '_') && f.endsWith('.png'))
    .sort()
    .map(f => {
      // 保留相对路径（相对于 taskDir），前端通过 API 按需加载
      const absPath = path.join(screenshotsDir, f);
      return taskDir ? path.relative(taskDir, absPath) : absPath;
    });
}

function parseYamlSimple(yamlText: string): TestCaseYaml {
  const lines = yamlText.split('\n');
  const result: TestCaseYaml = {
    version: '', mr_id: '', description: '', docs_url: '',
    generated_at: '', modules: []
  };

  let currentModule: TestModule | null = null;
  let currentCase: TestCaseDef | null = null;
  let currentStep: TestCaseStep | null = null;
  let inSteps = false;
  let inPrecondition = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Top-level fields
    if (trimmed.startsWith('version:') && !trimmed.startsWith('  ')) {
      result.version = trimmed.substring(trimmed.indexOf(':') + 1).trim();
    } else if (trimmed.startsWith('mr_id:')) {
      result.mr_id = trimmed.substring(trimmed.indexOf(':') + 1).trim();
    } else if (trimmed.startsWith('description:')) {
      result.description = trimmed.substring(trimmed.indexOf(':') + 1).trim();
    } else if (trimmed.startsWith('docs_url:')) {
      result.docs_url = trimmed.substring(trimmed.indexOf(':') + 1).trim();
    } else if (trimmed.startsWith('generated_at:')) {
      result.generated_at = trimmed.substring(trimmed.indexOf(':') + 1).trim();
    }

    // Module: YAML uses `  - name: "AG"` under `modules:`, which is 2-space indent
    // Also support `- module: "AG"` (0-indent) and `- 模块: "AG"`
    const moduleMatch = trimmed.match(/^  - (name|module|模块):\s*(.+)/);
    if (moduleMatch) {
      currentModule = { name: stripYamlQuotes(moduleMatch[2].trim()), description: '', cases: [] };
      result.modules.push(currentModule);
      inSteps = false;
      inPrecondition = false;
      continue;
    }

    if (currentModule && trimmed.startsWith('  description:') && !trimmed.startsWith('    ')) {
      currentModule.description = trimmed.substring(trimmed.indexOf(':') + 1).trim();
      continue;
    }

    // Case: `      - id: "AG-01"` at 6-space indent (inside module.cases)
    const caseMatch = trimmed.match(/^      - (id|用例ID):\s*(.+)/);
    if (caseMatch) {
      currentCase = {
        id: stripYamlQuotes(caseMatch[2].trim()), title: '', priority: '', type: '',
        precondition: [], steps: [], notes: ''
      };
      if (currentModule) currentModule.cases.push(currentCase);
      inSteps = false;
      inPrecondition = false;
      continue;
    }

    if (currentCase && !inSteps && !inPrecondition) {
      if (trimmed.startsWith('        title:')) {
        currentCase.title = stripYamlQuotes(trimmed.substring(trimmed.indexOf(':') + 1).trim());
      } else if (trimmed.startsWith('        priority:')) {
        currentCase.priority = stripYamlQuotes(trimmed.substring(trimmed.indexOf(':') + 1).trim());
      } else if (trimmed.startsWith('        type:')) {
        currentCase.type = stripYamlQuotes(trimmed.substring(trimmed.indexOf(':') + 1).trim());
      } else if (trimmed.startsWith('        precondition:')) {
        inPrecondition = true;
        continue;
      } else if (trimmed.startsWith('        steps:')) {
        inSteps = true;
        continue;
      } else if (trimmed.startsWith('        notes:')) {
        currentCase.notes = stripYamlQuotes(trimmed.substring(trimmed.indexOf(':') + 1).trim());
      }
    }

    if (inPrecondition && currentCase) {
      if (trimmed.startsWith('          - ')) {
        currentCase.precondition.push(stripYamlQuotes(trimmed.substring(trimmed.indexOf('- ') + 2).trim()));
      } else if (trimmed.startsWith('        ') && !trimmed.startsWith('          -')) {
        inPrecondition = false;
        if (trimmed.startsWith('        steps:')) inSteps = true;
      }
    }

    if (inSteps && currentCase) {
      if (trimmed.startsWith('          - step:')) {
        const stepText = trimmed.substring(trimmed.indexOf(':') + 1).trim();
        currentStep = { step: stripYamlQuotes(stepText), expected: '' };
        currentCase.steps.push(currentStep);
      } else if (trimmed.startsWith('            expected:') && currentStep) {
        currentStep.expected = stripYamlQuotes(trimmed.substring(trimmed.indexOf(':') + 1).trim());
      } else if (trimmed.match(/^        [^ ]/) && !trimmed.startsWith('        steps:')) {
        // 8-space indent followed by non-space = case-level field, exit steps mode
        inSteps = false;
        currentStep = null;
      }
    }
  }

  return result;
}

// ─── Extract specs from test-results.json ─────────────────────────
function extractAllSpecs(jsonData: any): PlaywrightSpec[] {
  const specs: PlaywrightSpec[] = [];
  if (jsonData.suites) {
    for (const suite of jsonData.suites) {
      extractSpecsRecursive(suite, '', specs);
    }
  }
  return specs;
}

function extractSpecsRecursive(suite: any, parentPath: string, specs: PlaywrightSpec[]): void {
  const suitePath = parentPath ? `${parentPath} > ${suite.title}` : suite.title;
  if (suite.specs) {
    for (const spec of suite.specs) {
      specs.push({
        title: spec.title,
        file: spec.file || '',
        suitePath,
        tests: (spec.tests || []).map((t: any) => {
          const lastResult = t.results?.[t.results.length - 1];
          return {
            status: lastResult?.status || t.status || 'unknown',
            duration: lastResult?.duration?.duration || t.results?.[0]?.duration || 0,
            startTime: lastResult?.startTime || '',
            error: lastResult?.error?.message || '',
            errors: (lastResult?.errors || []).map((e: any) => e.message || ''),
            stdout: (lastResult?.stdout || []).map((s: any) => typeof s === 'string' ? s : (s.text || '')).join(''),
            steps: (lastResult?.steps || []).map((s: any) => ({
              title: s.title, duration: s.duration, error: s.error?.message || null, attachments: s.attachments || []
            })),
            attachments: lastResult?.attachments || [],
          };
        }),
      });
    }
  }
  if (suite.suites) {
    for (const child of suite.suites) {
      extractSpecsRecursive(child, suitePath, specs);
    }
  }
}

// ─── Shared attachment parsing ──────────────────────────────────────
/** Decode Playwright attachment body (may be base64 string, Buffer, or object) */
export function decodeAttachmentBody(body: any): string {
  if (typeof body === 'string') {
    // Playwright JSON reporter serializes as base64
    return Buffer.from(body, 'base64').toString('utf8');
  } else if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  } else if (typeof body === 'object' && body !== null) {
    return JSON.stringify(body);
  } else {
    return String(body || '');
  }
}

/** Parse keveGoals from Playwright test attachments */
export function parseKeveGoals(attachments: any[]): any[] | null {
  const att = (attachments || []).find((a: any) => a.name === 'keveGoals' && a.contentType === 'application/json');
  if (!att?.body) return null;
  try {
    const bodyStr = decodeAttachmentBody(att.body);
    const parsed = JSON.parse(bodyStr);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** Parse keveAssert results from Playwright test attachments */
export function parseKeveAsserts(attachments: any[]): { label: string; body: any }[] {
  const results: { label: string; body: any }[] = [];
  for (const att of (attachments || [])) {
    if (att.name?.startsWith('keveAssert-') && att.contentType === 'application/json' && att.body) {
      try {
        const bodyStr = decodeAttachmentBody(att.body);
        const body = JSON.parse(bodyStr);
        results.push({ label: att.name.replace('keveAssert-', ''), body });
      } catch { /* ignore */ }
    }
  }
  return results;
}

/** Extract keveAssert screenshot paths from Playwright test attachments */
export function parseKeveScreenshots(attachments: any[], taskDir: string): { label: string; path: string }[] {
  const screenshots: { label: string; path: string }[] = [];
  for (const att of (attachments || [])) {
    if (att.name?.startsWith('keveAssert-') && att.contentType === 'application/json' && att.body) {
      try {
        const bodyStr = decodeAttachmentBody(att.body);
        const body = JSON.parse(bodyStr);
        if (body.screenshotPath) {
          // 保留原始相对路径，前端通过 /api/ai/task/:taskId/screenshot?path=... 按需加载
          screenshots.push({ label: att.name.replace('keveAssert-', ''), path: body.screenshotPath });
        }
      } catch { /* ignore */ }
    }
  }
  return screenshots;
}

export function parseGoalScreenshots(attachments: any[], taskDir: string): { label: string; path: string }[] {
  const screenshots: { label: string; path: string }[] = [];
  for (const att of (attachments || [])) {
    if (att.name !== 'keveGoalResult' || att.contentType !== 'application/json' || !att.body) continue;
    try {
      const bodyStr = decodeAttachmentBody(att.body);
      const body = JSON.parse(bodyStr);
      const step = body.step || '';
      if (body.goalScreenshotBefore) {
        screenshots.push({ label: step ? `${step} - 执行前` : '执行前', path: body.goalScreenshotBefore });
      }
      if (body.goalScreenshotAfter) {
        screenshots.push({ label: step ? `${step} - 执行后` : '执行后', path: body.goalScreenshotAfter });
      }
      if (body.agentScreenshots && Array.isArray(body.agentScreenshots)) {
        body.agentScreenshots.forEach((sp: string, idx: number) => {
          if (sp) {
            screenshots.push({ label: step ? `${step} - 验证截图${idx + 1}` : `验证截图${idx + 1}`, path: sp });
          }
        });
      }
      if (body.actions && Array.isArray(body.actions)) {
        for (const action of body.actions) {
          if (action.screenshotPath) {
            const actionLabel = action.tool ? `${step} - ${action.tool}` : (step || '操作步骤');
            screenshots.push({ label: actionLabel, path: action.screenshotPath });
          }
        }
      }
    } catch { /* ignore */ }
  }
  return screenshots;
}

// ─── Build case result map ───────────────────────────────────────
function buildCaseResultMap(specs: PlaywrightSpec[], taskDir: string): Record<string, CaseResult> {
  const map: Record<string, CaseResult> = {};
  for (const spec of specs) {
    const caseId = parseCaseIdFromTitle(spec.title);
    if (!caseId) continue;

    const test = spec.tests[spec.tests.length - 1] || spec.tests[0];
    if (!test) continue;

    let screenshotPath = '';
    let tracePath = '';
    let videoPath = '';

    const allAttachments = test.attachments || test.steps?.flatMap((s: any) => s.attachments || []) || [];
    for (const att of allAttachments) {
      if (att.name === 'screenshot') screenshotPath = toRelativePath(att.path, taskDir);
      if (att.name === 'trace') tracePath = toRelativePath(att.path, taskDir);
    }

    for (const att of test.attachments || []) {
      if (att.name === 'screenshot' && !screenshotPath) screenshotPath = toRelativePath(att.path, taskDir);
      if (att.name === 'trace' && !tracePath) tracePath = toRelativePath(att.path, taskDir);
      if (att.name === 'video' && !videoPath) videoPath = toRelativePath(att.path, taskDir);
    }

    const keveScreenshots = parseKeveScreenshots(test.attachments || [], taskDir);
    const goalScreenshots = parseGoalScreenshots(test.attachments || [], taskDir);
    keveScreenshots.push(...goalScreenshots);
    // keveGoals: prefer @keveGoal decorator data from sceneGoalsMap, fallback to fixture attachment
    const decoratorGoals = sceneGoalsMap.get(spec.title);
    const keveGoals = decoratorGoals && decoratorGoals.length > 0
      ? decoratorGoals
      : parseKeveGoals(test.attachments || []);

    // Extract @keveModel info from suitePath: "file.spec.ts > ID: Description"
    const suitePathParts = spec.suitePath.split(' > ');
    const pwModuleTitle = suitePathParts.length >= 2 ? suitePathParts[suitePathParts.length - 1].trim() : suitePathParts[0].trim();
    // @keveModel title format: "${id}: ${description}" — extract module ID and description
    // 模块 ID 可能是字母格式（如 AG-01）或 ktest 纯数字格式（如 7473423）
    const moduleIdMatch = pwModuleTitle.match(/^([A-Z]+(?:-[A-Z]+)*|\d+):\s*(.+)$/);
    const pwModuleId = moduleIdMatch?.[1] || '';
    const pwModuleDescription = moduleIdMatch?.[2] || pwModuleTitle;

    map[caseId] = {
      caseId, title: spec.title, status: test.status, duration: test.duration || 0,
      startTime: test.startTime || '', error: test.error || '', errors: test.errors || [],
      stdout: test.stdout || '', pwSteps: test.steps || [],
      screenshotPath, videoPath, tracePath, attachments: test.attachments || [], keveScreenshots,
      keveGoals, pwModuleTitle, pwModuleId, pwModuleDescription,
    };
  }
  return map;
}

// ─── Main: Generate report data JSON ─────────────────────────────
export async function generateReportData(opts: ReportDataOptions): Promise<any> {
  const resolved = resolveOptions(opts);
  const { PROJECT_ROOT, TEST_RESULTS_JSON, CONFIDENCE_DATA_JSONL, TEST_CASES_YAML, SCREENSHOTS_DIR, REPORTS_DIR } = resolved;

  // Derive current round number from test-results.json path (e.g. .../test-artifacts/round-1/test-results.json → 1)
  const resultsDirName = path.basename(path.dirname(TEST_RESULTS_JSON));
  const currentRound = resultsDirName.startsWith('round-')
    ? parseInt(resultsDirName.replace('round-', ''))
    : 1;
  const roundDir = path.dirname(TEST_RESULTS_JSON); // same as the round-N directory
  const latestDir = path.join(REPORTS_DIR, 'latest');

  const testResultsRaw = fs.readFileSync(TEST_RESULTS_JSON, 'utf-8');
  const testResultsJson = JSON.parse(testResultsRaw);

  let testCasesData: TestCaseYaml = { version: '', modules: [], mr_id: '', description: '', docs_url: '', generated_at: '' };
  if (fs.existsSync(TEST_CASES_YAML)) {
    testCasesData = parseYamlSimple(fs.readFileSync(TEST_CASES_YAML, 'utf-8'));
  }

  const specs = extractAllSpecs(testResultsJson);
  // Derive taskDir from resultsPath: .../test-artifacts/round-N/test-results.json → taskDir is 2 levels up from test-artifacts/
  const taskDir = path.resolve(path.dirname(TEST_RESULTS_JSON), '..', '..');
  const caseResultMap = buildCaseResultMap(specs, taskDir);

  let total = 0, passed = 0, failed = 0, skipped = 0;
  const caseResults: CaseReportItem[] = [];
  const confidenceDist = { '95-100': 0, '61-90': 0, '41-60': 0, '0-40': 0 };

  // Read confidence-data.jsonl (AI evaluation results from KeveReporter)
  let aiConfidenceMap: Record<string, { data: string; confidence: number; thought: string; error: string | null; errorCategory?: string; diagnosticHint?: string; steps?: any[] }> = {};
  if (fs.existsSync(CONFIDENCE_DATA_JSONL)) {
    try {
      const lines = fs.readFileSync(CONFIDENCE_DATA_JSONL, 'utf-8').trim().split('\n');
      for (const line of lines) {
        const entry = JSON.parse(line);
        const key = entry.title || entry.testId;
        if (entry.confidence !== undefined) {
          // 新版 confidence-data.jsonl 有 steps 字段（合并后）
          // 旧版有 keveGoals + reactSteps，需要合并
          let steps = entry.steps;
          if (!steps) {
            // 旧版兼容：从 keveGoals + reactSteps 合并为 steps
            const goals = entry.keveGoals || [];
            const rs = entry.reactSteps || [];
            if (goals.length > 0 || rs.length > 0) {
              steps = goals.map((g: any, i: number) => {
                const matched = rs.find((r: any) => r.order === g.order || r.step === g.step) || rs[i];
                return {
                  step: g.step,
                  expected: g.expected,
                  precondition: g.precondition,
                  order: g.order,
                  success: matched?.success,
                  actions: matched?.actions || [],
                  diagnosticHints: matched?.diagnosticHints || [],
                  goalScreenshotBefore: matched?.goalScreenshotBefore,
                  goalScreenshotAfter: matched?.goalScreenshotAfter,
                  agentScreenshots: matched?.agentScreenshots || [],
                };
              });
              // 补上 reactSteps 中未匹配的步骤
              for (const r of rs) {
                if (!steps.some((s: any) => s.order === r.order)) {
                  steps.push({ ...r, precondition: undefined });
                }
              }
            }
          }
          aiConfidenceMap[key] = {
            data: entry.data || '待确认',
            confidence: entry.confidence,
            thought: entry.thought || '',
            error: entry.error || null,
            errorCategory: entry.errorCategory || undefined,
            diagnosticHint: entry.diagnosticHint || undefined,
            steps,
          };
        }
      }
      if (Object.keys(aiConfidenceMap).length > 0) {
        console.log(`  -> Loaded confidence from confidence-data.jsonl (${Object.keys(aiConfidenceMap).length} cases)`);
      }
    } catch {
      console.log(`  -> Warning: Failed to parse confidence-data.jsonl`);
    }
  }

  // Build case results
  // Primary data source: Playwright test-results.json (from @keveModel/@keveScene decorators)
  // Optional enhancement: test-cases.yaml (priority, precondition, type, notes)
  // This ensures decorator-defined structure drives the report, avoiding ID/title mismatch.

  // Build a YAML lookup by caseId for optional enrichment
  const yamlCaseLookup: Record<string, TestCaseDef> = {};
  const yamlModuleLookup: Record<string, TestModule> = {};
  for (const mod of testCasesData.modules) {
    yamlModuleLookup[mod.name] = mod;
    for (const caseDef of mod.cases) {
      yamlCaseLookup[caseDef.id] = caseDef;
    }
  }

  for (const [caseId, result] of Object.entries(caseResultMap)) {
    total++;
    // Playwright returns "timedOut" for test timeout — treat as failed
    const effectiveStatus = result.status === 'timedOut' ? 'failed' : result.status;
    if (effectiveStatus === 'passed') passed++;
    else if (effectiveStatus === 'skipped') skipped++;
    else failed++;

    // AI evaluation: match by Playwright title (scene.title, the canonical key)
    const aiEntry = aiConfidenceMap[result.title] || aiConfidenceMap[caseId];
    const data = effectiveStatus === 'skipped' ? '待确认' : (aiEntry?.data || '待确认');
    // When aiEntry is missing, confidence should be 0 (no AI evaluation performed),
    // not a hardcoded fallback like 70/35 which implies AI evaluated but was uncertain.
    const confidence = effectiveStatus === 'skipped' ? 0 : (aiEntry?.confidence ?? 0);
    const confidenceReason = effectiveStatus === 'skipped' ? '用例被跳过' : (aiEntry?.thought || '无AI评估数据');
    // Distribute by data value + confidence
    if (effectiveStatus === 'skipped') { /* skip */ }
    else if (data === '通过') confidenceDist['95-100']++;
    else if (data === '不通过' || confidence <= 40) confidenceDist['0-40']++;
    else if (confidence >= 61) confidenceDist['61-90']++;
    else confidenceDist['41-60']++;

    // 截图仅保留文件路径，前端按需加载（避免 14MB+ base64 内嵌）
    const stepScreenshotPaths = findScreenshotsForCase(caseId, SCREENSHOTS_DIR, taskDir);
    const stepScreenshotsPaths = stepScreenshotPaths.map(p => ({ path: p }));

    const keveScreenshotsPaths = (result.keveScreenshots || []).map((ks: any) => {
      const { base64, ...rest } = ks; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest; // 只保留 label, path 等元数据
    });

    // 失败截图不内嵌 base64，仅保留路径
    // screenshotBase64 已移除，前端通过 screenshotPath 按需加载

    // Module ID from @keveModel (extracted from Playwright suitePath)
    const moduleName = result.pwModuleId || 'default';
    const yamlMod = yamlModuleLookup[moduleName];
    // Module description: prefer @keveModel description, fallback to YAML
    const moduleDesc = result.pwModuleDescription || yamlMod?.description || moduleName;

    // YAML enrichment (optional): priority, type, precondition, notes, steps
    const yamlCase = yamlCaseLookup[caseId];
    // Title: use result.title (Playwright spec.title) but strip ID prefix for display
    const displayTitle = result.title.replace(/^[A-Z]+-\d+:\s*|^[A-Z]+\d+:\s*/, '').replace(/^\[[A-Z]+-\d+\]\s*|^\[[A-Z]+\d+\]\s*/, '');

    const steps: StepReportItem[] = aiEntry?.steps
      ? aiEntry.steps.map((s: any) => {
        // 截图路径保持原始相对路径（相对于 taskDir），
        // 前端通过 /api/ai/task/:taskId/screenshot?path=... 加载，
        // 后端会以 workspaceDir 为根拼接，拒绝绝对路径
        return {
          step: s.step,
          expected: s.expected,
          precondition: s.precondition,
          order: s.order,
          success: s.success,
          conclusion: s.conclusion,
          goalScreenshotBefore: s.goalScreenshotBefore,
          goalScreenshotPath: s.goalScreenshotPath || s.goalScreenshotAfter,
          verifyScreenshots: s.verifyScreenshots || s.agentScreenshots,
          actions: (s.actions || []).map((a: any) => ({
            tool: a.tool,
            role: a.role,
            name: a.name,
            url: a.url,
            text: a.text,
            key: a.key,
            reason: a.reason,
            success: a.success,
            verdict: a.verdict,
            conclusion: a.conclusion,
            result: a.result,
            error: a.error,
            toolOutput: a.toolOutput?.slice(0, 500),
            evaluation: a.evaluation?.slice(0, 300),
            memory: a.memory?.slice(0, 200),
            nextGoal: a.nextGoal?.slice(0, 200),
            screenshotPath: a.screenshotPath,
          })),
          duration: s.duration,
          status: s.status,
          error: s.error,
        };
      })
      : (result.keveGoals && result.keveGoals.length > 0
        ? result.keveGoals.map((g: any) => ({
          step: g.step,
          expected: g.expected,
          precondition: g.precondition,
          order: g.order,
        }))
        : []);

    // ── Merge executed steps with YAML outline ──
    // For timedOut/failed cases, only partial steps may have been executed.
    // We merge: executed steps (from aiEntry/keveGoals) + unexecuted steps (from YAML outline)
    // so the report shows the full picture (e.g. step 1 pass, step 2/3/4 "未执行").
    const maxExecutedOrder = steps.length > 0
      ? Math.max(...steps.map(s => s.order ?? 0))
      : -1;
    const executedStepSet = new Set(steps.map(s => s.step));

    if (yamlCase?.steps?.length) {
      for (let i = 0; i < yamlCase.steps.length; i++) {
        const ys = yamlCase.steps[i];
        // Skip if already present in executed steps (matched by step text or order)
        if (executedStepSet.has(ys.step)) continue;
        if (steps.some(s => s.order === i)) continue;
        // Add unexecuted YAML step
        steps.push({
          step: ys.step,
          expected: ys.expected,
          order: i,
          success: undefined,
          // Mark as unexecuted so frontend can render "未执行" state
          status: 'unexecuted',
        });
      }
      // Sort by order to ensure correct sequencing
      steps.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    caseResults.push({
      caseId,
      module: moduleName,
      moduleDescription: moduleDesc,
      title: displayTitle,
      priority: yamlCase?.priority || '',
      type: yamlCase?.type || '',
      precondition: yamlCase?.precondition || [],
      steps,
      notes: yamlCase?.notes || '',
      status: effectiveStatus,
      duration: result.duration,
      startTime: result.startTime,
      pwSteps: result.pwSteps,
      error: result.error,
      errors: result.errors,
      stdout: result.stdout,
      data,
      confidence,
      confidenceReason,
      stepScreenshots: stepScreenshotsPaths,
      screenshotPath: result.screenshotPath,
      videoPath: result.videoPath,
      tracePath: result.tracePath,
      keveScreenshots: keveScreenshotsPaths,
      errorCategory: aiEntry?.errorCategory,
      diagnosticHint: aiEntry?.diagnosticHint,
    });
  }

  // Also include YAML cases that have no matching Playwright result (not executed)
  for (const mod of testCasesData.modules) {
    for (const caseDef of mod.cases) {
      if (caseResultMap[caseDef.id]) continue; // Already included above
      total++;
      failed++;
      // Missing cases: test was not executed by Playwright, so AI evaluation is skipped
      const data = '跳过';
      const confidence = 0;
      confidenceDist['0-40']++;
      caseResults.push({
        caseId: caseDef.id,
        module: mod.name,
        moduleDescription: mod.description || mod.name,
        title: caseDef.title,
        priority: caseDef.priority,
        type: caseDef.type,
        precondition: caseDef.precondition,
        steps: caseDef.steps,
        notes: caseDef.notes,
        status: 'missing',
        duration: 0,
        startTime: '',
        pwSteps: [],
        error: 'YAML中定义了该用例，但Playwright未找到对应的执行结果。可能原因：1) 测试脚本中未实现该场景(@keveScene)；2) 用例ID与Playwright测试标题不匹配；3) 测试执行失败导致结果未写入。',
        errors: [],
        stdout: '',
        data,
        confidence,
        confidenceReason: 'YAML中定义但Playwright未执行，无AI评估数据',
        stepScreenshots: [],
        screenshotPath: '',
        videoPath: '',
        tracePath: '',
        keveScreenshots: [],
        errorCategory: undefined,
      });
    }
  }

  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';

  const summaryJson = {
    status: failed > 0 ? 'partial' : 'success',
    mr_id: testCasesData.mr_id, description: testCasesData.description,
    docs_url: testCasesData.docs_url,
    generated_at: new Date().toISOString().split('T')[0],
    round: currentRound,
    phases: { phase1: 'completed', phase2: 'completed', phase3: 'completed', phase4: 'completed' },
    summary: { total, passed, failed, skipped, pending: 0, passRate: `${passRate}%` },
    confidenceDist: {
      '95-100%可信': confidenceDist['95-100'],
      '61-90%需分析': confidenceDist['61-90'],
      '41-60%需分析极优先': confidenceDist['41-60'],
      '0-40%不可信': confidenceDist['0-40'],
    },
    artifacts: {
      testCases: '.keve/task_xxx/test-cases.yaml',
      poms: 'playwright_spec/poms/',
      specs: 'playwright_spec/ai-generated/',
      report: `.keve/reports/round-${currentRound}/summary-report.html`,
      playwrightReport: '.keve/playwright-report/index.html',
    },
    failedCases: caseResults.filter(c => c.status === 'failed').map(c => ({
      caseId: c.caseId, reason: (c.error || '').substring(0, 200),
      type: c.data, confidence: c.confidence, phase: 'phase3',
    })),
    nextSteps: [
      `查看完整报告: .keve/reports/round-${currentRound}/summary-report.html`,
      `重跑失败用例: keve run --retry-from=${currentRound}`,
    ],
  };

  const reportData = {
    summary: summaryJson, yamlData: testCasesData, caseResults,
    round: currentRound, history: [], roundDir, latestDir, reportsDir: REPORTS_DIR,
  };

  return reportData;
}

export { parseCaseIdFromTitle, extractAllSpecs, buildCaseResultMap, parseYamlSimple };
