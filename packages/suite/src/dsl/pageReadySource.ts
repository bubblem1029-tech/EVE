/**
 * pageReadySource — 页面可用性检测的共享浏览器侧源码。
 *
 * 同一份源码同时供：
 *   - page-health（eve-backend）执行页面巡检
 *   - Playwright engine 的 PAGE_READY 预期
 *   - Cypress engine 的 PAGE_READY 预期
 *
 * 约束：零依赖、浏览器安全、不能引用 bundle 内变量。返回的是一段可被
 * `page.evaluate` / `Runtime.evaluate` 直接求值的源码字符串。
 */

export interface PageReadyOptions {
  rootSelector?: string;
  readySelector?: string;
  minTextLength?: number;
  allowCanvas?: boolean;
  stableTimes?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export type PageReadyReason =
  | 'CONTENT_VISIBLE'
  | 'BLANK_APP_ROOT'
  | 'APP_ROOT_NOT_VISIBLE'
  | 'PERSISTENT_LOADING'
  | 'KEY_CONTENT_NOT_VISIBLE'
  | 'LOGIN_REQUIRED'
  | 'ERROR_PAGE'
  | 'CANVAS_CONTENT_UNVERIFIED'
  | 'CANVAS_CONTENT_VERIFIED'
  | 'CANVAS_BLANK'
  | 'READINESS_NOT_STABLE';

export interface PageReadyResult {
  ready: boolean;
  reason: PageReadyReason;
  textLength: number;
  visibleMedia: number;
  canvasVisible: boolean;
  canvasUnverified: boolean;
  stableSamples: number;
  finalUrl: string;
  durationMs: number;
  checkedRoot: string;
}

export const PAGE_READY_REASON_LABELS: Record<PageReadyReason, string> = {
  CONTENT_VISIBLE: '页面内容稳定可见',
  BLANK_APP_ROOT: '应用区域没有可见内容',
  APP_ROOT_NOT_VISIBLE: '应用根节点不可见',
  PERSISTENT_LOADING: '页面持续加载',
  KEY_CONTENT_NOT_VISIBLE: '关键内容未出现',
  LOGIN_REQUIRED: '需要登录',
  ERROR_PAGE: '页面显示错误',
  CANVAS_CONTENT_UNVERIFIED: '无法确认纯画布内容',
  CANVAS_CONTENT_VERIFIED: '纯画布内容已确认',
  CANVAS_BLANK: '纯画布页面没有内容',
  READINESS_NOT_STABLE: '内容未稳定出现',
};

function normalizeOptions(input: PageReadyOptions) {
  const clamp = (value: any, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    rootSelector: String(input.rootSelector || '').slice(0, 500),
    readySelector: String(input.readySelector || '').slice(0, 500),
    minTextLength: clamp(input.minTextLength, 2, 0, 1000),
    allowCanvas: input.allowCanvas === true,
    stableTimes: clamp(input.stableTimes, 3, 1, 10),
    intervalMs: clamp(input.intervalMs, 500, 100, 5000),
    timeoutMs: clamp(input.timeoutMs, 30000, 1000, 120000),
  };
}

export function pageReadySource(input: PageReadyOptions = {}): string {
  const options = normalizeOptions(input);
  return `(function (options) {
  "use strict";
  var started = Date.now();
  var deadline = started + options.timeoutMs;
  var stable = 0;
  var last = null;

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var box = el.getBoundingClientRect();
    var css = getComputedStyle(el);
    return box.width > 1 && box.height > 1 && css.visibility !== "hidden" && css.display !== "none" && Number(css.opacity) > 0;
  }

  function queryAll(root, selector) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
    catch (e) { return []; }
  }

  function matches(el, selector) {
    try { return !!(el && el.matches && el.matches(selector)); }
    catch (e) { return false; }
  }

  function textOf(el) {
    return String((el && (el.innerText || el.textContent)) || "").trim();
  }

  function rootLabel(root) {
    if (!root) return "";
    if (root.id) return "#" + root.id;
    return String(root.tagName || "").toLowerCase();
  }

  function findRoot() {
    var candidates;
    if (options.rootSelector) {
      candidates = queryAll(document, options.rootSelector);
      for (var i = 0; i < candidates.length; i += 1) {
        if (visible(candidates[i])) return candidates[i];
      }
      return null;
    }
    candidates = queryAll(document, "#app, #root, main, [role=main]");
    for (var j = 0; j < candidates.length; j += 1) {
      if (visible(candidates[j])) return candidates[j];
    }
    if (!candidates.length) return document.body;
    return null;
  }

  function snapshot() {
    var root = findRoot();
    if (!root || !visible(root)) {
      return { ready: false, reason: "APP_ROOT_NOT_VISIBLE", textLength: 0, visibleMedia: 0, canvasVisible: false, canvasUnverified: false, checkedRoot: rootLabel(root) };
    }
    if (queryAll(document, "input[type=password]").some(visible)) {
      return { ready: false, reason: "LOGIN_REQUIRED", textLength: 0, visibleMedia: 0, canvasVisible: false, canvasUnverified: false, checkedRoot: rootLabel(root) };
    }
    var text = textOf(root);
    if (/^(?:403|404|500|页面不存在|无权限访问|系统异常|服务不可用)(?:\\s|$|[，。！!])/i.test(text)) {
      return { ready: false, reason: "ERROR_PAGE", textLength: text.length, visibleMedia: 0, canvasVisible: false, canvasUnverified: false, checkedRoot: rootLabel(root) };
    }
    var box = root.getBoundingClientRect();
    var area = box.width * box.height;
    var loadingSelector = "[aria-busy=true], [role=progressbar], .el-loading-mask, .ks-loading-mask, .ant-spin-spinning";
    var loading = /^(?:加载中|正在加载|loading)[.。…\\s]*$/i.test(text);
    if (!loading) {
      var masks = [root].concat(queryAll(root, loadingSelector));
      for (var k = 0; k < masks.length; k += 1) {
        if (!matches(masks[k], loadingSelector)) continue;
        if (!visible(masks[k])) continue;
        var maskBox = masks[k].getBoundingClientRect();
        if (maskBox.width * maskBox.height >= area * 0.5) { loading = true; break; }
      }
    }
    if (loading) {
      return { ready: false, reason: "PERSISTENT_LOADING", textLength: text.length, visibleMedia: 0, canvasVisible: false, canvasUnverified: false, checkedRoot: rootLabel(root) };
    }
    if (options.readySelector) {
      var keys = queryAll(root, options.readySelector);
      if (matches(root, options.readySelector)) keys.push(root);
      if (!keys.some(visible)) {
        return { ready: false, reason: "KEY_CONTENT_NOT_VISIBLE", textLength: text.length, visibleMedia: 0, canvasVisible: false, canvasUnverified: false, checkedRoot: rootLabel(root) };
      }
    }
    var canvases = queryAll(root, "canvas").filter(visible);
    var media = queryAll(root, "svg, img, video").filter(visible).length;
    var content = text.length >= options.minTextLength || media > 0;
    if (!content && canvases.length) {
      if (options.allowCanvas) {
        return { ready: true, reason: "CONTENT_VISIBLE", textLength: text.length, visibleMedia: media, canvasVisible: true, canvasUnverified: true, checkedRoot: rootLabel(root) };
      }
      return { ready: false, reason: "CANVAS_CONTENT_UNVERIFIED", textLength: text.length, visibleMedia: media, canvasVisible: true, canvasUnverified: true, checkedRoot: rootLabel(root) };
    }
    if (!content) {
      return { ready: false, reason: "BLANK_APP_ROOT", textLength: text.length, visibleMedia: media, canvasVisible: canvases.length > 0, canvasUnverified: false, checkedRoot: rootLabel(root) };
    }
    return { ready: true, reason: "CONTENT_VISIBLE", textLength: text.length, visibleMedia: media, canvasVisible: canvases.length > 0, canvasUnverified: false, checkedRoot: rootLabel(root) };
  }

  return new Promise(function (resolve) {
    function finish(result) {
      result.finalUrl = String(location.href || "");
      result.durationMs = Date.now() - started;
      result.stableSamples = stable;
      resolve(result);
    }
    function tick() {
      last = snapshot();
      if (last.ready) stable += 1; else stable = 0;
      if (stable >= options.stableTimes) return finish(last);
      if (Date.now() >= deadline) {
        last.ready = false;
        last.reason = last.reason === "CONTENT_VISIBLE" ? "READINESS_NOT_STABLE" : last.reason;
        return finish(last);
      }
      setTimeout(tick, options.intervalMs);
    }
    tick();
  });
})(${JSON.stringify(options)})`;
}

export function describePageReadyFailure(result?: Partial<PageReadyResult> | null): string {
  const reason = String(result?.reason || 'UNKNOWN') as PageReadyReason;
  const label = PAGE_READY_REASON_LABELS[reason] || '页面未正常渲染';
  const parts = [`页面渲染未出现白屏断言失败：${label}`];
  if (result?.textLength != null) parts.push(`文本 ${result.textLength}`);
  if (result?.visibleMedia != null) parts.push(`媒体 ${result.visibleMedia}`);
  if (result?.canvasUnverified) parts.push('canvas 内容未验证');
  if (result?.finalUrl) parts.push(`地址 ${result.finalUrl}`);
  return parts.join('；');
}

