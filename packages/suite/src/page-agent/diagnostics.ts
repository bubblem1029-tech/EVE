/**
 * diagnostics — 运行诊断的统一数据契约（引擎无关，零 Node 依赖）
 *
 * 为什么单独成模块：Playwright 与 Cypress 的采集手段不同（前者有原生
 * page 事件，后者只能主世界注入 + 快照），但报告里必须是同一份结构，
 * 否则「运行诊断」会出现两套字段语义。这里只放类型与纯函数，
 * 两端各自把自己的原始记录 normalize 成这里的输入即可。
 *
 * 约束：
 *   - 不保存完整请求/响应 Body，避免体积与隐私问题；
 *   - samples 限量并截断文本，防止诊断本身把报告撑爆；
 *   - 诊断只产出风险评估，不把 passed 用例自动降级为 failed。
 */

// ─── 契约 ────────────────────────────────────────────────────────────

export interface PerformanceDiagnostics {
  /** 用例总耗时（ms） */
  totalMs: number;
  /** AI 推理（LLM 调用）累计耗时（ms） */
  aiReasoningMs: number;
  /** 工具/操作执行累计耗时（ms） */
  actionMs: number;
  /** 非静态网络请求累计耗时（ms），无法采集时为 0 */
  networkMs: number;
  /** 耗时最长的单个操作 */
  slowestAction?: { name: string; durationMs: number };
  /** 页面级性能指标（Chrome 原生能力，Cypress 经主世界采集） */
  page?: PagePerformanceMetrics;
}

export interface PagePerformanceMetrics {
  /** DOMContentLoaded 耗时（ms，navigation timing） */
  domContentLoadedMs?: number;
  /** load 事件耗时（ms） */
  loadMs?: number;
  /** 最大内容绘制（ms） */
  lcpMs?: number;
  /** 长任务次数（>50ms） */
  longTaskCount?: number;
  /** 长任务累计阻塞时长（ms） */
  longTaskMs?: number;
  /** JS 堆已用内存（MB，非标准 API，Chrome 独有） */
  heapUsedMb?: number;
}

export interface AiUsageDiagnostics {
  /** LLM 调用次数 */
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中 prompt 缓存的 token 数（供应商上报时才有） */
  cachedTokens?: number;
  /** 推理模型消耗的 reasoning token（供应商上报时才有） */
  reasoningTokens?: number;
}

export interface NetworkSample {
  url: string;
  method?: string;
  /** HTTP 状态码；失败请求为 0，未拿到响应为 undefined/null */
  status?: number | null;
  durationMs?: number;
  error?: string;
  /** 采样时刻（epoch ms） */
  at?: number;
}

export interface NetworkDiagnostics {
  total: number;
  failed: number;
  http4xx: number;
  http5xx: number;
  slow: number;
  samples: NetworkSample[];
}

export interface BrowserSample {
  /** console 的 level；pageerror/exception 固定为 error */
  level: string;
  /** console | pageerror | exception */
  kind: 'console' | 'pageerror' | 'exception';
  text: string;
  at?: number;
}

export interface BrowserDiagnostics {
  consoleErrors: number;
  consoleWarnings: number;
  pageErrors: number;
  uncaughtExceptions: number;
  samples: BrowserSample[];
}

export interface QualityDiagnostics {
  /** 环境/软等待等重试次数 */
  retries: number;
  /** AI 自愈后恢复的次数 */
  recoveries: number;
  /** 连续重复动作次数（stuck/oscillation 信号） */
  repeatedActionCount: number;
  /** Agent 判 PASS 但确定性断言判 FAIL 的次数 */
  verdictConflict: boolean;
  /** 人可读的风险原因 */
  riskReasons: string[];
}

export interface RuntimeDiagnostics {
  performance: PerformanceDiagnostics;
  ai: AiUsageDiagnostics;
  network: NetworkDiagnostics;
  browser: BrowserDiagnostics;
  quality: QualityDiagnostics;
}

// ─── 常量 ────────────────────────────────────────────────────────────

