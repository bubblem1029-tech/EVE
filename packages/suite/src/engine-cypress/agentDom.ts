/**
 * agentDom — Cypress 侧 Re-Act agent 的页内能力源码
 *
 * 与 locatorSource.ts / pageOps.ts 同样以「自包含源码字符串」形式注入 AUT 的
 * isolated world：页内函数无法闭包引用 bundle 变量，只能整段送过去求值。
 *
 * 职责：
 *   snapshot()  生成与 Playwright `ariaSnapshot({mode:'ai'})` 同形的文本，
 *               并为每个可见节点分配稳定 ref（`e1`、`e2`…），
 *               供 `locator('aria-ref=eN')` 解析。
 *   resolve()   locator 链求值（css / aria-ref / text / role / 过滤），
 *               语义对齐 Playwright 的后代搜索 + 集合传递。
 *   act/read    元素动作与读取（点击/输入/勾选/下拉/属性/坐标/可见性）。
 *
 * 之所以不复用 CDP 的 `Accessibility.getFullAXTree`：AX 树的 backendDOMNodeId
 * 需要在 AUT isolated world 里二次解析成元素，链路更长且多一次跨进程往返；
 * 页内快照可以直接持有元素引用，ref 天然稳定。
 */

/** 注入页内的 agent DOM 能力源码（幂等：重复注入直接返回 cached） */
export function agentDomSource(): string {
  return `(() => {
  "use strict";
  if (window.__keveAgentSource === "v1") return "cached";

  var MAX_NAME = 120;
  var MAX_LINES = 1500;

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TEMPLATE: 1, NOSCRIPT: 1, HEAD: 1,
    TITLE: 1, BASE: 1, COL: 1, COLGROUP: 1, SOURCE: 1, TRACK: 1, PARAM: 1,
  };

  /** 需要出现在快照里的语义角色（无名称的 generic 会被折叠，避免噪声） */
  var NAMED_ONLY_ROLES = {
    generic: 1, paragraph: 1, group: 1, region: 1, article: 1, figure: 1,
    list: 1, table: 1, row: 1, cell: 1, code: 1, blockquote: 1, caption: 1,
  };

  function locatorLib() {
    return window.__keveLocator || null;
  }

  function queryAllDeep(root, css) {
    var lib = locatorLib();
    if (lib && lib.queryAllDeep) return lib.queryAllDeep(root, css);
    try { return Array.prototype.slice.call(root.querySelectorAll(css)); }
    catch (e) { return []; }
  }

  function implicitRole(el) {
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return String(explicit).trim().split(/\\s+/)[0];
    var tag = String(el.tagName || "").toUpperCase();
    var cls = String(el.className || "");
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (cls.indexOf("el-message-box") >= 0 || cls.indexOf("message-box") >= 0) return "dialog";
    if (cls.indexOf("el-dialog") >= 0 || cls.indexOf("ks-dialog") >= 0 || cls.indexOf("ant-modal") >= 0) return "dialog";
    if (tag === "INPUT") {
      var t = String(el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "hidden") return "";
      return "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (tag === "IMG") return "img";
    if (tag === "IFRAME") return "iframe";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "UL" || tag === "OL") return "list";
    if (tag === "LI") return "listitem";
    if (tag === "TABLE") return "table";
    if (tag === "TR") return "row";
    if (tag === "TD") return "cell";
    if (tag === "TH") return "columnheader";
    if (tag === "DIALOG") return "dialog";
    if (tag === "OPTION") return "option";
    if (tag === "OPTGROUP") return "group";
    if (tag === "FORM") return "form";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "HEADER") return "banner";
    if (tag === "FOOTER") return "contentinfo";
    if (tag === "ASIDE") return "complementary";
    if (tag === "SECTION") return "region";
    if (tag === "ARTICLE") return "article";
    if (tag === "LABEL") return "label";
    if (tag === "P") return "paragraph";
    if (tag === "PRE" || tag === "CODE") return "code";
    if (tag === "HR") return "separator";
    if (tag === "PROGRESS") return "progressbar";
    if (tag === "METER") return "meter";
    if (tag === "OUTPUT") return "status";
    if (tag === "FIELDSET") return "group";
    if (tag === "FIGURE") return "figure";
    if (tag === "FIGCAPTION") return "caption";
    if (tag === "BLOCKQUOTE") return "blockquote";
    return "generic";
  }

  function accessibleName(el) {
    var lib = locatorLib();
    if (lib && lib.accessibleName) {
      var libName = String(lib.accessibleName(el) || "").replace(/\\s+/g, " ").trim();
      if (libName) return libName;
    }
    var ids = String(el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
    var labelled = "";
    for (var i = 0; i < ids.length; i += 1) {
      var node = document.getElementById(ids[i]);
      if (node) labelled += " " + String(node.textContent || "");
    }
    var alt = el.getAttribute && el.getAttribute("alt");
    var value = el.getAttribute && el.getAttribute("aria-label");
    var title = el.getAttribute && el.getAttribute("title");
    var placeholder = el.getAttribute && el.getAttribute("placeholder");
    var text = labelled || value || alt || title || placeholder || "";
    if (!text && el.tagName === "INPUT") {
      var t = String(el.getAttribute("type") || "").toLowerCase();
      if (t === "checkbox" || t === "radio") text = el.value || "";
    }
    return String(text).replace(/\\s+/g, " ").trim();
  }

  function ownText(el) {
    var out = "";
    for (var i = 0; i < el.childNodes.length; i += 1) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) out += " " + String(n.nodeValue || "");
    }
    return out.replace(/\\s+/g, " ").trim();
  }

  function allText(el) {
    return String(el.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  function isAriaHidden(el) {
    var cur = el;
    while (cur && cur.getAttribute) {
      if (cur.getAttribute("aria-hidden") === "true") return true;
      if (cur.hasAttribute && cur.hasAttribute("hidden")) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ── ref 注册表：元素 → ref 稳定映射（同一元素在多次快照中保持同一 ref） ──
  function registry() {
    if (!window.__keveAgentRefs) {
      window.__keveAgentRefs = { byRef: {}, byEl: new WeakMap(), seq: 0 };
    }
    return window.__keveAgentRefs;
  }

  function refFor(el) {
    var reg = registry();
    var existing = reg.byEl.get(el);
    if (existing) return existing;
    reg.seq += 1;
    var ref = "e" + reg.seq;
    reg.byEl.set(el, ref);
    reg.byRef[ref] = el;
    return ref;
  }

  function elByRef(ref) {
    var reg = registry();
    var el = reg.byRef[String(ref || "")];
    if (el && el.isConnected) return el;
    return null;
  }

  function stateAttrs(el, role) {
    var attrs = [];
    var tag = String(el.tagName || "").toUpperCase();
    var type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
    if (el.disabled) attrs.push("disabled");
    if (el.readOnly && (tag === "INPUT" || tag === "TEXTAREA")) attrs.push("readonly");
    if (el.required) attrs.push("required");
    if (role === "checkbox" || role === "radio" || role === "switch") {
      var explicit = el.getAttribute && el.getAttribute("aria-checked");
      var checked = explicit !== null && explicit !== undefined ? explicit === "true" : !!el.checked;
      if (checked) attrs.push("checked");
    }
    if (type === "checkbox" || type === "radio") {
      if (el.indeterminate) attrs.push("indeterminate");
    }
    var expanded = el.getAttribute && el.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") attrs.push("expanded=" + expanded);
    var selected = el.getAttribute && el.getAttribute("aria-selected");
    if (selected === "true") attrs.push("selected");
    var pressed = el.getAttribute && el.getAttribute("aria-pressed");
    if (pressed === "true" || pressed === "mixed") attrs.push("pressed=" + pressed);
    var modal = el.getAttribute && el.getAttribute("aria-modal");
    if (modal === "true") attrs.push("modal");
    if (role === "heading") {
      var level = el.getAttribute && el.getAttribute("aria-level");
      var tagLevel = /^H[1-6]$/.test(tag) ? tag.slice(1) : "";
      attrs.push("level=" + (level || tagLevel || "2"));
    }
    try {
      if (window.getComputedStyle(el).cursor === "pointer" && !el.disabled) attrs.push("cursor=pointer");
    } catch (e) { /* 忽略 */ }
    return attrs.length ? " [" + attrs.join("] [") + "]" : "";
  }

  function valueOf(el, role) {
    var tag = String(el.tagName || "").toUpperCase();
    if (role === "textbox" || role === "searchbox" || role === "spinbutton") {
      return el.value !== undefined && String(el.value) !== "" ? String(el.value) : "";
    }
    if (role === "combobox" || role === "listbox") {
      if (tag === "SELECT") {
        var opt = el.selectedOptions && el.selectedOptions[0];
        return opt ? String(opt.textContent || "").trim() : "";
      }
      return String(el.value || "").trim();
    }
    if (role === "option" || role === "listitem") return "";
    return "";
  }

  function shouldRender(el, role, name, direct) {
    if (!role) return false;
    if (SKIP_TAGS[String(el.tagName || "").toUpperCase()]) return false;
    if (role === "iframe") return true;
    if (NAMED_ONLY_ROLES[role]) {
      if (name) return true;
      if (direct && direct.length <= MAX_NAME) return true;
      return false;
    }
    return true;
  }

  function snapshot(maxLines) {
    var limit = Number(maxLines) || MAX_LINES;
    var lines = [];
    var truncated = false;

    function walk(node, depth) {
      if (truncated) return;
      var children = node.children || [];
      for (var i = 0; i < children.length; i += 1) {
        var el = children[i];
        var tag = String(el.tagName || "").toUpperCase();
        if (SKIP_TAGS[tag]) continue;
        if (isAriaHidden(el)) continue;

        var childDepth = depth;
        if (isVisible(el)) {
          var role = implicitRole(el);
          var name = accessibleName(el);
          var direct = ownText(el);
          if (shouldRender(el, role, name, direct)) {
            if (lines.length >= limit) { truncated = true; return; }
            var attrs = stateAttrs(el, role);
            var ref = refFor(el);
            var value = valueOf(el, role);
            var text = direct && direct.length <= MAX_NAME ? direct : "";
            var line = "  ".repeat(depth + 1) + "- " + role + " [ref=" + ref + "]" + attrs;
            if (name) line += " \\"" + name.slice(0, MAX_NAME).replace(/"/g, "'") + "\\"";
            if (value) line += ": " + value.slice(0, MAX_NAME);
            else if (text) line += ": " + text;
            lines.push(line);
            childDepth = depth + 1;
          }
        }

        // 同源 iframe 穿透（与 Playwright 的快照语义对齐）
        if (tag === "IFRAME") {
          var doc = null;
          try { doc = el.contentDocument; } catch (e) { doc = null; }
          if (doc && doc.body) walk(doc.body, childDepth);
          continue;
        }
        walk(el, childDepth);
      }
    }

    walk(document.body || document.documentElement, 0);
    if (truncated) lines.push("... (snapshot truncated at " + limit + " lines)");
    return lines.join("\\n");
  }

  // ── 定位：ops 是 locator 链，每跳在上一跳结果的后代里求值 ──

  function dedupe(list) {
    var seen = [];
    for (var i = 0; i < list.length; i += 1) {
      if (seen.indexOf(list[i]) < 0) seen.push(list[i]);
    }
    return seen;
  }

  function descendants(scope, css) {
    if (scope === document) return queryAllDeep(document, css);
    return queryAllDeep(scope, css);
  }

  /** 文本匹配取「包含该文本的最深元素」，与 locatorSource 的 includes 跳一致 */
  function textIn(scopes, needle, exact) {
    var want = String(needle == null ? "" : needle).replace(/\\s+/g, " ").trim();
    if (!want) return [];
    var hits = [];
    for (var s = 0; s < scopes.length; s += 1) {
      var scope = scopes[s];
      var pool = scope === document
        ? queryAllDeep(document, "*")
        : queryAllDeep(scope, "*");
      var local = [];
      for (var i = 0; i < pool.length; i += 1) {
        var text = allText(pool[i]);
        if (!text) continue;
        if (exact ? text === want : text.indexOf(want) >= 0) local.push(pool[i]);
      }
      for (var j = 0; j < local.length; j += 1) {
        var el = local[j];
        var hasInnerMatch = false;
        for (var k = 0; k < local.length; k += 1) {
          if (k !== j && el.contains(local[k])) { hasInnerMatch = true; break; }
        }
        if (!hasInnerMatch) hits.push(el);
      }
    }
    return dedupe(hits);
  }

  var ROLE_SELECTOR = "[role],button,a[href],input,select,textarea,img,summary,dialog,option,[aria-label],[aria-labelledby],[tabindex],.el-message-box,.el-dialog,.ks-dialog,.ant-modal";

  function roleIn(scopes, role, name, exact) {
    var want = String(role || "").toLowerCase();
    var wantName = name == null ? "" : String(name);
    var hits = [];
    for (var s = 0; s < scopes.length; s += 1) {
      var scope = scopes[s];
      var pool = scope === document ? queryAllDeep(document, ROLE_SELECTOR) : queryAllDeep(scope, ROLE_SELECTOR);
      for (var i = 0; i < pool.length; i += 1) {
        var el = pool[i];
        if (String(implicitRole(el)).toLowerCase() !== want) continue;
        if (wantName) {
          var actual = accessibleName(el);
          if (exact ? actual !== wantName : actual.indexOf(wantName) < 0) continue;
        }
        hits.push(el);
      }
    }
    return dedupe(hits);
  }

  function resolve(ops) {
    var list = Array.isArray(ops) ? ops : [];
    var cur = [document];
    for (var i = 0; i < list.length; i += 1) {
      var op = list[i] || {};
      var t = String(op.t || "");
      if (t === "css") {
        var next = [];
        for (var s = 0; s < cur.length; s += 1) {
          next = next.concat(descendants(cur[s], String(op.selector || "")));
        }
        cur = dedupe(next);
      } else if (t === "ariaRef") {
        var el = elByRef(op.ref);
        cur = el ? [el] : [];
      } else if (t === "text") {
        cur = textIn(cur, op.text, op.exact !== false);
      } else if (t === "role") {
        cur = roleIn(cur, op.role, op.name, op.exact !== false);
      } else if (t === "filterHasText") {
        var needle = String(op.text == null ? "" : op.text);
        var kept = [];
        for (var f = 0; f < cur.length; f += 1) {
          if (allText(cur[f]).indexOf(needle) >= 0) kept.push(cur[f]);
        }
        cur = kept;
      } else if (t === "filterVisible") {
        var visibleKept = [];
        for (var v = 0; v < cur.length; v += 1) {
          if (isVisible(cur[v])) visibleKept.push(cur[v]);
        }
        cur = visibleKept;
      }
      if (!cur.length) return [];
    }
    return cur;
  }

  function pick(els, index) {
    if (!els || !els.length) return null;
    if (index === null || index === undefined || index === "") return els[0];
    var i = Number(index);
    if (!isFinite(i)) return els[0];
    if (i < 0) return els[els.length + i] || null;
    return els[i] || null;
  }

  /** 定位失败时的可读错误（与 CypressEngine.withWait 的重试判定词对齐） */
  function pickOrThrow(els, index) {
    var el = pick(els, index);
    if (!el) {
      throw new Error("[keve] 元素未找到（no-match）: index=" + index + ", matched=" + ((els && els.length) || 0));
    }
    return el;
  }

  // ── 动作 ──

  function fire(el, type, init) {
    var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
    if (init) for (var k in init) base[k] = init[k];
    el.dispatchEvent(new MouseEvent(type, base));
  }

  function clickEl(el, dbl) {
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    if (el.focus) { try { el.focus(); } catch (e) { /* 忽略 */ } }
    fire(el, "mousedown");
    fire(el, "mouseup");
    if (typeof el.click === "function") el.click();
    else fire(el, "click");
    fire(el, "click");
    if (dbl) {
      fire(el, "mousedown", { detail: 2 });
      fire(el, "mouseup", { detail: 2 });
      fire(el, "dblclick", { detail: 2 });
    }
  }

  function setNativeValue(el, value) {
    var text = value == null ? "" : String(value);
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
      return;
    }
    var proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : (el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function act(el, action, payload) {
    var data = payload || {};
    if (action === "click") { clickEl(el, false); return "ok"; }
    if (action === "dblclick") { clickEl(el, true); return "ok"; }
    if (action === "hover") {
      if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
      fire(el, "mouseover"); fire(el, "mouseenter"); fire(el, "mousemove");
      return "ok";
    }
    if (action === "focus") { if (el.focus) el.focus(); return "ok"; }
    if (action === "fill") { setNativeValue(el, data.value); return "ok"; }
    if (action === "setChecked") {
      var want = !!data.checked;
      if (el.checked !== want) {
        if (typeof el.click === "function" && !el.disabled) el.click();
        else { el.checked = want; el.dispatchEvent(new Event("change", { bubbles: true })); }
      }
      return "ok";
    }
    if (action === "selectOption") {
      var tag = String(el.tagName || "").toUpperCase();
      if (tag !== "SELECT") throw new Error("[keve] 非原生 select，无法 selectOption");
      var opts = Array.prototype.slice.call(el.options || []);
      var chosen = null;
      if (data.value !== undefined && data.value !== null) {
        chosen = opts.filter(function (o) { return o.value === data.value; })[0] || null;
      }
      if (!chosen && data.label !== undefined) {
        chosen = opts.filter(function (o) { return String(o.textContent || "").trim() === data.label; })[0] || null;
      }
      if (!chosen && data.label !== undefined) {
        chosen = opts.filter(function (o) { return String(o.textContent || "").trim().indexOf(data.label) >= 0; })[0] || null;
      }
      if (!chosen) throw new Error("[keve] select 中没有匹配的 option: " + JSON.stringify(data));
      el.value = chosen.value;
      chosen.selected = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    }
    if (action === "press") {
      var key = String(data.key || "");
      if (el.focus) el.focus();
      var init = { key: key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return "ok";
    }
    throw new Error("[keve] 未知动作: " + action);
  }

  function read(el, what, arg) {
    if (what === "text") {
      var v = el.value !== undefined && String(el.value) !== "" ? String(el.value) : String(el.textContent || "");
      return v.replace(/\\s+/g, " ").trim();
    }
    if (what === "innerText") return String(el.innerText !== undefined ? el.innerText : el.textContent || "").replace(/\\s+/g, " ").trim();
    if (what === "value") return el.value === undefined || el.value === null ? "" : String(el.value);
    if (what === "checked") {
      var explicit = el.getAttribute && el.getAttribute("aria-checked");
      if (explicit === "true" || explicit === "false") return explicit === "true";
      return !!el.checked;
    }
    if (what === "attr") return el.getAttribute ? el.getAttribute(String(arg)) : null;
    if (what === "visible") return isVisible(el);
    if (what === "box") {
      if (!isVisible(el)) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    if (what === "eval") {
      var src = String(arg && arg.fn || "");
      if (!src) return null;
      var fn = (0, eval)("(" + src + ")");
      if (typeof fn !== "function") return null;
      return fn(el, arg && arg.arg);
    }
    return null;
  }

  window.__keveAgent = {
    version: "v1",
    snapshot: snapshot,
    resolve: resolve,
    pick: pick,
    count: function (ops, index) {
      var els = resolve(ops);
      if (index === null || index === undefined || index === "") return els.length;
      return pick(els, index) ? 1 : 0;
    },
    read: function (ops, index, what, arg) { return read(pickOrThrow(resolve(ops), index), what, arg); },
    act: function (ops, index, action, payload) { return act(pickOrThrow(resolve(ops), index), action, payload); },
    texts: function (ops, index) {
      var els = resolve(ops);
      if (index !== null && index !== undefined && index !== "") {
        var one = pick(els, index);
        return one ? [read(one, "innerText")] : [];
      }
      var out = [];
      for (var i = 0; i < els.length; i += 1) out.push(read(els[i], "innerText"));
      return out;
    },
    visible: function (ops, index) {
      var el = pick(resolve(ops), index);
      return el ? isVisible(el) : false;
    },
    exists: function (ops, index) { return !!pick(resolve(ops), index); },
    focus: function (ops, index) { var el = pickOrThrow(resolve(ops), index); if (el.focus) el.focus(); return "ok"; },
    evalScript: function (src) { return (0, eval)(String(src)); },
  };
  window.__keveAgentSource = "v1";
  return "ok";
})()`;
}

/** locatorSource + pageOps + agentDom 的一次性注入 */
export function agentBootstrapSource(locatorSrc: string): string {
  return `${locatorSrc};\n${agentDomSource()}`;
}
