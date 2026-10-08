/**
 * pageOps — 注入 AUT 的「操作原语 + 网络记录」源码
 *
 * 与 locatorSource.ts 同样以「自包含源码字符串」形式注入：isolated world 里的
 * 函数无法闭包引用 bundle 变量，只能整段送过去求值。
 *
 * 职责边界：
 *   locatorSource → 定位（ElementRef / hop 链 → 元素集合）
 *   pageOps       → 动作与读取（点击/输入/拖拽/文本/可见性/属性/滚动）
 *   netLog        → fetch/XHR 记录，支撑 waitForResponse 的软等待门
 *
 * 交互走原生 DOM 事件（探针已验证 React 合成事件能正常响应），
 * 与 Playwright 的 locator click 在「触发应用逻辑」这一层语义等价。
 */

export function pageOpsSource(): string {
  return `(() => {
  "use strict";
  if (window.__keveOpsSource === "v1") return "cached";

  function locator() {
    if (!window.__keveLocator) throw new Error("[keve] locator 未注入");
    return window.__keveLocator;
  }

  /** refs → 末端元素集合（定位语义与 PlaywrightEngine.resolveChain 对齐） */
  function resolve(refs) {
    if (!refs || !refs.length) throw new Error("[keve] 缺少元素定位参数");
    var res = locator().resolveRefChain(refs);
    return (res && res.els) || [];
  }

  function first(refs) {
    var els = resolve(refs);
    if (!els.length) throw new Error("[keve] 元素未找到: " + JSON.stringify(refs).slice(0, 300));
    return els[0];
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  /** 原生事件序列：点击/双击/悬停都走真实 MouseEvent，保证 React 合成事件生效 */
  function mouse(el, type, detail) {
    var rect = el.getBoundingClientRect();
    var init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      detail: detail || 1, button: 0,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
    el.dispatchEvent(new MouseEvent(type, init));
  }

  function clickEl(el, dbl) {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus && el.focus();
    mouse(el, "mousedown");
    mouse(el, "mouseup");
    if (typeof el.click === "function") el.click();
    else mouse(el, "click");
    mouse(el, "click");
    if (dbl) {
      mouse(el, "mousedown", 2);
      mouse(el, "mouseup", 2);
      mouse(el, "dblclick", 2);
    }
  }

  function setValue(el, text) {
    var value = text == null ? "" : String(text);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus && el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
      return;
    }
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : (el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function textOf(el) {
    if (!el) return "";
    var t = el.value != null && String(el.value) !== "" ? String(el.value) : String(el.textContent || "");
    return t.replace(/\\s+/g, " ").trim();
  }

  function attrOf(el, name) {
    if (!el) return null;
    return el.getAttribute(name);
  }

  function classList(el) {
    return el ? String(el.getAttribute("class") || "") : "";
  }

  function dragEl(src, dst) {
    var dt = null;
    try { dt = new DataTransfer(); } catch (e) { dt = null; }
    var types = ["dragstart", "dragenter", "dragover", "drop", "dragend"];
    for (var i = 0; i < types.length; i += 1) {
      var target = (types[i] === "dragstart" || types[i] === "dragend") ? src : dst;
      var ev = new DragEvent(types[i], { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(ev);
    }
  }

  window.__keveOps = {
    version: "v1",
    resolve: resolve,
    count: function (refs) { return resolve(refs).length; },
    countNonEmpty: function (refs) {
      return resolve(refs).filter(function (el) { return textOf(el).length > 0; }).length;
    },
    text: function (refs) { return textOf(first(refs)); },
    texts: function (refs) { return resolve(refs).map(textOf); },
    visible: function (refs) { return isVisible(first(refs)); },
    hidden: function (refs) { var els = resolve(refs); return !els.length || !isVisible(els[0]); },
    exists: function (refs) { return resolve(refs).length > 0; },
    attr: function (refs, name) { return attrOf(first(refs), name); },
    classes: function (refs) { return classList(first(refs)); },
    click: function (refs, dbl) { clickEl(first(refs), !!dbl); return "ok"; },
    hover: function (refs) { var el = first(refs); el.scrollIntoView({ block: "center" }); mouse(el, "mouseover"); mouse(el, "mouseenter"); mouse(el, "mousemove"); return "ok"; },
    type: function (refs, text) { setValue(first(refs), text); return "ok"; },
    clear: function (refs) { setValue(first(refs), ""); return "ok"; },
    scrollIntoView: function (refs) { first(refs).scrollIntoView({ block: "center", inline: "center" }); return "ok"; },
    scrollPage: function (dy) { window.scrollBy(0, Number(dy) || 600); return "ok"; },
    drag: function (srcRefs, dstRefs) { dragEl(first(srcRefs), first(dstRefs)); return "ok"; },
    url: function () { return location.href; },
    title: function () { return String(document.title || ""); },
    waitSelector: function (css, visible) {
      var els = locator().queryAllDeep(document, css);
      if (!els.length) return false;
      return visible === false ? !isVisible(els[0]) : isVisible(els[0]);
    },
    evaluate: function (expr) {
      // 平台 WRITE_GLOBAL 的 javascript hop 是表达式形态
      return (0, eval)("(" + expr + ")");
    },
  };
  window.__keveOpsSource = "v1";
  return "ok";
})()`;
}

