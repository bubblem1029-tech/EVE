/**
 * elementResolver — 将 ElementRef 解析为 Playwright Locator
 *
 * 支持单元素解析和多级嵌套链式解析（resolveChain）。
 * 引擎无关层：仅依赖 Playwright Locator API。
 */

import type { Locator, Page, FrameLocator } from '@playwright/test';
import type { ElementRef, ElementEntry, ElementFactory, DefinedPage, ElementHop } from './definePage.js';
import { isElementFactory } from './definePage.js';

// ─── Platform Hop Resolution (keve-wiki chain) ────────────────────────

/** class/shadow-dom hop value → css（支持空格分隔多 class，容忍 value 自带前导点） */
function classToCss(v: string): string {
  return String(v).trim().split(/\s+/).map((c) => `.${c.replace(/^\.+/, '')}`).join('');
}

/** hop → css 片段：selector 原样；id 补 #；shadow-dom 宿主按 class 定位（Playwright css 自动穿透 open shadow root） */
function hopToCss(t: string, v: string): string {
  if (t === 'selector') return v;
  if (t === 'id') return `#${v.replace(/^#/, '')}`;
  if (t === 'shadow-dom') return /^[.#[]/.test(v) ? v : classToCss(v);
  return classToCss(v);
}

/**
 * 平台定位链解析：按 hop 序列逐级收窄
 *
 * - selector → locator(css)
 * - class    → locator('.a.b')
 * - includes/text → locator('text=...')（在当前范围内找包含该文本的元素）
 * - label    → getByLabel（表单控件按可见标签定位，平台 label hop 37 处）
 * - iframe-url    → frameLocator（进入 iframe 上下文，src 部分匹配）
 * - javascript/source → 跳过（javascript 仅 WRITE_GLOBAL 场景由 engine.evaluate 处理）
 *
 * hop.index：1-based，-1/缺省表示不取序号。取序号时用 .nth(index-1) —— 平台侧
 * 91 处带 index 的跳，此前被整体忽略，导致命中第一个元素而非期望的第 N 个。
 */
function applyHops(page: Page, scope: Locator | FrameLocator | Page, hops: ElementHop[]): Locator {
  let cur: any = scope;
  let lastHop: { type: string; value: any } | null = null;
  for (const hop of hops) {
    const t = String(hop?.type || '');
    const v = hop?.value;
    if (t === 'javascript' || t === 'source' || t === '') continue;
    if (t === 'iframe-url') {
      const css = `iframe[src*="${String(v).replace(/"/g, '\\"')}"]`;
      cur = cur.frameLocator(css);
      lastHop = null; // iframe 本身不产生最终定位，重置
      continue;
    }
    if (t === 'selector' || t === 'id' || t === 'shadow-dom') {
      cur = cur.locator(hopToCss(t, String(v)));
    } else if (t === 'class') {
      cur = cur.locator(classToCss(String(v)));
    } else if (t === 'includes' || t === 'text') {
      const text = String(v).trim();
      // 「包含文本」语义：用 text= 引擎匹配「包含该文本的最小元素」。
      // 老实现 locator('*').filter({ hasText }) 只搜后代 —— 当文本是当前元素的
      // 直接文本节点（如 .tab-text「我创建的」）时后代为空，链路永久落空（点击等到超时）。
      // text= 引擎对「自身直挂文本」与「文本在后代元素」两类 DOM 都命中，
      // 且与老行为（点中文本所在叶子）兼容。
      cur = cur.locator('text=' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    } else if (t === 'label') {
      // 表单控件按可见标签定位（平台 label hop）。Playwright getByLabel 在
      // Locator/FrameLocator 上同样可用，语义与「找 label 文本对应的输入控件」一致。
      const label = String(v).trim();
      cur = cur.getByLabel(label, { exact: false });
    } else {
      throw new Error(`Unknown hop type '${t}' in chain: ${JSON.stringify(hop)}`);
    }
    // 序号收敛：1-based → .nth(index-1)；-1 / 0 / 非数字表示不取序号
    const idx = Number(hop?.index);
    if (Number.isFinite(idx) && idx > 0 && typeof cur?.nth === 'function') {
      cur = cur.nth(idx - 1);
    }
    lastHop = { type: t, value: v };
  }
  // iframe 进入后无后续定位跳：兜底取 frame 的 body
  if (!lastHop && hops.some((h) => String(h?.type || '') === 'iframe-url')) {
    cur = cur.locator('body');
  }
  if (!cur || typeof cur.locator !== 'function') {
    throw new Error(`Chain resolution produced a non-Locator: ${JSON.stringify(hops).slice(0, 200)}`);
  }
  return cur as Locator;
}

// ─── Single Element Resolution ────────────────────────────────────────

/**
 * 将单个 ElementRef 解析为 Playwright Locator
 *
 * 优先级：ref > role+name > css
 * 复合定位：hasText, has, notHas 在基础定位上叠加
 */
export function resolveElement(page: Page, ref: ElementRef): Locator {
  // 平台多跳定位链优先（keve-wiki 导出代码的原生形态）
  if (ref.chain && ref.chain.length > 0) {
    return applyHops(page, page, ref.chain);
  }

  let locator: Locator;

  if (ref.ref) {
    // AI 探索临时 ref（Playwright MCP 风格的 a11y ref）
    // 实际实现中需要通过 ariaSnapshot 映射，这里用 css 兜底
    locator = page.locator(`[data-ref="${ref.ref}"]`);
  } else if (ref.role) {
    // role + name 语义定位
    if (ref.name) {
      locator = page.getByRole(ref.role as any, { name: ref.name, exact: false });
    } else {
      locator = page.getByRole(ref.role as any);
    }
  } else if (ref.css) {
    locator = page.locator(ref.css);
  } else {
    throw new Error(`Invalid ElementRef: must have role, css, or ref. Got: ${JSON.stringify(ref)}`);
  }

  // 复合定位：hasText
  if (ref.hasText) {
    locator = locator.filter({ hasText: ref.hasText });
  }

  // 复合定位：has（包含子元素）
  if (ref.has) {
    const childLocator = resolveElement(page, ref.has);
    locator = locator.filter({ has: childLocator });
  }

  // 复合定位：notHas（不包含子元素）
  if (ref.notHas) {
    const childLocator = resolveElement(page, ref.notHas);
    locator = locator.filter({ hasNot: childLocator });
  }

  return locator;
}

// ─── Chain Resolution (Multi-level Nesting) ──────────────────────────

/**
 * 多级嵌套解析：按顺序在父元素范围内查找子元素
 *
 * resolveChain(page, parent, child)           → parent.locator(child)
 * resolveChain(page, a, b, c, d)             → a.locator(b).locator(c).locator(d)
 *
 * 支持 ElementRef 和 ElementEntry（工厂函数需先调用）
 */
export function resolveChain(page: Page, ...refs: (ElementRef | ElementEntry)[]): Locator {
  if (refs.length === 0) {
    throw new Error('resolveChain requires at least one element ref');
  }

  // 将所有 entry 规范化为 ElementRef
  const elements = refs.map((entry, _idx) => {
    if (isElementFactory(entry)) {
      throw new Error('Cannot use factory function in chain without calling it first. Call factory(item) before passing to resolveChain.');
    }
    return entry as ElementRef;
  });

  // 第一个元素：从 page 级定位
  let locator = resolveElement(page, elements[0]);

  // 后续元素：在父 locator 范围内定位
  for (let i = 1; i < elements.length; i++) {
    const childRef = elements[i];
    // 平台多跳定位链：在当前范围内继续 hop 解析
    if (childRef.chain && childRef.chain.length > 0) {
      locator = applyHops(page, locator, childRef.chain);
      continue;
    }
    // 子元素如果只有 hasText，用 filter；否则用 locator 链
    if (childRef.hasText && !childRef.role && !childRef.css && !childRef.ref) {
      locator = locator.filter({ hasText: childRef.hasText });
    } else if (childRef.role) {
      if (childRef.name) {
        locator = locator.getByRole(childRef.role as any, { name: childRef.name, exact: false });
      } else {
        locator = locator.getByRole(childRef.role as any);
      }
    } else if (childRef.css) {
      locator = locator.locator(childRef.css);
    } else if (childRef.ref) {
      locator = locator.locator(`[data-ref="${childRef.ref}"]`);
    } else {
      throw new Error(`Invalid chain element at position ${i}: ${JSON.stringify(childRef)}`);
    }

    // 复合定位叠加
    if (childRef.hasText && (childRef.role || childRef.css || childRef.ref)) {
      locator = locator.filter({ hasText: childRef.hasText });
    }
    if (childRef.has) {
      locator = locator.filter({ has: resolveElement(page, childRef.has) });
    }
    if (childRef.notHas) {
      locator = locator.filter({ hasNot: resolveElement(page, childRef.notHas) });
    }
  }

  return locator;
}

// ─── Convenience: Resolve from Page definition ────────────────────────

/**
 * 从 DefinedPage 中解析元素（自动处理工厂函数）
 *
 * resolveFromPage(page, 'saveButton')                                  → Locator
 * resolveFromPage(page, 'itemByName', '时间')                           → Locator（工厂调用）
 * resolveFromPage(page, 'dimensionList', ['itemByName', '时间'])       → 链式解析
 */
export function resolveFromPage(
  pwPage: Page,
  defPage: DefinedPage,
  ...keys: (string | any[])[]
): Locator {
  const refs: ElementRef[] = [];

  for (const key of keys) {
    if (typeof key === 'string') {
      const entry = defPage.elements[key];
      if (isElementFactory(entry)) {
        throw new Error(`Element '${key}' is a factory, needs args. Use [key, ...args] tuple.`);
      }
      refs.push(entry as ElementRef);
    } else if (Array.isArray(key)) {
      const [k, ...args] = key as [string, ...any[]];
      const entry = defPage.elements[k];
      if (!isElementFactory(entry)) {
        throw new Error(`Element '${k}' is not a factory, but args were provided.`);
      }
      refs.push((entry as ElementFactory)(...args));
    }
  }

  return resolveChain(pwPage, ...refs);
}
