#!/usr/bin/env node
/**
 * run-dsl-task — 平台任务统一执行入口（Cypress / Playwright）
 *
 * 职责边界：
 *   - eve-backend 负责取数（stepGroup / stepDsl / element / variable / account）
 *     并把已展开、已解析的 dslList 写进 execution-input.json；
 *   - 本 runner 只做「投影 → 落盘 → 执行 → 出报告」，不直连业务库。
 *
 * 两个引擎共用同一份 @kkeve/suite 装饰器脚本与同一份 report-data.json 生成逻辑，
 * 因此 Cypress / Playwright 的报告结构完全一致。
 *
 * 用法：
 *   node run-dsl-task.mjs --input execution-input.json
 *
 * 输出：
 *   <taskRoot>/runs/execution-result.json（执行摘要，供 backend 回写任务终态）
 *   <taskRoot>/runs/manifest.json（任务产物索引，供 backend 单点读取）
 *   <taskRoot>/reports/round-<round>/report-data.json（前端报告）
 *
 * 任务目录结构（两个引擎完全一致）：
 *   <taskRoot>/specs/                       脚本
 *   <taskRoot>/reports/round-<round>/       报告 + 媒体（latest 软链指向最新轮次）
 *   <taskRoot>/runs/                        单次执行编排产物
 *   <taskRoot>/cases/test-cases.yaml        报告补全步骤文案的输入
 *
 * 引擎配置不再写入任务目录：统一使用 scripts/runtime/ 下的静态模板，
 * 通过 KEVE_TASK_DIR / KEVE_RESULT_DIR 等环境变量注入任务差异。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const suiteRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(__dirname, 'runtime');

/**
 * Cypress / esbuild / @playwright/test 由 eve-backend（平台执行侧）声明并安装。
 * 这里按「环境变量显式指定 → eve-backend/node_modules → suite/node_modules」回退，
 * 保证 runner 既能被 backend spawn，也能在 suite 本地调试。
 */
const defaultBackendRoot = path.resolve(suiteRoot, '..', '..', '..', 'eve-backend');