/**
 * 网络记录：waitForResponse 的就绪门依赖它。
 * 在 AUT 里最早注入，之后所有 fetch/XHR 都会留下 {url, method, status, at}。
 * 只记录元数据不记录 body —— 读 body 会消费流，影响被测应用自身逻辑。
 */
export function netLogSource(): string {
  return `(() => {
  "use strict";
  if (window.__keveNetLogSource === "v1") return "cached";
  var log = [];
  window.__keveNetLog = log;

  function push(entry) {
    log.push(entry);
    if (log.length > 500) log.splice(0, log.length - 500);
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var at = Date.now();
      var p = origFetch.apply(this, arguments);
      if (p && typeof p.then === "function") {
        p.then(function (res) {
          push({ url: String(url), method: method, status: res && res.status, at: at });
          return res;
        }, function (err) {
          push({ url: String(url), method: method, status: 0, at: at, error: String(err && err.message || err) });
        });
      }
      return p;
    };
  }

  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__keve = { method: String(method || "GET").toUpperCase(), url: String(url || ""), at: Date.now() };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener("loadend", function () {
      var meta = self.__keve || {};
      push({ url: meta.url || "", method: meta.method || "GET", status: self.status, at: meta.at || Date.now() });
    });
    return XS.apply(this, arguments);
  };

  window.__keveNetLogSource = "v1";
  return "ok";
})()`;
}

/** 三项注入合并（幂等，重复调用无副作用） */
export function bootstrapSource(locatorSrc: string): string {
  return `${locatorSrc};\n${netLogSource()};\n${pageOpsSource()}`;
}

/**
 * 运行诊断采集（AUT 主世界）。
 *
 * Cypress 侧不能订阅 CDP 域事件（`Cypress.automation` 只有 request/response，
 * 没有 domain event 通道），所以这里在**主世界**劫持 console / 全局错误 /
 * fetch / XHR，并用 PerformanceObserver 采集 LCP 与 longtask。
 *
 * 采集结果写入 `document.documentElement.dataset.keveDiagnostics`，因为
 * isolated world 与主世界共享 DOM、但不共享 JS 全局，DOM 属性是唯一稳定的
 * 跨世界只读通道。Agent 结束后由 isolated world 读一次快照即可。
 *
 * 约束：
 *   - 必须调用原始 console / fetch / XHR，避免递归采集；
 *   - 不读 body（会消费流，影响被测应用）；
 *   - 文本与样本都做截断/限量，避免诊断本身撑爆报告；
 *   - 只写 DOM 属性，不改 `window.__keveNetLog`（waitForResponse 依赖它）。
 */
