/**
 * bridge — Cypress spec（浏览器） ↔ Node 的同步通道
 *
 * 为什么需要它：`cy.task` 在 `cy.then(async …)` 内只入队、立刻 resolve 成 undefined，
 * 不能作为「可 await 的 Node 往返」（探针 15/19 实测）。而截图对比、写文件、
 * 生成报告这些能力必须在 Node 侧执行。这里用 `setupNodeEvents` 起一个本地 HTTP
 * 服务，浏览器侧用 `fetch` 直接 await —— 这是唯一可靠的同步通道。
 *
 * 端口经 `config.env.KEVE_BRIDGE_PORT` 注入 spec，spec 内用
 * `Cypress.env('KEVE_BRIDGE_PORT')` 取。
 *
 * 报告一致性：本模块与 keve-report.ts 写同一份 confidence-data.jsonl 与
 * report-data.json，并且都调用 core/confidence.ts 的分类与
 * core/generateReport/reportData.ts 的汇总，保证 Cypress / Playwright 报告同构。
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { compareWithBaseline, createBaseline, ScreenshotDiffError } from '../core/judge/screenshotDiff.js';
import { buildConfidenceRecord, sanitizeRecord, type AttachmentLike } from '../core/judge/confidence.js';
import { generateReportData } from '../core/generateReport/reportData.js';

// ─── 报告落盘结构（与 Playwright JSON reporter 的 test-results.json 同构） ──

export interface CypressTestResultRecord {
  /** scene.title，形如 `S90061: 描述` */
  title: string;
  /** @keveModel 的 suite title，形如 `M_SG90061: 描述` */
  suiteTitle: string;
  /** spec 文件名（仅展示用） */
  file?: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut';
  duration: number;
  startTime: string;
  error?: string;
  /** 应用侧未捕获异常（仅供结果归因，报告 error 已包含合并文本） */
  uncaughtErrors?: string[];
  /** 用例执行日志（对齐 Playwright test-results.json 的 results[].stdout） */
  logs?: string[];
  attachments: AttachmentLike[];
}

interface BridgeState {
  resultDir: string;
  confidencePath: string;
  taskDir: string;
  results: CypressTestResultRecord[];
}

function resultDirOf(): string {
  // 优先使用 runner 注入的报告目录；缺失时回退旧布局，兼容历史执行环境。
  if (process.env.KEVE_RESULT_DIR) return path.resolve(process.env.KEVE_RESULT_DIR);
  const taskDir = process.env.KEVE_TASK_DIR || '.keve';
  const round = process.env.KEVE_ROUND || 'latest';
  return path.resolve(taskDir, 'test-artifacts', `round-${round}`);
}

function taskDirOf(): string {
  return path.resolve(process.env.KEVE_TASK_DIR || '.keve');
}

function decodeBase64(data: string): Buffer {
  return Buffer.from(String(data || ''), 'base64');
}

/** 解码 Cypress attachment 的 JSON body（浏览器侧以 base64 发送） */
function parseJsonAttachmentBody(body: any): any | null {
  if (!body) return null;
  let text = '';
  try {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
    text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

/** 按 goal 顺序匹配该用例已落盘截图（文件名形如 goal-before-0-<step>-<ts>.png） */
function findScreenshotByOrder(dir: string, prefix: string, order: number): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir);
  const marker = `${prefix}-${order}-`;
  return files.find((f) => f.startsWith(marker) && f.endsWith('.png'));
}

/**
 * 失败中断时现场兜底：keveGoal 可能还没写 attachment 就被 Cypress 中断，
 * 但 goal-before / fn-after 截图已经落盘。这里按截图文件名与用例日志补回
 * keveGoalResult，让 reportData 至少能还原步骤、执行前/后截图。
 */
