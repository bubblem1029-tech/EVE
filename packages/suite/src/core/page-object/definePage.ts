/**
 * definePage — 代码化元素管理
 *
 * 扁平 key-value 元素定义，零运行时开销。
 * 嵌套关系由 step 级定位链（resolveChain）表达，不在 Page 内维护。
 *
 * Usage:
 *   import { definePage } from '@kkeve/suite';
 *
 *   export const myPage = definePage({
 *     elements: {
 *       saveButton: { role: 'button', name: '保存' },
 *       container:  { css: '.my-section' },
 *       // 动态元素工厂
 *       itemByName: (text: string) => ({ role: 'listitem', name: text }),
 *     },
 *     waitForReady: {
 *       api: '/api/list',
 *       ui: 'container',
 *     },
 *   });
 *
 *   // 在 spec 中引用
 *   await engine.click(myPage.elements.saveButton);
 *   await engine.click(myPage.elements.itemByName('时间'));
 */

// ─── ElementRef Types ────────────────────────────────────────────────

/** 平台定位链单跳（stepDsl context 的原生形态，keve-wiki 导出代码直接携带） */
export interface ElementHop {
  /** selector | class | id | shadow-dom | includes | text | label | iframe-url | javascript | source */
  type?: string;
  value?: any;
  index?: number;
}

export interface ElementRef {
  /** ARIA role 语义定位（优先） */
  role?: string;
  /** 可访问名称（配合 role 使用） */
  name?: string;
  /** CSS 选择器（fallback） */
  css?: string;
  /** AI 探索临时 ref 标识符（仅探索阶段） */
  ref?: string;
  /** 包含指定文本（复合定位） */
  hasText?: string;
  /** 包含指定子元素（复合定位） */
  has?: ElementRef;
  /** 不包含指定子元素（复合定位） */
  notHas?: ElementRef;
  /** 平台多跳定位链（selector/class/text/iframe-url 等原生 hop 序列，resolveElement 原生解析） */
  chain?: ElementHop[];
}

/** 动态元素工厂函数类型 */
export type ElementFactory = (...args: any[]) => ElementRef;

/** 元素注册表值类型：静态定义或动态工厂 */
export type ElementEntry = ElementRef | ElementFactory;

/** Page 元素注册表 */
export type ElementRegistry = Record<string, ElementEntry>;

// ─── Page Definition ─────────────────────────────────────────────────

export interface WaitForReady {
  /** 等待的关键 API 路径 */
  api?: string;
  /** 等待的 UI 元素 key（对应 elements 中的 key） */
  ui?: string;
}

/** 页面入口 URL（四环境值 + 默认参数，PageObject 归属；数据仍以平台变量表为单一数据源，pages 引用 testData） */
export interface PageUrlValue {
  name?: string;
  online?: string;
  pre?: string;
  rc?: string;
  test?: string;
  /** URL 模板 ${param} 占位符的默认值（步骤级 overrides 优先） */
  params?: Record<string, string>;
}

export interface PageDefinition {
  elements: ElementRegistry;
  waitForReady?: WaitForReady;
  /** 页面入口（PageObject 第一职责：页面坐标）。engine.openPage(page) 按 KEVE_ENV 解析并填充 ${param} */
  url?: PageUrlValue;
}

export interface DefinedPage extends PageDefinition {
  /** 唯一标识，用于调试 */
  __pageId: string;
  /** 元素引用快照（展开工厂后的静态部分） */
  __staticElements: Record<string, ElementRef>;
}

// ─── definePage Implementation ───────────────────────────────────────

let __pageCounter = 0;

export function definePage(def: PageDefinition): DefinedPage {
  const pageId = `page_${++__pageCounter}`;

  // 提取静态元素快照（非函数的元素）
  const staticElements: Record<string, ElementRef> = {};
  for (const [key, entry] of Object.entries(def.elements)) {
    if (typeof entry !== 'function') {
      staticElements[key] = entry;
    }
  }

  return {
    ...def,
    __pageId: pageId,
    __staticElements: staticElements,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * 判断元素引用是否为动态工厂函数
 */
export function isElementFactory(entry: ElementEntry): entry is ElementFactory {
  return typeof entry === 'function';
}

/**
 * 从 Page 中获取元素引用（如果是工厂，需要传参）
 * 不传参时返回工厂函数本身
 */
export function getElement(
  page: DefinedPage,
  key: keyof typeof page.elements
): ElementEntry {
  return page.elements[key as string];
}