export const DIAGNOSTICS_MAX_NETWORK_SAMPLES = 20;
export const DIAGNOSTICS_MAX_BROWSER_SAMPLES = 20;
export const DIAGNOSTICS_MAX_TEXT_LENGTH = 1000;
export const DIAGNOSTICS_SLOW_REQUEST_MS = 3000;

const STATIC_URL_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)(\?|$)/i;

/** 主世界诊断快照挂到 DOM 属性上的键名（isolated world 通过它读取） */
export const DIAGNOSTICS_DATASET_KEY = 'keveDiagnostics';
/** 主世界诊断快照自身的版本号，注入幂等依赖它 */
export const DIAGNOSTICS_SOURCE_VERSION = 'v1';

/** 静态资源不计入网络耗时与慢请求统计 */
export function isStaticUrl(url: string): boolean {
  return STATIC_URL_RE.test(String(url || ''));
}

/** 截断诊断文本，避免单条样本撑爆报告 */
export function clipDiagnosticText(text: unknown, max = DIAGNOSTICS_MAX_TEXT_LENGTH): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── 原始输入 ────────────────────────────────────────────────────────

export interface RawConsoleRecord {
  level: string;
  text: string;
  at?: number;
  kind?: 'console' | 'pageerror' | 'exception';
}

export interface RawNetworkRecord {
  url: string;
  method?: string;
  status?: number | null;
  durationMs?: number;
  error?: string;
  at?: number;
  isStatic?: boolean;
}

export interface RawActionRecord {
  name: string;
  durationMs?: number;
  error?: boolean;
}