function restoreInterruptedScreenshots(
  incoming: CypressTestResultRecord,
  state: BridgeState,
): void {
  const attachments = incoming.attachments || [];
  const screenshotsDir = screenshotsDirOf(state);
  if (!fs.existsSync(screenshotsDir)) return;

  // 从日志提取被中断的 step 文案（Cypress keveGoal 固定输出格式）
  const parseStepFromLogs = (): string => {
    for (const line of incoming.logs || []) {
      const m = String(line).match(/\[keveGoal\]\s+"([^"]+)"/);
      if (m?.[1]) return m[1];
    }
    return '';
  };

  const goalAttachments = attachments.filter((a) => a.name === 'keveGoalResult');
  const goals = goalAttachments
    .map((a) => parseJsonAttachmentBody(a.body))
    .filter((b) => b && b.order !== undefined);

  for (const goal of goals) {
    const order = Number(goal.order);
    if (!goal.goalScreenshotBefore) {
      const shot = findScreenshotByOrder(screenshotsDir, 'goal-before', order);
      if (shot) goal.goalScreenshotBefore = path.relative(state.taskDir, path.join(screenshotsDir, shot));
    }
    if (!goal.goalScreenshotAfter) {
      const shot = findScreenshotByOrder(screenshotsDir, 'goal-after-fn', order);
      if (shot) goal.goalScreenshotAfter = path.relative(state.taskDir, path.join(screenshotsDir, shot));
    }
    if (!goal.agentScreenshots?.length && goal.goalScreenshotAfter) {
      goal.agentScreenshots = [goal.goalScreenshotAfter];
    }
    const att = goalAttachments[goals.indexOf(goal)];
    if (att && att.body) {
      att.body = Buffer.from(JSON.stringify(goal)).toString('base64');
    }
  }

  // 连 attachment 都没写到：按顺序 0 的截图重建一条失败 goal
  if (goals.length === 0) {
    const step = parseStepFromLogs() || '打开页面';
    const before = findScreenshotByOrder(screenshotsDir, 'goal-before', 0);
    const after = findScreenshotByOrder(screenshotsDir, 'goal-after-fn', 0);
    if (!before && !after) return;
    const beforePath = before ? path.relative(state.taskDir, path.join(screenshotsDir, before)) : undefined;
    const afterPath = after ? path.relative(state.taskDir, path.join(screenshotsDir, after)) : undefined;
    attachments.push({
      name: 'keveGoalResult',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({
        step,
        expected: '操作完成，页面正常响应',
        order: 0,
        success: false,
        conclusion: 'fail',
        actions: [],
        goalScreenshotBefore: beforePath,
        goalScreenshotAfter: afterPath,
        agentScreenshots: afterPath ? [afterPath] : [],
      })).toString('base64'),
    });
  }
}

/** 截图落盘目录（与 Playwright 侧同一轮次的 screenshots 目录一致） */
function screenshotsDirOf(state: BridgeState): string {
  return path.join(state.resultDir, 'screenshots');
}

/** 报告轮次根目录：新布局为 <taskRoot>/reports，旧布局为 <taskDir>/test-artifacts */
function reportsRootOf(resultDir: string): string {
  return path.dirname(resultDir);
}

function safeFileSegment(text: string): string {
  // 保留连字符：keveGoal 传入的 name 形如 goal-before-0-step，
  // 连字符属于模板分隔符，需与 Playwright captureScreenshot 的文件名同形。
  return String(text || 'shot').replace(/[^a-zA-Z0-9一-鿿-]/g, '_').slice(0, 60);
}

