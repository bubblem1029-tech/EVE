/**
 * stabilizePage — 页面稳定化（STABILIZE_PAGE）的受控实现。
 *
 * 用例只保存结构化配置，不保存任意 JS；真正执行时由本模块生成固定脚本，
 * 通过 `engine.evaluate()` 在页面上下文运行。这样既能覆盖 DOM 降噪，也能
 * 把「改了什么」结构化地写入报告与基线配置 hash。
 */

export interface StabilizeReplaceRule {
  selector: string;
  text: string;
  required?: boolean;
}

export interface StabilizePageOptions {
  /** 预留：引用受控降噪方案；当前版本只支持内联配置。 */
  profileId?: string;
  replace?: StabilizeReplaceRule[];
  hide?: string[];
  cover?: string[];
  freezeAnimation?: boolean;
  stopTransition?: boolean;
  timeoutMs?: number;
  strict?: boolean;
}

export interface StabilizePageResult {
  profileId: string;
  replaced: number;
  hidden: number;
  covered: number;
  missingSelectors: string[];
  configHash: string;
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 800;
const MAX_TIMEOUT_MS = 5000;

function normalizeSelectorList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function normalizeReplaceRules(input: unknown): StabilizeReplaceRule[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item: any) => ({
      selector: String(item?.selector ?? '').trim(),
      text: String(item?.text ?? ''),
      required: item?.required === true,
    }))
    .filter((item) => !!item.selector);
}

/** 把前端/DSL 的多种形态归一成稳定配置。 */
export function normalizeStabilizePageOptions(input: unknown): StabilizePageOptions {
  const raw: any = (() => {
    if (!input) return {};
    if (typeof input === 'string') {
      try {
        return JSON.parse(input);
      } catch {
        return {};
      }
    }
    if (typeof input === 'object' && !Array.isArray(input)) {
      const value = (input as any).value;
      if (value && typeof value === 'object') return value;
      return input;
    }
    return {};
  })();

  const timeout = Number(raw?.timeoutMs);
  return {
    profileId: String(raw?.profileId ?? '').trim(),
    replace: normalizeReplaceRules(raw?.replace),
    hide: normalizeSelectorList(raw?.hide),
    cover: normalizeSelectorList(raw?.cover),
    freezeAnimation: raw?.freezeAnimation !== false,
    stopTransition: raw?.stopTransition !== false,
    timeoutMs: Number.isFinite(timeout)
      ? Math.max(100, Math.min(MAX_TIMEOUT_MS, timeout))
      : DEFAULT_TIMEOUT_MS,
    strict: raw?.strict === true,
  };
}

/**
 * 浏览器上下文执行体。必须保持无外部依赖，因为会通过 Function#toString
 * 注入到 page.evaluate。
 */
function applyStabilizePageInBrowser(config: any): Promise<any> {
  const startedAt = Date.now();
  const options = config || {};
  const replacedRules = Array.isArray(options.replace) ? options.replace : [];
  const hideSelectors = Array.isArray(options.hide) ? options.hide : [];
  const coverSelectors = Array.isArray(options.cover) ? options.cover : [];
  const missingSelectors: string[] = [];
  let replaced = 0;
  let hidden = 0;
  let covered = 0;

  function query(selector: string): Element[] {
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (!nodes.length) {
        if (missingSelectors.indexOf(selector) === -1) missingSelectors.push(selector);
      }
      return nodes;
    } catch (error) {
      if (missingSelectors.indexOf(selector) === -1) missingSelectors.push(selector);
      return [];
    }
  }

  if (options.freezeAnimation !== false || options.stopTransition !== false) {
    const styleId = '__keve_stabilize_style__';
    const old = document.getElementById(styleId);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const style = document.createElement('style');
    style.id = styleId;
    const rules: string[] = [];
    if (options.freezeAnimation !== false) {
      rules.push('*, *::before, *::after { animation: none !important; caret-color: transparent !important; }');
    }
    if (options.stopTransition !== false) {
      rules.push('*, *::before, *::after { transition: none !important; }');
      rules.push('html { scroll-behavior: auto !important; }');
    }
    style.textContent = rules.join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  for (const selector of coverSelectors) {
    for (const node of query(selector)) {
      const el = node as HTMLElement;
      el.style.visibility = 'hidden';
      covered += 1;
    }
  }

  for (const selector of hideSelectors) {
    for (const node of query(selector)) {
      const el = node as HTMLElement;
      el.style.display = 'none';
      hidden += 1;
    }
  }

  for (const rule of replacedRules) {
    for (const node of query(String(rule.selector || ''))) {
      const el = node as HTMLElement;
      el.textContent = String(rule.text ?? '');
      replaced += 1;
    }
  }

  return new Promise((resolve) => {
    let finished = false;
    let quietTimer: any;
    const maxWait = Math.max(100, Math.min(5000, Number(options.timeoutMs) || 800));
    const observer = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(done, 80);
        })
      : null;

    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(maxTimer);
      clearTimeout(quietTimer);
      if (observer) observer.disconnect();
      resolve({
        replaced,
        hidden,
        covered,
        missingSelectors,
        elapsedMs: Date.now() - startedAt,
      });
    }

    const maxTimer = setTimeout(done, maxWait);
    try {
      if (observer) {
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
    } catch {
      // MutationObserver 不可用时只保留 maxTimer，不影响稳定化动作本身。
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, 80);
    }));
  });
}

/** 生成可通过 evaluate 执行的固定脚本。 */
export function stabilizePageSource(input: unknown): string {
  const options = normalizeStabilizePageOptions(input);
  return `(${applyStabilizePageInBrowser.toString()})(${JSON.stringify(options)})`;
}

/** 32-bit FNV-1a，足够作为基线配置指纹；不依赖 Node crypto，浏览器侧也可复用。 */
export function stabilizeConfigHash(input: unknown): string {
  const normalized = normalizeStabilizePageOptions(input);
  const text = JSON.stringify(normalized);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `stabilize:${hash.toString(16).padStart(8, '0')}`;
}

/** 统一校验并补全执行结果。 */
export function finalizeStabilizePageResult(
  input: unknown,
  raw: any,
): StabilizePageResult {
  const options = normalizeStabilizePageOptions(input);
  if (options.profileId) {
    throw new Error(
      `STABILIZE_PAGE profile「${options.profileId}」尚未注册；请改用内联配置，或先在受控方案库中发布该 profile`,
    );
  }
  const missingSelectors = Array.isArray(raw?.missingSelectors)
    ? raw.missingSelectors.map((item: any) => String(item))
    : [];
  const requiredMissing = (options.replace || [])
    .filter((rule) => rule.required)
    .map((rule) => rule.selector)
    .filter((selector) => missingSelectors.includes(selector));
  if (options.strict && missingSelectors.length) {
    throw new Error(`STABILIZE_PAGE 选择器缺失：${missingSelectors.join(', ')}`);
  }
  if (requiredMissing.length) {
    throw new Error(`STABILIZE_PAGE 必填替换目标缺失：${requiredMissing.join(', ')}`);
  }
  return {
    profileId: options.profileId || '',
    replaced: Number(raw?.replaced) || 0,
    hidden: Number(raw?.hidden) || 0,
    covered: Number(raw?.covered) || 0,
    missingSelectors,
    configHash: stabilizeConfigHash(options),
    elapsedMs: Number(raw?.elapsedMs) || 0,
  };
}
