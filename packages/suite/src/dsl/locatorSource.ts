/**
 * locatorSource — 浏览器侧元素定位（hop 链）源码生成
 *
 * Cypress 侧没有 Playwright Locator，元素定位必须在 AUT 的 DOM 里自己实现。
 * 本模块不直接操作 DOM，只**生成一段可在页面上下文求值的自包含源码字符串**，
 * 由 engine-cypress 通过 CDP `Runtime.evaluate` 注入一次，之后复用。
 *
 * 之所以生成源码而不是导出普通函数：注入 isolate world 的函数无法闭包引用
 * bundle 里的变量，只能整段作为源码传过去。因此生成物必须零外部引用。
 *
 * 语义严格对齐 elementResolver.ts::applyHops —— 同一套 hop 只有一种解释：
 *   selector/id/shadow-dom → CSS
 *   class                  → .a.b（空格分隔多 class）
 *   includes/text          → 文本包含，取「包含该文本的最深（最小）元素」
 *   label                  → 可见 label 关联的表单控件
 *   iframe-url             → 同源 iframe 内继续；跨源标记 cross-origin-iframe
 *   javascript/source/''   → 跳过
 *   hop.index              → 1-based；-1/0/非数字表示不取序号
 *
 * 关键差异（相对 Playwright）：Playwright 的 locator 链是「集合 → 集合」，
 * 中间不收敛到单元素；只有末端 .first()/.nth(i) 才收敛。这里同样保持
 * 「集合传递」直到末端，保证 `selector` + `includes` 这类链的结果集正确。
 */