export function diagnosticsSource(): string {
  return `(() => {
  "use strict";
  if (window.__keveDiagnosticsSource === "v1") return "cached";

  var MAX_TEXT = 1000;
  var MAX_RECORDS = 300;
  var browserRecords = [];
  var networkRecords = [];
  var flushTimer = null;
  var lcpMs = 0;
  var longTaskCount = 0;
  var longTaskMs = 0;

  function clip(value, max) {
    var s = String(value == null ? "" : value);
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  function flush() {
    try {
      var root = document.documentElement || document.body;
      if (!root) {
        scheduleFlush();
        return;
      }
      var page = {};
      try {
        var nav = (performance.getEntriesByType && performance.getEntriesByType("navigation") || [])[0];
        if (nav) {
          if (nav.domContentLoadedEventEnd) page.domContentLoadedMs = Math.round(nav.domContentLoadedEventEnd);
          if (nav.loadEventEnd) page.loadMs = Math.round(nav.loadEventEnd);
        }
        if (lcpMs > 0) page.lcpMs = Math.round(lcpMs);
        if (longTaskCount > 0) {
          page.longTaskCount = longTaskCount;
          page.longTaskMs = Math.round(longTaskMs);
        }
        var mem = performance.memory;
        if (mem && mem.usedJSHeapSize) page.heapUsedMb = Math.round(mem.usedJSHeapSize / 1048576 * 10) / 10;
      } catch (e) { /* 性能 API 缺失时忽略 */ }
      root.dataset.keveDiagnostics = JSON.stringify({
        browser: browserRecords,
        network: networkRecords,
        page: page
      });
    } catch (e) { /* 属性写入失败不影响用例 */ }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, 100);
  }

  function pushBrowser(kind, level, text) {
    browserRecords.push({ kind: kind, level: level, text: clip(text, MAX_TEXT), at: Date.now() });
    if (browserRecords.length > MAX_RECORDS) browserRecords.splice(0, browserRecords.length - MAX_RECORDS);
    scheduleFlush();
  }

  function pushNetwork(entry) {
    entry.url = clip(entry.url, 500);
    if (entry.error) entry.error = clip(entry.error, 300);
    networkRecords.push(entry);
    if (networkRecords.length > MAX_RECORDS) networkRecords.splice(0, networkRecords.length - MAX_RECORDS);
    scheduleFlush();
  }

  // ── Console：只摘 error/warn，普通 log 不占样本额度 ──
  ["error", "warn"].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== "function") return;
    console[level] = function () {
      try {
        pushBrowser("console", level, Array.prototype.map.call(arguments, function (a) {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === "object") {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
          }
          return String(a);
        }).join(" "));
      } catch (e) { /* 采集失败不影响原始输出 */ }
      return orig.apply(console, arguments);
    };
  });

  // ── 全局未捕获错误 / 未处理的 Promise rejection ──
  window.addEventListener("error", function (event) {
    var err = event && event.error;
    var text = (err && (err.stack || err.message)) || (event && event.message) || "unknown error";
    pushBrowser("pageerror", "error", text);
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var text = (reason && (reason.stack || reason.message)) || String(reason || "unhandled rejection");
    pushBrowser("exception", "error", text);
  });

  // ── fetch ──
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var startedAt = Date.now();
      var p = origFetch.apply(this, arguments);
      if (p && typeof p.then === "function") {
        p.then(function (res) {
          pushNetwork({
            url: String(url),
            method: method,
            status: res && res.status,
            durationMs: Date.now() - startedAt,
            at: startedAt
          });
          return res;
        }, function (err) {
          pushNetwork({
            url: String(url),
            method: method,
            status: 0,
            durationMs: Date.now() - startedAt,
            error: String((err && err.message) || err),
            at: startedAt
          });
        });
      }
      return p;
    };
  }

  // ── XHR ──
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__keveDiag = {
      method: String(method || "GET").toUpperCase(),
      url: String(url || ""),
      startedAt: Date.now()
    };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    this.addEventListener("loadend", function () {
      var meta = self.__keveDiag || {};
      pushNetwork({
        url: meta.url || "",
        method: meta.method || "GET",
        status: self.status,
        durationMs: meta.startedAt ? Date.now() - meta.startedAt : undefined,
        error: self.status === 0 ? "network error" : undefined,
        at: meta.startedAt
      });
    });
    return XS.apply(this, arguments);
  };

  // ── 性能：LCP / longtask（buffered 让先发生的条目也能补收） ──
  try {
    if (typeof PerformanceObserver === "function") {
      var lcpObs = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          var t = entries[i].startTime || entries[i].renderTime || 0;
          if (t > lcpMs) lcpMs = t;
        }
        scheduleFlush();
      });
      lcpObs.observe({ type: "largest-contentful-paint", buffered: true });

      var longObs = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var j = 0; j < entries.length; j++) {
          longTaskCount += 1;
          longTaskMs += Number(entries[j].duration || 0);
        }
        scheduleFlush();
      });
      longObs.observe({ type: "longtask", buffered: true });
    }
  } catch (e) { /* 浏览器不支持时静默降级 */ }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", flush, { once: true });
  }
  window.addEventListener("load", flush, { once: true });
  // isolated world 读取前会 dispatch 该事件，要求主世界立即刷新 DOM 快照，
  // 避免最后一条网络/console 记录落在 debounce 窗口里没被读走。
  window.addEventListener("keve:flush-diagnostics", flush);

  window.__keveDiagnosticsSource = "v1";
  flush();
  return "ok";
})()`;
}