export interface RawAiUsageRecord {
  llmCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export interface RuntimeDiagnosticsInput {
  totalMs?: number;
  aiReasoningMs?: number;
  actionMs?: number;
  actions?: RawActionRecord[];
  consoleRecords?: RawConsoleRecord[];
  networkRecords?: RawNetworkRecord[];
  retries?: number;
  recoveries?: number;
  repeatedActionCount?: number;
  verdictConflict?: boolean;
  extraRiskReasons?: string[];
  /** 页面级性能指标 */
  pageMetrics?: PagePerformanceMetrics;
  /** LLM token 用量（与耗时分离，单独成段） */
  aiUsage?: RawAiUsageRecord;
}

// ─── 构建 ────────────────────────────────────────────────────────────

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function normalizePageMetrics(input?: PagePerformanceMetrics): PagePerformanceMetrics | undefined {
  if (!input) return undefined;
  const page: PagePerformanceMetrics = {
    domContentLoadedMs: optionalNumber(input.domContentLoadedMs),
    loadMs: optionalNumber(input.loadMs),
    lcpMs: optionalNumber(input.lcpMs),
    longTaskCount: optionalNumber(input.longTaskCount),
    longTaskMs: optionalNumber(input.longTaskMs),
    heapUsedMb: optionalNumber(input.heapUsedMb),
  };
  return Object.values(page).some(v => v !== undefined) ? page : undefined;
}

function normalizeAiUsage(input?: RawAiUsageRecord): AiUsageDiagnostics {
  const promptTokens = safeNumber(input?.promptTokens, 0);
  const completionTokens = safeNumber(input?.completionTokens, 0);
  // total 缺失时用输入 + 输出兜底，避免供应商只回明细不回总量
  const totalTokens = input?.totalTokens !== undefined
    ? safeNumber(input.totalTokens, 0)
    : promptTokens + completionTokens;

  return {
    llmCalls: safeNumber(input?.llmCalls, 0),
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens: optionalNumber(input?.cachedTokens),
    reasoningTokens: optionalNumber(input?.reasoningTokens),
  };
}

function buildBrowserDiagnostics(records: RawConsoleRecord[]): BrowserDiagnostics {
  let consoleErrors = 0;
  let consoleWarnings = 0;
  let pageErrors = 0;
  let uncaughtExceptions = 0;
  const samples: BrowserSample[] = [];

  for (const record of records) {
    const kind = record.kind || 'console';
    const level = String(record.level || (kind === 'console' ? 'log' : 'error')).toLowerCase();
    if (kind === 'pageerror') pageErrors += 1;
    else if (kind === 'exception') uncaughtExceptions += 1;
    else if (level === 'error') consoleErrors += 1;
    else if (level === 'warning' || level === 'warn') consoleWarnings += 1;

    // 只保留 error/warning 级别或异常，避免占用采样额度
    const noteworthy = kind !== 'console' || level === 'error' || level === 'warning' || level === 'warn';
    if (!noteworthy) continue;
    if (samples.length >= DIAGNOSTICS_MAX_BROWSER_SAMPLES) continue;
    samples.push({
      level,
      kind,
      text: clipDiagnosticText(record.text),
      at: record.at,
    });
  }

  return { consoleErrors, consoleWarnings, pageErrors, uncaughtExceptions, samples };
}

function buildNetworkDiagnostics(records: RawNetworkRecord[]): { diagnostics: NetworkDiagnostics; networkMs: number } {
  let failed = 0;
  let http4xx = 0;
  let http5xx = 0;
  let slow = 0;
  let networkMs = 0;
  const samples: NetworkSample[] = [];

  for (const record of records) {
    const staticRes = record.isStatic ?? isStaticUrl(record.url);
    const status = record.status;
    const durationMs = safeNumber(record.durationMs, 0);
    if (!staticRes && durationMs > 0) networkMs += durationMs;

    const isFailed = !!record.error || status === 0;
    const is4xx = typeof status === 'number' && status >= 400 && status < 500;
    const is5xx = typeof status === 'number' && status >= 500;
    const isSlow = !staticRes && durationMs >= DIAGNOSTICS_SLOW_REQUEST_MS;

    if (isFailed) failed += 1;
    if (is4xx) http4xx += 1;
    if (is5xx) http5xx += 1;
    if (isSlow) slow += 1;

    // 采样优先级：失败 > 4xx/5xx > 慢请求
    const noteworthy = isFailed || is4xx || is5xx || isSlow;
    if (!noteworthy) continue;
    if (samples.length >= DIAGNOSTICS_MAX_NETWORK_SAMPLES) continue;
    samples.push({
      url: clipDiagnosticText(record.url, 500),
      method: record.method,
      status: status === undefined ? null : status,
      durationMs: durationMs || undefined,
      error: record.error ? clipDiagnosticText(record.error) : undefined,
      at: record.at,
    });
  }

  return {
    diagnostics: { total: records.length, failed, http4xx, http5xx, slow, samples },
    networkMs,
  };
}

function buildQualityDiagnostics(input: RuntimeDiagnosticsInput, browser: BrowserDiagnostics, network: NetworkDiagnostics): QualityDiagnostics {
  const retries = safeNumber(input.retries, 0);
  const recoveries = safeNumber(input.recoveries, 0);
  const repeatedActionCount = safeNumber(input.repeatedActionCount, 0);
  const verdictConflict = !!input.verdictConflict;

  const riskReasons: string[] = [];
  if (network.http5xx > 0) riskReasons.push(`存在 ${network.http5xx} 个 5xx 请求`);
  if (network.failed > 0) riskReasons.push(`存在 ${network.failed} 个失败请求`);
  if (network.slow > 0) riskReasons.push(`存在 ${network.slow} 个慢请求（≥${DIAGNOSTICS_SLOW_REQUEST_MS}ms）`);
  if (browser.pageErrors > 0) riskReasons.push(`发生 ${browser.pageErrors} 次页面未捕获异常`);
  if (browser.uncaughtExceptions > 0) riskReasons.push(`发生 ${browser.uncaughtExceptions} 次未捕获异常`);
  if (browser.consoleErrors > 0) riskReasons.push(`存在 ${browser.consoleErrors} 条 Console Error`);
  if (retries > 0) riskReasons.push(`发生 ${retries} 次重试`);
  if (repeatedActionCount > 0) riskReasons.push(`检测到 ${repeatedActionCount} 次重复动作`);
  if (verdictConflict) riskReasons.push('AI 结论与确定性断言冲突');
  const page = normalizePageMetrics(input.pageMetrics);
  if (page?.longTaskCount && page.longTaskCount > 0) {
    riskReasons.push(`存在 ${page.longTaskCount} 个长任务（累计 ${page.longTaskMs || 0}ms）`);
  }
  for (const reason of input.extraRiskReasons || []) {
    if (reason && !riskReasons.includes(reason)) riskReasons.push(reason);
  }

  return { retries, recoveries, repeatedActionCount, verdictConflict, riskReasons };
}

/** 把两端采集的原始记录归一成统一诊断结构 */
export function buildRuntimeDiagnostics(input: RuntimeDiagnosticsInput = {}): RuntimeDiagnostics {
  const actions = input.actions || [];
  const actionMs = input.actionMs !== undefined
    ? safeNumber(input.actionMs, 0)
    : actions.reduce((sum, a) => sum + safeNumber(a.durationMs, 0), 0);

  let slowestAction: { name: string; durationMs: number } | undefined;
  for (const action of actions) {
    const durationMs = safeNumber(action.durationMs, 0);
    if (durationMs <= 0) continue;
    if (!slowestAction || durationMs > slowestAction.durationMs) {
      slowestAction = { name: clipDiagnosticText(action.name, 120), durationMs };
    }
  }

  const browser = buildBrowserDiagnostics(input.consoleRecords || []);
  const { diagnostics: network, networkMs } = buildNetworkDiagnostics(input.networkRecords || []);
  const quality = buildQualityDiagnostics(input, browser, network);

  return {
    performance: {
      totalMs: safeNumber(input.totalMs, 0),
      aiReasoningMs: safeNumber(input.aiReasoningMs, 0),
      actionMs,
      networkMs,
      slowestAction,
      page: normalizePageMetrics(input.pageMetrics),
    },
    ai: normalizeAiUsage(input.aiUsage),
    network,
    browser,
    quality,
  };
}

/** 无采集数据时的空结构，保证前端字段恒存在 */
export function emptyRuntimeDiagnostics(): RuntimeDiagnostics {
  return buildRuntimeDiagnostics();
}

/**
 * 页面级性能探针源码（自包含，可直接丢给 Playwright `page.evaluate` 或
 * Cypress 主世界/隔离世界求值）。
 *
 * 说明：LCP / longtask 走 PerformanceEntry 查询而非常驻 PerformanceObserver，
 * 因此只能拿到「探针执行时刻已缓冲」的条目；Chromium 对这两类条目有缓冲，
 * 覆盖大多数场景，缺失时字段为 undefined，前端按「未采集」展示即可。
 */
export function pagePerformanceProbeSource(): string {
  return `(() => {
  "use strict";
  try {
    var out = {};
    var nav = (performance.getEntriesByType && performance.getEntriesByType("navigation") || [])[0];
    if (nav) {
      if (nav.domContentLoadedEventEnd) out.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd);
      if (nav.loadEventEnd) out.loadMs = Math.round(nav.loadEventEnd);
    }
    var lcp = 0;
    var paints = performance.getEntriesByType ? performance.getEntriesByType("largest-contentful-paint") : [];
    for (var i = 0; i < paints.length; i++) {
      var t = paints[i].startTime || paints[i].renderTime || 0;
      if (t > lcp) lcp = t;
    }
    if (lcp > 0) out.lcpMs = Math.round(lcp);
    var longTaskCount = 0;
    var longTaskMs = 0;
    var longs = performance.getEntriesByType ? performance.getEntriesByType("longtask") : [];
    for (var j = 0; j < longs.length; j++) {
      longTaskCount += 1;
      longTaskMs += Math.round(longs[j].duration || 0);
    }
    if (longTaskCount > 0) {
      out.longTaskCount = longTaskCount;
      out.longTaskMs = longTaskMs;
    }
    var mem = performance.memory;
    if (mem && mem.usedJSHeapSize) out.heapUsedMb = Math.round(mem.usedJSHeapSize / 1048576 * 10) / 10;
    return out;
  } catch (e) {
    return {};
  }
})()`;
}

/**
 * 合并多个 goal 的诊断（用例级 = 各步骤求和/去重后的聚合）。
 *
 * 注意不能从 samples 反推计数：samples 是截断后的异常样本，
 * total/failed/4xx/5xx/slow 必须直接对聚合字段求和，否则多步骤用例会少算。
 */
export function mergeRuntimeDiagnostics(items: Array<RuntimeDiagnostics | undefined | null>): RuntimeDiagnostics {
  const valid = items.filter(Boolean) as RuntimeDiagnostics[];
  if (!valid.length) return emptyRuntimeDiagnostics();

  const browserSamples: BrowserSample[] = [];
  const networkSamples: NetworkSample[] = [];
  const riskReasons: string[] = [];
  let totalMs = 0;
  let aiReasoningMs = 0;
  let actionMs = 0;
  let networkMs = 0;
  let slowestAction: { name: string; durationMs: number } | undefined;
  let consoleErrors = 0;
  let consoleWarnings = 0;
  let pageErrors = 0;
  let uncaughtExceptions = 0;
  let networkTotal = 0;
  let networkFailed = 0;
  let http4xx = 0;
  let http5xx = 0;
  let slow = 0;
  let retries = 0;
  let recoveries = 0;
  let repeatedActionCount = 0;
  let verdictConflict = false;
  let pageMetrics: PagePerformanceMetrics | undefined;
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;

  for (const item of valid) {
    totalMs += item.performance.totalMs;
    aiReasoningMs += item.performance.aiReasoningMs;
    actionMs += item.performance.actionMs;
    networkMs += item.performance.networkMs;
    if (item.performance.slowestAction
      && (!slowestAction || item.performance.slowestAction.durationMs > slowestAction.durationMs)) {
      slowestAction = item.performance.slowestAction;
    }
    if (item.performance.page) {
      const prev = pageMetrics || {};
      pageMetrics = {
        domContentLoadedMs: Math.max(prev.domContentLoadedMs || 0, item.performance.page.domContentLoadedMs || 0) || undefined,
        loadMs: Math.max(prev.loadMs || 0, item.performance.page.loadMs || 0) || undefined,
        lcpMs: Math.max(prev.lcpMs || 0, item.performance.page.lcpMs || 0) || undefined,
        longTaskCount: (prev.longTaskCount || 0) + (item.performance.page.longTaskCount || 0),
        longTaskMs: (prev.longTaskMs || 0) + (item.performance.page.longTaskMs || 0),
        heapUsedMb: Math.max(prev.heapUsedMb || 0, item.performance.page.heapUsedMb || 0) || undefined,
      };
    }

    const ai = normalizeAiUsage(item.ai);
    llmCalls += ai.llmCalls;
    promptTokens += ai.promptTokens;
    completionTokens += ai.completionTokens;
    totalTokens += ai.totalTokens;
    cachedTokens += ai.cachedTokens || 0;
    reasoningTokens += ai.reasoningTokens || 0;

    consoleErrors += item.browser.consoleErrors;
    consoleWarnings += item.browser.consoleWarnings;
    pageErrors += item.browser.pageErrors;
    uncaughtExceptions += item.browser.uncaughtExceptions;
    for (const sample of item.browser.samples) {
      if (browserSamples.length < DIAGNOSTICS_MAX_BROWSER_SAMPLES) browserSamples.push(sample);
    }

    networkTotal += item.network.total;
    networkFailed += item.network.failed;
    http4xx += item.network.http4xx;
    http5xx += item.network.http5xx;
    slow += item.network.slow;
    for (const sample of item.network.samples) {
      if (networkSamples.length < DIAGNOSTICS_MAX_NETWORK_SAMPLES) networkSamples.push(sample);
    }

    retries += item.quality.retries;
    recoveries += item.quality.recoveries;
    repeatedActionCount += item.quality.repeatedActionCount;
    verdictConflict = verdictConflict || item.quality.verdictConflict;
    for (const reason of item.quality.riskReasons) {
      if (!riskReasons.includes(reason)) riskReasons.push(reason);
    }
  }

  return {
    performance: { totalMs, aiReasoningMs, actionMs, networkMs, slowestAction, page: normalizePageMetrics(pageMetrics) },
    ai: {
      llmCalls,
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens: cachedTokens || undefined,
      reasoningTokens: reasoningTokens || undefined,
    },
    network: { total: networkTotal, failed: networkFailed, http4xx, http5xx, slow, samples: networkSamples },
    browser: { consoleErrors, consoleWarnings, pageErrors, uncaughtExceptions, samples: browserSamples },
    quality: { retries, recoveries, repeatedActionCount, verdictConflict, riskReasons },
  };
}