/** 生成页内定位器源码（幂等：重复注入只覆盖同名函数，无副作用） */
export function locatorSource(): string {
  return `(() => {
  "use strict";
  if (window.__keveLocatorSource === "v1") return "cached";

  function classToCss(v) {
    return String(v).trim().split(/\\s+/).filter(Boolean).map(function (c) {
      return "." + c.replace(/^\\.+/, "");
    }).join("");
  }

  function hopToCss(type, value) {
    if (type === "selector") return String(value);
    if (type === "id") return "#" + String(value).replace(/^#/, "");
    if (type === "shadow-dom") return /^[.#[]/.test(String(value))
      ? String(value) : classToCss(value);
    return classToCss(value);
  }

  function queryAll(root, css) {
    if (!root || !css) return [];
    try { return Array.prototype.slice.call(root.querySelectorAll(css)); }
    catch (e) { return []; }
  }

  /** 递归收集 open shadow root 内的匹配（对齐 Playwright css 自动穿透 open shadow） */
  function queryAllDeep(root, css) {
    var out = queryAll(root, css);
    var hosts = queryAll(root, "*");
    for (var i = 0; i < hosts.length; i += 1) {
      if (hosts[i].shadowRoot) {
        var inner = queryAllDeep(hosts[i].shadowRoot, css);
        for (var j = 0; j < inner.length; j += 1) out.push(inner[j]);
      }
    }
    return out;
  }

  function depthOf(el) {
    var d = 0, cur = el;
    while (cur && cur.parentElement) { d += 1; cur = cur.parentElement; }
    return d;
  }

  /** label 文本 → 关联控件：label[for] / 控件嵌套于 label / aria-label */
  function byLabel(root, text) {
    var needle = String(text).trim();
    var labels = queryAllDeep(root, "label");
    for (var i = 0; i < labels.length; i += 1) {
      var lab = labels[i];
      if (String(lab.textContent || "").indexOf(needle) < 0) continue;
      var forId = lab.getAttribute("for");
      if (forId) {
        var byId = root.getElementById ? root.getElementById(forId) : null;
        if (!byId) {
          var candidates = queryAllDeep(root, "[id]");
          for (var c = 0; c < candidates.length; c += 1) {
            if (candidates[c].id === forId) { byId = candidates[c]; break; }
          }
        }
        if (byId) return byId;
      }
      var nested = queryAll(lab, "input,textarea,select,button,[role]")[0];
      if (nested) return nested;
    }
    var aria = queryAllDeep(root, "[aria-label]");
    for (var a = 0; a < aria.length; a += 1) {
      if (String(aria[a].getAttribute("aria-label") || "").indexOf(needle) >= 0) return aria[a];
    }
    return null;
  }

  /**
   * 一跳 → 新集合。返回 { els, status }；els 为空表示该跳落空。
   * index 收敛在这里做（与 Playwright .nth(index-1) 等价）。
   */
  /** 在 roots 范围内按 role(+name) 找元素（语义对齐 Playwright getByRole 的子集） */
  function resolveByRoleIn(roots, role, name) {
    var pool = [];
    for (var r = 0; r < roots.length; r += 1) {
      pool = pool.concat(queryAllDeep(roots[r], "[role],button,a,input,select,textarea,img"));
    }
    var want = String(role).toLowerCase();
    return pool.filter(function (el) {
      var actual = String(el.getAttribute("role") || implicitRole(el)).toLowerCase();
      if (actual !== want) return false;
      if (name == null || name === "") return true;
      return accessibleName(el).indexOf(String(name)) >= 0;
    });
  }

  /** 子定位在 scope 的后代里求值（has / notHas 复合限定用） */
  function resolveWithin(scope, ref) {
    var hops = hopsOf(ref);
    if (!hops.length) return [];
    return resolveChain(hops, [scope]).els;
  }

  function applyHop(scopeEls, hop) {
    var type = String(hop.type || "");
    var value = hop.value;
    var idx = Number(hop.index);
    var useIndex = isFinite(idx) && idx > 0;
    var picked = [];

    for (var s = 0; s < scopeEls.length; s += 1) {
      var scope = scopeEls[s];
      if (type === "includes" || type === "text") {
        var needle = String(value).trim();
        if (!needle) continue;
        var all = queryAllDeep(scope, "*");
        var hits = [];
        for (var i = 0; i < all.length; i += 1) {
          if (String(all[i].textContent || "").indexOf(needle) >= 0) hits.push(all[i]);
        }
        if (!hits.length) continue;
        // 「最小元素」= 命中里最深的一个（与 Playwright text= 命中叶子节点一致）
        var best = hits[0], bestDepth = depthOf(best);
        for (var h = 1; h < hits.length; h += 1) {
          var d = depthOf(hits[h]);
          if (d > bestDepth) { bestDepth = d; best = hits[h]; }
        }
        picked.push(best);
      } else if (type === "label") {
        var ctl = byLabel(scope, value);
        if (!ctl) continue;
        picked.push(ctl);
      } else if (type === "role") {
        var spec = value && typeof value === "object" ? value : { role: value };
        picked = picked.concat(resolveByRoleIn([scope], spec.role, spec.name));
      } else if (type === "data-ref") {
        var refHits = queryAllDeep(scope, "[data-ref]").filter(function (el) {
          return el.getAttribute("data-ref") === String(value);
        });
        picked = picked.concat(refHits);
      } else if (type === "has-text") {
        if (String(scope.textContent || "").indexOf(String(value)) >= 0) picked.push(scope);
      } else if (type === "has-sub") {
        if (resolveWithin(scope, value).length) picked.push(scope);
      } else if (type === "not-has-sub") {
        if (!resolveWithin(scope, value).length) picked.push(scope);
      } else {
        picked = picked.concat(queryAllDeep(scope, hopToCss(type, value)));
      }
    }

    if (!picked.length) return { els: [], status: "no-match" };
    if (useIndex) {
      var one = picked[idx - 1];
      return one ? { els: [one], status: "ok" } : { els: [], status: "index-out-of-range" };
    }
    // 去重（多 scope 可能命中同一元素）
    var seen = [];
    for (var p = 0; p < picked.length; p += 1) {
      if (seen.indexOf(picked[p]) < 0) seen.push(picked[p]);
    }
    return { els: seen, status: status };
  }

  /**
   * 定位链求值。roots 为起始文档/元素集合。
   * 返回 { els, status }：els 是「末端匹配集合」（未收敛），
   * 调用方按需取 .nth / .first。
   */
  function resolveChain(hops, roots) {
    var scopeEls = roots && roots.length ? roots : [document];
    var list = Array.isArray(hops) ? hops : [];
    var sawIframe = false;

    for (var i = 0; i < list.length; i += 1) {
      var hop = list[i] || {};
      var type = String(hop.type || "");
      if (type === "javascript" || type === "source" || type === "") continue;

      if (type === "iframe-url") {
        var frames = [];
        for (var s = 0; s < scopeEls.length; s += 1) {
          frames = frames.concat(queryAllDeep(scopeEls[s], "iframe"));
        }
        var match = null;
        for (var f = 0; f < frames.length; f += 1) {
          if (String(frames[f].getAttribute("src") || "").indexOf(String(hop.value)) >= 0) { match = frames[f]; break; }
        }
        if (!match) return { els: [], status: "no-iframe" };
        var doc = null;
        try { doc = match.contentDocument; } catch (e) { doc = null; }
        if (!doc) return { els: [], status: "cross-origin-iframe" };
        scopeEls = [doc];
        sawIframe = true;
        continue;
      }

      var res = applyHop(scopeEls, hop);
      if (!res.els.length) return res;
      scopeEls = res.els;
    }

    // iframe 进入后无后续定位跳：兜底取 frame 的 body（与 Playwright 实现一致）
    if (sawIframe && scopeEls.length === 1 && scopeEls[0].nodeType === 9) {
      scopeEls = queryAll(scopeEls[0], "body");
    }
    return { els: scopeEls, status: "ok" };
  }

  /**
   * ElementRef → hop 序列（与 elementResolver.resolveElement 同构）
   *   基础定位：chain 优先 → css → role(+name) → ref
   *   复合限定：hasText / has / notHas 转成追加 hop，在前一步的结果集上过滤
   */
  function hopsOf(ref) {
    if (!ref || typeof ref !== "object") return [];
    var hops = [];
    if (ref.chain && ref.chain.length) {
      hops = hops.concat(ref.chain);
    } else if (ref.css) {
      hops.push({ type: "selector", value: ref.css });
    } else if (ref.role) {
      hops.push({ type: "role", value: { role: ref.role, name: ref.name == null ? null : ref.name } });
    } else if (ref.ref) {
      hops.push({ type: "data-ref", value: ref.ref });
    }
    if (ref.hasText != null) hops.push({ type: "has-text", value: ref.hasText });
    if (ref.has) hops.push({ type: "has-sub", value: ref.has });
    if (ref.notHas) hops.push({ type: "not-has-sub", value: ref.notHas });
    return hops;
  }

  /** 单个 ElementRef → 末端匹配集合 */
  function resolveRef(ref) {
    var hops = hopsOf(ref);
    if (!hops.length) return { els: [], status: "invalid-ref" };
    return resolveChain(hops, [document]);
  }

  /**
   * ElementRef 链（engine.resolveChain(page, a, b, c) 的浏览器等价物）：
   * 第一个 ref 从 document 求值，后续 ref 在前一步的结果集范围内继续求值。
   */
  function resolveRefChain(refs) {
    if (!refs || !refs.length) return { els: [], status: "empty-ref" };
    var res = resolveRef(refs[0]);
    for (var i = 1; i < refs.length; i += 1) {
      if (!res.els.length) return res;
      var hops = hopsOf(refs[i]);
      if (!hops.length) continue;
      res = resolveChain(hops, res.els);
    }
    return res;
  }

  function implicitRole(el) {
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input") {
      var t = String(el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button") return "button";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    return "";
  }

  function accessibleName(el) {
    var labelled = "";
    var ids = String(el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
    for (var i = 0; i < ids.length; i += 1) {
      var node = document.getElementById(ids[i]);
      if (node) labelled += " " + String(node.textContent || "");
    }
    return String(
      el.getAttribute("aria-label")
      || labelled
      || (el.labels && el.labels[0] ? el.labels[0].textContent : "")
      || el.textContent
      || el.getAttribute("placeholder")
      || ""
    ).trim();
  }

  window.__keveLocator = {
    version: "v1",
    resolveRef: resolveRef,
    resolveRefChain: resolveRefChain,
    resolveChain: resolveChain,
    queryAllDeep: queryAllDeep,
    accessibleName: accessibleName,
    implicitRole: implicitRole,
  };
  window.__keveLocatorSource = "v1";
  return "ok";
})()`;
}
