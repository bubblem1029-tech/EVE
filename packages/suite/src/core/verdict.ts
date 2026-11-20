/**
 * verdict — 双引擎统一的结论与归因模型
 *
 * 所有引擎原始错误、Agent 结论和断言结果最终都收敛到这里的 verdict + reasonCode。
 * 规则：blocked 必须携带可行动的原因，禁止 `reasonCode=unknown`。
 */

export type Verdict = 'pass' | 'fail' | 'blocked' | 'skipped';

export type ReasonCode =
  | 'product_assert_failed'
  | 'product_state_changed'
  | 'product_app_error'
  | 'script_target_missing'
  | 'script_selector_invalid'
  | 'script_evidence_missing'
  | 'infra_llm_429'
  | 'infra_llm_timeout'
  | 'infra_llm_tool_error'
  | 'infra_engine_init_failed'
  | 'infra_engine_browser_crashed'
  | 'infra_blocked_not_dispatched'
  | 'env_sso_blocked'
  | 'env_network_unreachable'
  | 'unsupported_engine_capability';

export interface NormalizedVerdict {
  verdict: Verdict;
  reasonCode?: ReasonCode;
  rawStatus: string;
  rawCategory?: string;
  message: string;
}

export interface NormalizeVerdictInput {
  status: string;
  errorCategory?: string;
  error?: string | { message?: string; name?: string } | null;
  agentConclusion?: 'pass' | 'fail' | 'blocked' | 'incomplete';
  diagnosticHint?: string;
  data?: string;
}