/** 把收集到的 Cypress 结果写成 Playwright 同构的 test-results.json */
function writeTestResults(state: BridgeState): string {
  // 结构对齐 Playwright JSON reporter：顶层 suite = spec 文件，二级 suite = @keveModel
  // 的 `M_…` describe。reportData.buildCaseResultMap 从 suitePath 的末段取模块名，
  // 之前这里是扁平结构（顶层 title 为空、specs 直接挂上），模块名会退化成 'default'。
  const byFile = new Map<string, Map<string, CypressTestResultRecord[]>>();
  for (const r of state.results) {
    const file = r.file || '';
    if (!byFile.has(file)) byFile.set(file, new Map());
    const bySuite = byFile.get(file)!;
    if (!bySuite.has(r.suiteTitle)) bySuite.set(r.suiteTitle, []);
    bySuite.get(r.suiteTitle)!.push(r);
  }

  const toSpec = (r: CypressTestResultRecord) => ({
    title: r.title,
    file: r.file || '',
    column: 0,
    line: 0,
    tests: [{
      timeout: 0,
      annotations: [],
      expectedStatus: 'passed',
      projectId: '',
      projectName: '',
      results: [{
        workerIndex: 0,
        status: r.status,
        duration: r.duration,
        startTime: r.startTime,
        errors: r.error ? [{ message: r.error }] : [],
        error: r.error ? { message: r.error } : undefined,
        // Playwright JSON reporter 的 stdout 是 [{ text }] 数组，reportData 再拼成字符串
        stdout: (r.logs || []).map((text) => ({ text })),
        stderr: [],
        attachments: r.attachments,
        steps: [],
      }],
      status: r.status,
    }],
    ok: r.status === 'passed',
  });

  const suites = [...byFile.entries()].map(([file, bySuite]) => ({
    title: file ? path.basename(file) : '',
    file,
    column: 0,
    line: 0,
    specs: [],
    suites: [...bySuite.entries()].map(([suiteTitle, records]) => ({
      title: suiteTitle,
      file,
      column: 0,
      line: 0,
      specs: records.map(toSpec),
    })),
  }));

  const out = {
    config: {
      rootDir: taskDirOf(),
      version: 'cypress-engine',
      metadata: { engine: 'cypress' },
      projects: [],
      reporter: [['json', { outputFile: path.join(state.resultDir, 'test-results.json') }]],
    },
    suites,
    errors: [],
    stats: {
      startTime: new Date().toISOString(),
      duration: state.results.reduce((a, r) => a + (r.duration || 0), 0),
      expected: state.results.length,
      skipped: state.results.filter((r) => r.status === 'skipped').length,
      unexpected: state.results.filter((r) => r.status === 'failed' || r.status === 'timedOut').length,
      flaky: 0,
    },
  };

  const target = path.join(state.resultDir, 'test-results.json');
  fs.mkdirSync(state.resultDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(out, null, 2));
  return target;
}

/**
 * 起桥 + 注册 Cypress task。
 * 返回补好 `config.env.KEVE_BRIDGE_PORT` 的 config（Cypress 要求 return config）。
 */