function resolveCypressBin(backendRoot) {
  const candidates = [
    process.env.KEVE_CYPRESS_BIN,
    path.join(backendRoot, 'node_modules', '.bin', 'cypress'),
    path.join(suiteRoot, 'node_modules', '.bin', 'cypress'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function resolveEsbuildModule(backendRoot) {
  const candidates = [
    process.env.KEVE_ESBUILD_MODULE,
    path.join(backendRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(suiteRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function resolvePlaywrightBin(backendRoot) {
  const candidates = [
    process.env.KEVE_PLAYWRIGHT_BIN,
    path.join(backendRoot, 'node_modules', '.bin', 'playwright'),
    path.join(suiteRoot, 'node_modules', '.bin', 'playwright'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[name] = true;
    else { args[name] = next; i++; }
  }
  return args;
}

function fail(message) {
  console.error(`[run-dsl-task] ${message}`);
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) fail(`${label} 不存在: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fail(`${label} 不是合法 JSON: ${err.message}`);
  }
}

/** DSL 字段在 DB 里可能是 JSON 字符串，投影前统一还原 */
function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"'))) {
    return value;
  }
  try { return JSON.parse(trimmed); } catch { return value; }
}

/**
 * 归一化 DSL 步骤，使其满足 toDecorator 的输入契约。
 * 任务里存的 dslList 已经过 backend 的 traveseFn + handleElement，
 * 这里只做「JSON 字符串还原」的兜底，不重复解析元素库。
 */
function normalizeStep(step) {
  const expectations = parseJsonValue(step?.expectation) || [];
  return {
    ...step,
    value: parseJsonValue(step?.value),
    context: parseJsonValue(step?.context) || [],
    wait: parseJsonValue(step?.wait) || [],
    expectation: (Array.isArray(expectations) ? expectations : []).map((item) => ({
      ...item,
      value: parseJsonValue(item?.value),
      context: parseJsonValue(item?.context) || [],
    })),
    child: parseJsonValue(step?.child),
    children: parseJsonValue(step?.children),
    stepIds: parseJsonValue(step?.stepIds),
  };
}

/**
 * 投影 DSL 步骤为报告 outline，语义与 toDecorator 的 keveGoal 参数保持一致。
 * OPEN_PAGE 后紧跟的 WAIT_RESPONSE 会合并进同一个导航步骤，避免报告步骤数
 * 与脚本实际 keveGoal 数不一致。
 *
 * expected 文案统一走 stepExpectedText（与脚本投影同一个函数）：报告里展示的
 * 预期与评测 Agent 读到的预期必须逐字一致，否则平台标签（「报错4」）会在报告
 * 与评测两侧产生不同解读。
 */
function buildCaseSteps(dslList, ctx, stepExpectedText) {
  const steps = [];
  for (let i = 0; i < dslList.length; i++) {
    const d = dslList[i];
    const op = String(d?.operation || '');
    if (op === 'OPEN_PAGE') {
      let j = i + 1;
      const gates = [];
      while (j < dslList.length && String(dslList[j]?.operation || '') === 'WAIT_RESPONSE') {
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

/** 从账号信息里提取 toDecorator 需要的占位账号（不下发密码到脚本正文以外的位置） */
function resolveAccount(accountInfo) {
  const account = accountInfo?.accountInfo || accountInfo;
  if (!account?.name) return undefined;
  return { name: String(account.name), password: String(account.password || '') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) fail('缺少 --input <execution-input.json>');

  const inputFile = path.resolve(args.input);
  const input = readJson(inputFile, '执行输入');

  const engine = input.engine === 'cypress' ? 'cypress' : 'playwright';
  const taskId = String(input.taskId ?? 'unknown');
  const round = String(input.round ?? 'latest');
  // taskRoot 是任务级自包含目录：脚本、报告、执行元数据都在其下。
  const taskRoot = path.resolve(
    input.taskDir || path.join(input.backendRoot || defaultBackendRoot, 'e2e', `task-${taskId}`),
  );
  const backendRoot = input.backendRoot || defaultBackendRoot;
  const specDir = path.join(taskRoot, 'specs');
  const reportsDir = path.join(taskRoot, 'reports');
  const runsDir = path.join(taskRoot, 'runs');
  const resultDir = path.join(reportsDir, `round-${round}`);
  const resultFile = path.join(runsDir, 'execution-result.json');
  const manifestFile = path.join(runsDir, 'manifest.json');

  const cases = Array.isArray(input.cases) ? input.cases : [];
  if (!cases.length) fail('执行输入里没有 cases，拒绝空跑');

  // Cypress host 需要一个 baseUrl 兜底（Playwright 侧同理）。
  // 优先使用 DSL 的真实 OPEN_PAGE 地址，避免环境映射覆盖用例目标。
  input.targetUrl = deriveTargetUrl(input, cases);
  // DSL 步骤里的本地地址（localhost / 127.0.0.1）会跟着用户手工用例原样落库，
  // 在远端执行时不可达；当调度入参带真实目标地址时，用目标地址的 host/port 替换。
  rewriteOpenPageTargets(input, cases);

  fs.rmSync(resultDir, { recursive: true, force: true });
  fs.rmSync(specDir, { recursive: true, force: true });
  fs.mkdirSync(specDir, { recursive: true });
  fs.mkdirSync(resultDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  // 上一次执行可能在报告收口前被外部重启打断，旧 result/manifest 会
  // 让 backend 误以为是本次结果；开始前必须清掉，只认本次新写出的文件。
  fs.rmSync(resultFile, { force: true });
  fs.rmSync(manifestFile, { force: true });

  const { toDecorator, stepExpectedText } = await import(
    url.pathToFileURL(path.join(suiteRoot, 'dist/dsl/index.js')).href
  );

  // ── 逐条用例投影成装饰器脚本 ──
  const caseEntries = [];
  for (const item of cases) {
    const stepGroupId = Number(item.stepGroupId);
    if (!Number.isFinite(stepGroupId)) fail(`用例缺少合法 stepGroupId: ${JSON.stringify(item.stepGroupId)}`);
    const rawList = Array.isArray(item.dslList) ? item.dslList : [];
    if (!rawList.length) fail(`用例 ${stepGroupId} 的 dslList 为空，拒绝生成空脚本`);

    const dslList = rawList.map(normalizeStep);
    const importFrom = engine === 'cypress'
      ? '@kkeve/suite/engine-cypress'
      : '@kkeve/suite/keve-test';
    const account = resolveAccount(item.accountInfo || input.accountInfo);
    const renderCtx = {
      env: input.env || 'test',
      variableList: Array.isArray(item.variableList) ? item.variableList : [],
      account,
    };
    const code = toDecorator({
      stepGroupId,
      caseName: item.caseName || `用例 ${stepGroupId}`,
      dslList,
      env: renderCtx.env,
      variableList: renderCtx.variableList,
      account: renderCtx.account,
      ssoInject: input.ssoInject !== false,
      importFrom,
    });

    const fileName = `sg${stepGroupId}.spec.ts`;
    fs.writeFileSync(path.join(specDir, fileName), code, 'utf-8');
    const dslSteps = buildCaseSteps(dslList, renderCtx, stepExpectedText);
    caseEntries.push({
      caseId: `S${stepGroupId}`,
      stepGroupId,
      caseName: item.caseName || `用例 ${stepGroupId}`,
      specFile: fileName,
      stepCount: dslList.length,
      steps: dslSteps,
    });
    console.log(`[run-dsl-task] 生成脚本 ${fileName}（${dslList.length} 步）`);
  }

  // ── 用例定义写入 cases/test-cases.yaml，让报告能补全步骤文案 ──
  const casesDir = path.join(taskRoot, 'cases');
  fs.mkdirSync(casesDir, { recursive: true });
  fs.writeFileSync(
    path.join(casesDir, 'test-cases.yaml'),
    buildCasesYaml(caseEntries),
    'utf-8',
  );

  // ── 执行 ──
  const runner = engine === 'cypress' ? runCypress : runPlaywright;
  const exitCode = runner({ input, taskDir: taskRoot, specDir, resultDir, round });

  // ── 汇总结果 ──
  // report-data.json 的顶层 summary 只带 total，逐条状态在 caseResults 里，
  // 因此以 caseResults 为准统计 passed/failed/skipped，summary 仅作兜底。
  const reportData = readReportData(resultDir);
  // 引擎退出码是 0 且报告缺失时，旧的实现会把 0 误判成成功。
  // 报告是前端明细与任务终态的唯一事实来源，缺失时无论退出码如何都按失败处理。
  if (!reportData) {
    fail(`执行结束后 report-data.json 不存在: ${path.join(resultDir, 'report-data.json')}（exitCode=${exitCode}）`);
  }
  const stats = summarizeReport(reportData);
  if (stats.total === 0) {
    fail(`report-data.json 没有可用用例结果（exitCode=${exitCode}），拒绝写成功结果`);
  }
  const passed = stats.passed;
  const failed = stats.failed;
  const skipped = stats.skipped;

  // ── 报告轮次索引：latest 软链 + manifest ──
  updateLatestLink(reportsDir, resultDir);
  writeManifest({
    manifestFile,
    taskRoot,
    taskId,
    engine,
    casePath: input.casePath || '',
    round,
    reportDataPath: path.join(resultDir, 'report-data.json'),
  });

  const result = {
    ok: exitCode === 0 && failed === 0,
    engine,
    taskId,
    exitCode,
    passed,
    failed,
    skipped,
    total: stats.total || passed + failed + skipped,
    caseEntries,
    taskDir: taskRoot,
    taskRoot,
    resultDir,
    reportDataPath: path.join(resultDir, 'report-data.json'),
    manifestPath: manifestFile,
    specDir,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  console.log(`[run-dsl-task] ${engine} 执行结束: passed=${passed} failed=${failed} skipped=${skipped}`);
  process.exit(result.ok ? 0 : 1);
}

/** reports/latest 软链指向最新轮次，便于 backend 按任务读取最近一次报告 */
function updateLatestLink(reportsDir, resultDir) {
  const latestDir = path.join(reportsDir, 'latest');
  if (path.resolve(latestDir) === path.resolve(resultDir)) return;
  try {
    if (fs.existsSync(latestDir)) {
      const stat = fs.lstatSync(latestDir);
      if (stat.isSymbolicLink()) fs.unlinkSync(latestDir);
      else fs.rmSync(latestDir, { recursive: true, force: true });
    }
    fs.symlinkSync(path.basename(resultDir), latestDir, 'junction');
  } catch (err) {
    console.warn(`[run-dsl-task] 创建 latest 软链失败: ${err.message}`);
  }
}

/**
 * 写任务产物索引。backend 侧只用这一份 manifest 定位脚本 / 报告 / 轮次，
 * 不再各自拼接引擎相关的目录名。
 */
function writeManifest({ manifestFile, taskRoot, taskId, engine, casePath, round, reportDataPath }) {
  let previous = {};
  try {
    if (fs.existsSync(manifestFile)) previous = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
  } catch { /* 索引损坏时重建 */ }

  const rel = (target) => path.relative(taskRoot, target).split(path.sep).join('/');
  const rounds = Array.isArray(previous.rounds) ? previous.rounds.filter(Boolean) : [];
  const roundNumber = Number(round);
  const entry = {
    round: Number.isFinite(roundNumber) ? roundNumber : round,
    resultDir: rel(path.dirname(reportDataPath)),
    reportData: rel(reportDataPath),
    updatedAt: new Date().toISOString(),
  };
  const existingIndex = rounds.findIndex((item) => String(item.round) === String(entry.round));
  if (existingIndex >= 0) rounds[existingIndex] = entry;
  else rounds.push(entry);
  rounds.sort((a, b) => Number(a.round) - Number(b.round));

  const manifest = {
    taskId,
    engine,
    casePath,
    taskRoot,
    specDir: 'specs',
    reportsDir: 'reports',
    latestRound: entry.round,
    rounds,
    updatedAt: entry.updatedAt,
  };
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

/** 供报告补全步骤文案的最小用例清单 */
function buildCasesYaml(caseEntries) {
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

function readReportData(resultDir) {
  const file = path.join(resultDir, 'report-data.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/**
 * 目标地址解析：优先使用用例 OPEN_PAGE 中的真实业务地址。
 * 只有 DSL 里的地址是本机占位地址，或 DSL 没有可用地址时，才使用调度入参。
 * 不做任何环境映射兜底——用例指定什么页面就访问什么页面，不私自替换为平台域名。
 *
 * 支持三种 OPEN_PAGE value 格式：
 *  1. 字符串：直接用
 *  2. { url } / { value }：取对应字段
 *  3. { type: 'VARIABLE', value: varId, variable: [{key,value}] }：
 *     从 variableList 查出对应环境的 URL，再应用 step.variable 改写
 */
function deriveTargetUrl(input, cases) {
  const env = String(input?.env || 'test');
  for (const item of cases) {
    const variableList = Array.isArray(item.variableList) ? item.variableList : [];
    for (const raw of Array.isArray(item?.dslList) ? item.dslList : []) {
      const step = normalizeStep(raw);
      if (String(step?.operation || '') !== 'OPEN_PAGE') continue;
      const value = step.value;
      let candidateUrl = '';
      if (typeof value === 'string') {
        candidateUrl = value.trim();
      } else if (value && typeof value === 'object') {
        if (value.type === 'VARIABLE' && variableList.length) {
          // 变量库引用：按 id 查找变量行，取对应环境列
          const varId = value.value;
          const row = variableList.find((r) => String(r.id) === String(varId));
          if (row) {
            const cols = [env, 'test', 'online', 'rc', 'pre'];
            const isUrl = (x) => typeof x === 'string' && /^https?:\/\//i.test(x.trim());
            const isPlaceholder = (x) => /^(1|0|true|false)$/i.test(String(x ?? '').trim());
            let base = '';
            for (const c of cols) { if (isUrl(row[c])) { base = row[c]; break; } }
            if (!base) {
              for (const c of cols) {
                const v = row[c];
                if (typeof v === 'string' && v.trim() && !isPlaceholder(v)) { base = v; break; }
              }
            }
            if (base) {
              // 应用 step.variable 改写（与 buildVariableUrl 同逻辑）
              const kv = new Map();
              for (const item of row.variable || []) {
                if (item && item.key !== undefined) kv.set(String(item.key), String(item.value ?? ''));
              }
              for (const item of value.variable || []) {
                if (item && item.key !== undefined) kv.set(String(item.key), String(item.value ?? ''));
              }
              let url = String(base).replace(/\$\{([^}]+)}/g, (m, k) => kv.has(k) ? kv.get(k) : m);
              for (const [k, v] of kv) {
                if (!v || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
                const re = new RegExp(`([?&])${k}=[^&#]*`);
                if (re.test(url)) url = url.replace(re, `$1${k}=${v}`);
                else url += (url.includes('?') ? '&' : '?') + `${k}=${v}`;
              }
              candidateUrl = url.trim();
            }
          }
        } else {
          candidateUrl = String(value?.url || value?.value || '').trim();
        }
      }
      if (!/^https?:\/\//i.test(candidateUrl)) continue;
      if (isLocalPlaceholderUrl(candidateUrl)) continue;
      return candidateUrl;
    }
  }

  const explicit = String(input?.targetUrl || '').trim();
  if (/^https?:\/\//i.test(explicit)) {
    return explicit;
  }
  // 无法从用例和调度参数中取到有效地址，不做环境映射兜底，返回空串。
  // cypress.config 中 baseUrl 留空时 Cypress 不会自行 visit，避免访问到平台自身域名。
  return '';
}

function isLocalPlaceholderUrl(value) {
  try {
    const host = new URL(value).hostname;
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host);
  } catch {
    return false;
  }
}

/**
 * 把 DSL 中指向本机的 OPEN_PAGE 地址投影为真实执行目标地址。
 *
 * 仅当调度入参 targetUrl 已明确解析时生效；保留原 URL 的 path/search/hash，
 * 避免破坏用例里「打开某页面 + dashboadId=xxx」这类带参数的导航。
 */
function rewriteOpenPageTargets(input, cases) {
  const targetUrl = String(input?.targetUrl || '').trim();
  if (!/^https?:\/\//i.test(targetUrl)) return;

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return;
  }

  const localHostRe = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i;
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    const raw = value.trim();
    if (!/^https?:\/\//i.test(raw)) return value;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return value;
    }
    if (!localHostRe.test(parsed.host)) return value;
    parsed.protocol = target.protocol;
    parsed.hostname = target.hostname;
    parsed.port = target.port;
    return parsed.toString();
  };

  for (const item of cases) {
    if (!Array.isArray(item?.dslList)) continue;
    for (const step of item.dslList) {
      if (String(step?.operation || '') !== 'OPEN_PAGE') continue;
      if (step.value && typeof step.value === 'object' && 'value' in step.value) {
        step.value.value = rewrite(step.value.value);
      } else {
        step.value = rewrite(step.value);
      }
    }
  }
}

/**
 * 逐条统计 caseResults 状态。
 *
 * 只有显式 `skipped` 才算跳过；`missing` / `timedOut` / `unknown` / `error`
 * 都代表用例没有得到有效执行结果或执行异常，必须计为失败。历史实现把它们
 * 统一算成 skipped，导致 Cypress 已报 `1 failed` 时平台仍展示 0 失败。
 */
function summarizeReport(reportData) {
  const cases = Array.isArray(reportData?.caseResults) ? reportData.caseResults : [];
  if (cases.length) {
    const passed = cases.filter((item) => item?.status === 'passed').length;
    const skipped = cases.filter((item) => item?.status === 'skipped').length;
    const failed = cases.length - passed - skipped;
    return { passed, failed, skipped, total: cases.length };
  }
  const summary = reportData?.summary?.summary || reportData?.summary || {};
  const passed = Number(summary.passed || 0);
  const failed = Number(summary.failed || 0);
  const skipped = Number(summary.skipped || 0);
  return {
    passed,
    failed,
    skipped,
    total: Number(summary.total || passed + failed + skipped),
  };
}

function runPlaywright({ input, taskDir, specDir, resultDir, round }) {
  const configPath = path.join(runtimeDir, 'playwright.config.mjs');
  const backendRoot = input.backendRoot || defaultBackendRoot;
  const cli = resolvePlaywrightBin(backendRoot);
  if (!cli || !fs.existsSync(cli)) fail('找不到 Playwright 可执行文件，请设置 KEVE_PLAYWRIGHT_BIN');
  const result = spawnSync(cli, ['test', '--config', configPath], {
    cwd: taskDir,
    stdio: 'inherit',
    env: buildExecEnv({ input, taskDir, round, engine: 'playwright' }),
  });
  if (result.error) fail(`Playwright 启动失败: ${result.error.message}`);
  return result.status ?? 1;
}

function useCypressConfig({ taskDir, specDir, resultDir }) {
  return path.join(runtimeDir, 'cypress.config.mjs');
}

function runCypress({ input, taskDir, specDir, resultDir, round }) {
  const configPath = useCypressConfig({ taskDir, specDir, resultDir });
  const backendRoot = input.backendRoot || defaultBackendRoot;
  const cypressBin = resolveCypressBin(backendRoot);
  if (!cypressBin || !fs.existsSync(cypressBin)) {
    fail('找不到 Cypress 可执行文件，请设置 KEVE_CYPRESS_BIN');
  }
  const result = spawnSync(cypressBin, [
    'run',
    '--project', taskDir,
    '--config-file', configPath,
    '--browser', process.env.KEVE_CYPRESS_BROWSER || 'electron',
  ], {
    cwd: taskDir,
    stdio: 'inherit',
    env: {
      ...buildExecEnv({ input, taskDir, round, engine: 'cypress' }),
      // Cypress 内部会 fork Electron；清空该变量避免以纯 Node 模式启动
      ELECTRON_RUN_AS_NODE: '',
    },
  });
  if (result.error) fail(`Cypress 启动失败: ${result.error.message}`);
  return result.status ?? 1;
}

/** 两个引擎共用同一套环境变量契约 */
function buildExecEnv({ input, taskDir, round, engine }) {
  const backendRoot = input.backendRoot || defaultBackendRoot;
  return {
    ...process.env,
    KEVE_TASK_DIR: taskDir,
    KEVE_RESULT_DIR: path.join(taskDir, 'reports', `round-${round}`),
    KEVE_CASES_DIR: path.join(taskDir, 'cases'),
    // 媒体相对路径以任务根为基准，保证 report-data.json 里不出现 `..`
    KEVE_ARTIFACT_BASE: taskDir,
    KEVE_ROUND: round,
    KEVE_ENV: input.env || 'test',
    KEVE_TARGET_URL: input.targetUrl || '',
    KEVE_STORAGE_STATE: path.join(taskDir, '.auth', 'storage-state.json'),
    KEVE_SSO_COOKIES: input.ssoCookiesJson || '[]',
    KEVE_IDENTITY_SSO_COOKIES: JSON.stringify(input.identitySsoCookies || {}),
    KEVE_LLM_BASE_URL: input.llm?.baseUrl || process.env.KEVE_LLM_BASE_URL || '',
    KEVE_LLM_MODEL_NAME: input.llm?.model || process.env.KEVE_LLM_MODEL_NAME || '',
    KEVE_LLM_API_KEY: input.llm?.apiKey || process.env.KEVE_LLM_API_KEY || '',
    KEVE_ENGINE: engine,
    // Cypress 预处理器位于 suite 静态配置目录，esbuild 需由 backend 提供
    KEVE_ESBUILD_MODULE: resolveEsbuildModule(backendRoot),
  };
}

export {
  deriveTargetUrl,
  isLocalPlaceholderUrl,
  rewriteOpenPageTargets,
};

/** 入口判定：node_modules 软链会让 argv[1] 与 import.meta.url 不是同一路径，需按真实路径比较。 */
function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(url.fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

if (isMainEntry()) {
  main().catch((err) => fail(err?.stack || err?.message || String(err)));
}
