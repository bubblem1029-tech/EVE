/**
 * explore-repair —— 元素 DOM 链捕获（浏览器侧 evaluate）。
 *
 * 正常链路不导入本模块：探索修复（失败后旁路）由修复编排 spawn 的独立进程使用。
 * 捕获的链用于把 agent 的 aria-ref 动作还原成平台 context 定位跳（selector/class/text）。
 *
 * 平台合法跳类型（collectHops 口径）：selector / class / text（index 可选）。
 */

export interface DomChainHop {
  kind: 'selector' | 'class' | 'text';
  value: string;
}

/** 在浏览器里执行的函数体：从目标元素向上收集定位跳（最多 6 跳）。
 * 稳定跳优先（e2e 属性 → 非 hash class → 叶子文本）；全被过滤时允许「不稳定 class」兜底——
 * 有链总比没链强（css-xxx 模块类在单站点内常仍可定位），可写回性由校验环节决定。 */
export const CAPTURE_DOM_CHAIN_FN = `
(el) => {
  const UNSTABLE = /(^|[ _-])(css|[a-f0-9]{8,})([ _-]|$)/i;
  const out = [];
  for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 10; depth += 1, node = node.parentElement) {
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'html' || tag === 'body') break;
    const e2e = node.getAttribute('data-e2e-name') || node.getAttribute('data-testid') || node.getAttribute('data-test');
    if (e2e) {
      out.push({ kind: 'selector', value: '[data-e2e-name="' + e2e + '"]' });
      continue;
    }
    const classes = String(node.getAttribute('class') || '').split(/\\\\s+/).filter(Boolean);
    const stable = classes.filter((c) => !UNSTABLE.test(c));
    if (stable.length) {
      out.push({ kind: 'class', value: stable[0] });
      continue;
    }
    if (classes.length) {
      out.push({ kind: 'class', value: classes[0] });
      continue;
    }
    const text = String(node.textContent || '').trim();
    if (text && node.children.length === 0 && text.length <= 40) {
      out.push({ kind: 'text', value: text });
    }
  }
  return out.slice(0, 6);
}
`;

export interface CapturedChain {
  ref: string;
  hops: DomChainHop[];
  /** 目标元素的可读描述（role "name"），供生成步骤 text */
  describe?: string;
}