export async function setupKeveBridge(on: any, config: any): Promise<any> {
  const state: BridgeState = {
    resultDir: resultDirOf(),
    confidencePath: path.join(resultDirOf(), 'confidence-data.jsonl'),
    taskDir: taskDirOf(),
    results: [],
  };
  fs.mkdirSync(state.resultDir, { recursive: true });

  /** 写 test-results.json → report-data.json（/report/finalize 与 after:run 共用） */
  const finalize = async (): Promise<any> => {
    const resultsPath = writeTestResults(state);
    const casesYaml = path.join(state.taskDir, 'cases', 'test-cases.yaml');
    const reportData = await generateReportData({
      projectRoot: state.taskDir,
      resultsPath,
      confidencePath: state.confidencePath,
      casesPath: fs.existsSync(casesYaml) ? casesYaml : undefined,
    });
    const reportDataPath = path.join(state.resultDir, 'report-data.json');
    fs.writeFileSync(reportDataPath, JSON.stringify(reportData, null, 2));

    // latest 软链（与 keve-report.onEnd 一致）
    const latestDir = path.join(reportsRootOf(state.resultDir), 'latest');
    if (path.resolve(latestDir) !== path.resolve(state.resultDir)) {
      try {
        if (fs.existsSync(latestDir)) {
          const stat = fs.lstatSync(latestDir);
          if (stat.isSymbolicLink()) fs.unlinkSync(latestDir);
          else fs.rmSync(latestDir, { recursive: true, force: true });
        }
        fs.symlinkSync(path.basename(state.resultDir), latestDir, 'junction');
      } catch { /* 软链失败不影响报告生成 */ }
    }
    return { ok: true, resultsPath, reportDataPath, cases: reportData?.summary?.total ?? undefined };
  };

  const handle = async (route: string, payload: any): Promise<any> => {
    switch (route) {
      case '/echo':
        return { ok: true, echoed: payload, at: Date.now() };

      case '/fs/mkdir': {
        fs.mkdirSync(String(payload.dir), { recursive: true });
        return { ok: true };
      }

      case '/fs/write': {
        const file = String(payload.file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const data = payload.base64 ? decodeBase64(payload.data) : String(payload.data ?? '');
        if (payload.append) fs.appendFileSync(file, data);
        else fs.writeFileSync(file, data);
        return { ok: true, file, bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data) };
      }

      case '/fs/read': {
        const file = String(payload.file);
        if (!fs.existsSync(file)) return { ok: false, error: `ENOENT: ${file}` };
        return { ok: true, data: fs.readFileSync(file, 'utf8') };
      }

      /** 读取二进制文件（Agent 初始多模态截图）：返回 base64，不落任何临时文件 */
      case '/fs/read-binary': {
        const file = String(payload.file);
        if (!fs.existsSync(file)) return { ok: false, error: `ENOENT: ${file}` };
        return { ok: true, base64: fs.readFileSync(file).toString('base64') };
      }

      /**
       * LLM 转发：浏览器侧的 Agent 循环通过此路由调 OpenAI 兼容接口。
       *
       * apiKey 只留在 Node 侧（payload 里不带 key，返回体原样透传），Cypress spec
       * 因此不需要把密钥注入浏览器。`url` 必须是 http(s) 绝对地址。
       */
      case '/llm/chat': {
        const url = String(payload.url || '');
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, code: 'BAD_URL', error: `llm/chat: url 非法: ${JSON.stringify(url)}` };
        }
        try {
          // apiKey 只留在 Node 侧：浏览器侧不带 Authorization，由这里按环境变量补齐。
          const reqHeaders: Record<string, string> = { ...((payload.headers || {}) as Record<string, string>) };
          const hasAuth = Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'authorization');
          const apiKey = process.env.KEVE_LLM_API_KEY || process.env.LLM_API_KEY || '';
          if (!hasAuth && apiKey) reqHeaders.Authorization = `Bearer ${apiKey}`;
          const resp = await fetch(url, {
            method: String(payload.method || 'POST'),
            headers: reqHeaders,
            body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body ?? {}),
          });
          const body = await resp.text();
          const headers: Record<string, string> = {};
          resp.headers.forEach((v, k) => { headers[k] = v; });
          return { ok: true, status: resp.status, statusText: resp.statusText, headers, body };
        } catch (err: any) {
          return { ok: false, code: 'LLM_FETCH_ERROR', error: err?.message || String(err) };
        }
      }

      /** 浏览器侧截图落盘：返回相对 taskDir 的路径（与 Playwright 侧 captureScreenshot 同形） */
      case '/shot/save': {
        const dir = screenshotsDirOf(state);
        fs.mkdirSync(dir, { recursive: true });
        const name = `${safeFileSegment(payload.name)}-${Date.now()}.png`;
        const file = path.join(dir, name);
        fs.writeFileSync(file, decodeBase64(payload.pngBase64));
        return { ok: true, path: path.relative(state.taskDir, file) };
      }

      // 截图基线：语义与 PlaywrightEngine.expectScreenshot 完全一致
      case '/shot/compare': {
        const png = decodeBase64(payload.pngBase64);
        try {
          const result = payload.create
            ? createBaseline(String(payload.key), png, { threshold: payload.threshold, sourceUrl: payload.sourceUrl })
            : compareWithBaseline(String(payload.key), png, { threshold: payload.threshold, mask: payload.mask });
          return { ok: true, result };
        } catch (err: any) {
          if (err instanceof ScreenshotDiffError) {
            return { ok: false, code: 'SHOT_DIFF_EXCEEDED', error: err.message, shotDiff: err.shotDiff };
          }
          return { ok: false, code: 'SHOT_DIFF_ERROR', error: err?.message || String(err) };
        }
      }

      // 记录一条 confidence 记录（分类逻辑与 Playwright Reporter 同源）
      case '/report/record': {
        const { record, log } = buildConfidenceRecord({
          title: String(payload.title),
          status: String(payload.status),
          error: payload.error || null,
          steps: payload.steps || [],
          attachments: payload.attachments || [],
        });
        fs.appendFileSync(state.confidencePath, JSON.stringify(sanitizeRecord(record)) + '\n');
        return { ok: true, record, log };
      }

      // 记录一条测试结果（与 Playwright JSON reporter 的字段对齐）
      case '/report/result': {
        const incoming = payload as CypressTestResultRecord;
        state.results = state.results.filter((r) => r.title !== incoming.title);
        state.results.push(incoming);
        return { ok: true, count: state.results.length };
      }

      /**
       * 一条用例收口：同时写 confidence-data.jsonl 与 test-results 记录。
       * 浏览器侧只发一次请求，避免「分类逻辑两端各写一份」。
       */
      case '/report/test': {
        const incoming = payload as CypressTestResultRecord;
        restoreInterruptedScreenshots(incoming, state);
        const { record, log } = buildConfidenceRecord({
          title: incoming.title,
          status: incoming.status,
          error: incoming.error ? { message: incoming.error } : null,
          steps: [],
          attachments: incoming.attachments || [],
        });
        fs.appendFileSync(state.confidencePath, JSON.stringify(sanitizeRecord(record)) + '\n');
        state.results = state.results.filter((r) => r.title !== incoming.title);
        state.results.push(incoming);
        return { ok: true, count: state.results.length, log };
      }

      // 写 test-results.json → 生成 report-data.json（与 keve-report.onEnd 同路径）
      case '/report/finalize':
        return await finalize();

      default:
        return { ok: false, error: `unknown route ${route}` };
    }
  };

  const server = http.createServer((req, res) => {
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    /**
     * 浏览器侧的 fetch 是跨域请求（spec/runner 与桥不同源），每个 POST 前都会先发
     * OPTIONS 预检。若不在此短路，预检的空 body 会被当成一次真实调用落进
     * `/report/test` —— 报告里会凭空多出一条无标题的空用例（已实测）。
     */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const route = String(req.url || '').split('?')[0];
      let payload: any = {};
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        payload = raw ? JSON.parse(raw) : {};
      } catch { payload = {}; }
      let out: any;
      try {
        out = await handle(route, payload);
      } catch (err: any) {
        out = { ok: false, error: err?.message || String(err) };
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        ...corsHeaders,
      });
      res.end(JSON.stringify(out));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as any)?.port;
  /**
   * 浏览器侧要从 `Cypress.env()` 读到的运行时配置。
   *
   * LLM 的 baseURL/model 与目标 URL 属于非敏感值；API key 绝不下发浏览器 ——
   * `/llm/chat` 在 Node 侧按环境变量补齐 Authorization。
   *
   * SSO cookies 必须下发：Playwright 由 global-setup 直接读 process.env 写
   * storageState，而 Cypress 没有 storageState，只能在 host.ts 里通过
   * `cy.env('KEVE_SSO_COOKIES')` 取到后再用 CDP 注入。只放进 process.env
   * 而不放进 config.env，浏览器侧读不到，用例会直接掉进 SSO 登录页。
   */
  const browserEnv: Record<string, string> = {};
  for (const name of [
    'KEVE_TARGET_URL',
    'KEVE_LLM_BASE_URL',
    'KEVE_LLM_MODEL_NAME',
    'KEVE_LLM_MODEL',
    // 登录态必须下发给浏览器侧：Cypress 无法像 Playwright 那样读 storageState，
    // host.ts 依赖 cy.env('KEVE_SSO_COOKIES') 通过 CDP 注入 cookie。
    // 仅在 process.env 里存在而不放进 config.env，浏览器侧读不到 → 用例必然掉进 SSO 登录页。
    'KEVE_SSO_COOKIES',
    'KEVE_IDENTITY_SSO_COOKIES',
  ]) {
    const value = process.env[name];
    if (value) browserEnv[name] = value;
  }
  /**
   * 调用方（eve-llm 的 Cypress 执行器）经 KEVE_CONFIG_ENV 传入敏感/动态配置
   * （如服务端解析好的 SSO cookies）。不写进 config.mjs 源码，避免 cookie 落盘。
   */
  let injectedEnv: Record<string, string> = {};
  const injectedRaw = process.env.KEVE_CONFIG_ENV;
  if (injectedRaw) {
    try {
      const parsed = JSON.parse(injectedRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        injectedEnv = parsed as Record<string, string>;
      }
    } catch {
      console.warn('[keve-bridge] KEVE_CONFIG_ENV 解析失败，忽略注入配置');
    }
  }
  config.env = { ...(config.env || {}), ...browserEnv, ...injectedEnv, KEVE_BRIDGE_PORT: port };
  console.log(`[keve-bridge] listening on 127.0.0.1:${port} → ${state.resultDir}`);

  // 报告收口放在 after:run：此时所有 spec 的 /report/test 都已落盘，
  // 且不依赖任何场景级的 afterAll（硬失败/中断也能出报告）。
  on('after:run', async () => {
    try {
      const out = await finalize();
      console.log(`[keve-bridge] report-data.json → ${out.reportDataPath}（用例 ${out.cases ?? 0}）`);
    } catch (err: any) {
      console.error(`[keve-bridge] 报告生成失败：${err?.message || err}`);
    }
    try { server.close(); } catch { /* noop */ }
  });

  /**
   * 视频上报：Cypress 的 `results.video` 是 spec 级（整段录制），
   * 但报告按用例聚合，需要把同一 spec 的视频挂到该 spec 的每条结果上，
   * 才能让 reportData 的 `videoPath` 与 Playwright 的 per-test 视频等价。
   *
   * after:spec 早于 after:run 触发，此时 results 已由浏览器侧 /report/test 落盘。
   */
  on('after:spec', async (_spec: any, results: any) => {
    const video = results?.video;
    if (video && fs.existsSync(video)) {
      // 相对 taskDir，与 Playwright 侧 videoPath 的语义一致
      const rel = path.relative(state.taskDir, video);
      const specFile = String(results?.spec?.relative || '');
      const titles = new Set<string>(
        (results?.tests || [])
          .map((t: any) => (Array.isArray(t?.title) ? t.title[t.title.length - 1] : t?.title))
          .filter(Boolean)
          .map((t: any) => String(t)),
      );
      // 先按 spec 文件收窄，再按标题匹配；标题对不上时退化为该 spec 的全部用例
      const byFile = state.results.filter((r) => !specFile || !r.file || r.file === specFile);
      const targets = byFile.filter((r) => titles.size === 0 || titles.has(r.title));
      const finalTargets = targets.length > 0 ? targets : byFile;
      for (const record of finalTargets) {
        const attachments = (record.attachments || []).filter((a) => a.name !== 'video');
        attachments.push({ name: 'video', contentType: 'video/mp4', path: rel });
        record.attachments = attachments;
      }
      console.log(`[keve-bridge] video attachment → ${rel}（用例 ${finalTargets.length}）`);
    }
    // Cypress 在 after:spec 后还会压缩视频，而压缩期间若宿主进程重启，
    // after:run 的最终报告落盘会被打断。这里先出一版 report-data.json，
    // 确保测试结果不会丢；after:run 仍会基于完整结果再收口一次。
    try {
      const out = await finalize();
      console.log(`[keve-bridge] report-data.json checkpoint → ${out.reportDataPath}（用例 ${out.cases ?? 0}）`);
    } catch (err: any) {
      console.warn(`[keve-bridge] 报告检查点生成失败：${err?.message || err}`);
    }
  });
  // Cypress 偶发不触发 after:run（硬失败/中断）——兜底退出时关闭
  process.once('exit', () => {
    try { finalize(); } catch { /* 同步兜底，失败不阻塞退出 */ }
    try { server.close(); } catch { /* noop */ }
  });

  return config;
}

export default setupKeveBridge;