const RATE_LIMIT_RE = /\b429\b|rate[\s_-]*limit|too many requests|quota exceeded|限流/i;
const CYPRESS_INIT_RE = /cypress.*(?:verify|binary|launch|init|start|version)|(?:binary|executable).*cypress|no version|browser.*(?:not found|missing)/i;
const BROWSER_CRASH_RE = /browser.*(?:crash|closed|disconnected)|target closed|page crashed|chromium.*exited/i;
const SSO_RE = /sso|single sign|unauthori[sz]ed|forbidden|\b401\b|\b403\b|登录|鉴权|无权限|redirect.*login/i;
const NETWORK_RE = /ECONN|ENOTFOUND|ETIMEDOUT|socket hang up|net::|ERR_(?:NAME|CONNECTION|INTERNET)|network (?:error|unreachable)|dns/i;
const AGENT_TIMEOUT_RE = /Re-Act loop did not achieve|Expected not achieved after agent explore|agent.*(?:timeout|timed out)|model.*timed out/i;
const TARGET_RE = /locator.*(?:not found|resolved to)|element.*(?:not found|missing)|selector.*(?:invalid|not found)|strict mode violation|no element|元素.*(?:未找到|缺失)/i;
const EVIDENCE_RE = /evidence.*missing|missing evidence|截图.*缺失|缺少.*截图|未采集.*证据|no screenshot/i;
const ASSERT_RE = /expect\(|AssertionError|断言失败|实际显示|页面实际|text mismatch|视觉断言失败/i;
/** 应用侧运行时异常：页面自身 JS 崩溃，不是网络/环境问题 */
export const APP_ERROR_RE = /TypeError|ReferenceError|SyntaxError|RangeError|is not a function|Cannot read propert|Cannot set propert|undefined is not|null is not|未捕获异常|uncaught exception|page crashed/i;

/** 供 confidence 层从运行诊断里识别页面 JS 异常 */
export function looksLikeAppError(text: string): boolean {
  return APP_ERROR_RE.test(String(text || ''));
}

function messageOf(input: NormalizeVerdictInput): string {
  if (typeof input.error === 'string') return input.error;
  return String(input.error?.message || input.diagnosticHint || '');
}

function detectReasonCode(text: string): ReasonCode | undefined {
  if (!text) return undefined;
  if (RATE_LIMIT_RE.test(text)) return 'infra_llm_429';
  if (CYPRESS_INIT_RE.test(text)) return 'infra_engine_init_failed';
  if (BROWSER_CRASH_RE.test(text)) return 'infra_engine_browser_crashed';
  if (SSO_RE.test(text)) return 'env_sso_blocked';
  // 注意：应用侧异常只在 env/unknown 分类下生效。script 分类里的 TypeError
  // 是「脚本自身写错了」，不能被误判成产品缺陷（见 reasonForCategory）。
  if (NETWORK_RE.test(text)) return 'env_network_unreachable';
  if (AGENT_TIMEOUT_RE.test(text)) return 'infra_llm_timeout';
  if (TARGET_RE.test(text)) return 'script_target_missing';
  if (EVIDENCE_RE.test(text)) return 'script_evidence_missing';
  if (ASSERT_RE.test(text)) return 'product_assert_failed';
  return undefined;
}

function reasonForCategory(category: string, text: string): ReasonCode {
  const detected = detectReasonCode(text);
  if (detected) return detected;
  // 应用侧 JS 异常只在 env/unknown 分类下兜底：网络/SSO/引擎等更具体的原因
  // 已经在 detectReasonCode 里优先命中。
  if ((category === 'env' || category === 'unknown') && APP_ERROR_RE.test(text)) {
    return 'product_app_error';
  }
  switch (category) {
    case 'script':
      return 'script_selector_invalid';
    case 'env':
      return 'env_network_unreachable';
    case 'visual':
    case 'assert':
      return 'product_assert_failed';
    case 'text-mismatch':
      return 'product_state_changed';
    case 'incomplete':
      return 'infra_llm_timeout';
    default:
      return 'script_evidence_missing';
  }
}

/**
 * 把现有 confidence 分类 + Agent 结论映射为统一 verdict。
 *
 * 兼容旧 `data=通过/不通过/阻塞/跳过`：在没有新 status 的调用方里仍能得出稳定结论。
 */
export function normalizeVerdict(input: NormalizeVerdictInput): NormalizedVerdict {
  const rawStatus = String(input.status || 'unknown');
  const rawCategory = String(input.errorCategory || '').trim() || undefined;
  const message = messageOf(input);

  if (rawStatus === 'skipped' || input.data === '跳过') {
    return { verdict: 'skipped', rawStatus, rawCategory, message };
  }

  // 显式阻塞优先于 errorCategory=pass：Agent 声称 pass 但缺证据时，
  // confidence 层会把 data 改成「阻塞」，不能在这里被类别覆盖。
  if (input.data === '阻塞') {
    return {
      verdict: 'blocked',
      reasonCode: reasonForCategory(rawCategory || 'unknown', message),
      rawStatus,
      rawCategory,
      message,
    };
  }

  if (input.data === '不通过') {
    return {
      verdict: 'fail',
      reasonCode: reasonForCategory(rawCategory || 'assert', message),
      rawStatus,
      rawCategory,
      message,
    };
  }

  if (rawStatus === 'passed' || input.data?.startsWith('通过')) {
    return { verdict: 'pass', rawStatus, rawCategory, message };
  }

  if (rawCategory === 'assert' || rawCategory === 'visual' || rawCategory === 'text-mismatch') {
    return {
      verdict: 'fail',
      reasonCode: reasonForCategory(rawCategory, message),
      rawStatus,
      rawCategory,
      message,
    };
  }

  if (input.agentConclusion === 'pass' && rawStatus === 'failed') {
    // 仅当 confidence 已给出“通过（AI复核）”时才保留通过；缺证据时按 script 阻塞。
    return {
      verdict: 'blocked',
      reasonCode: 'script_evidence_missing',
      rawStatus,
      rawCategory,
      message,
    };
  }

  if (input.agentConclusion === 'blocked') {
    return {
      verdict: 'blocked',
      reasonCode: reasonForCategory(rawCategory || 'env', message),
      rawStatus,
      rawCategory,
      message,
    };
  }

  if (rawCategory === 'script') {
    return {
      verdict: 'blocked',
      reasonCode: reasonForCategory('script', message),
      rawStatus,
      rawCategory,
      message,
    };
  }

  if (rawCategory === 'env' || rawCategory === 'incomplete' || rawCategory === 'unknown') {
    return {
      verdict: 'blocked',
      reasonCode: reasonForCategory(rawCategory || 'unknown', message),
      rawStatus,
      rawCategory,
      message,
    };
  }

  const fallback = detectReasonCode(message) || (input.data === '不通过' ? 'product_assert_failed' : 'script_evidence_missing');
  return {
    verdict: fallback === 'product_assert_failed' ? 'fail' : 'blocked',
    reasonCode: fallback,
    rawStatus,
    rawCategory,
    message,
  };
}

/** 供失败重跑策略使用：只有基础设施阻塞才允许自动重跑。 */
export function isInfraReason(reasonCode?: ReasonCode): boolean {
  return Boolean(
    reasonCode
    && (reasonCode.startsWith('infra_')
      || reasonCode === 'env_sso_blocked'
      || reasonCode === 'env_network_unreachable'),
  );
}
