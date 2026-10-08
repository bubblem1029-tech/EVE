/**
 * ops — 平台 DSL 算子 / 断言算子语义表
 *
 * 这张表的唯一用途是「可诊断」：生成器遇到不认识的算子时，报错信息能说清
 * 是「平台用了新算子」还是「这个算子本来就不该出现在可执行用例里」。
 *
 * 约束：本模块必须保持零依赖、零副作用 —— dsl/ 会同时被打进 Playwright 与
 * Cypress 的执行产物，不能引入 Node/框架依赖。
 */

/** 平台 stepDsl.operation 取值（来自 stepDsl 表 operation 列的真实分布） */
export const STEP_OPERATIONS = [
  'OPEN_PAGE',
  'REDIRECT_TO',
  'REFRESH_PAGE',
  'CLICK_ELEMENT',
  'DB_CLICK_ELEMENT',
  'FORCE_CLICK_ELEMENT',
  'CHECK_TEXT',
  'INPUT_ELEMENT',
  'MOVE_ELEMENT',
  'SCROLL',
  'DRAGGING',
  'CLEAN',
  'WAIT_EVENTS',
  'WAIT_RESPONSE',
  'WRITE_GLOBAL',
  'SCREEN_SHOT',
  'SCREENSHOT',
  'TAKE_SCREENSHOT',
] as const;

export type StepOperation = (typeof STEP_OPERATIONS)[number];

const STEP_OPERATION_SET: ReadonlySet<string> = new Set(STEP_OPERATIONS);

/** 是否为已知步骤算子（未知算子一律确定性失败，不静默跳过） */
export function isKnownOperation(op: string): boolean {
  return STEP_OPERATION_SET.has(String(op || ''));
}

/**
 * 断言算子（stepDsl.expectation[].type）。
 *
 * 语义分成两类，这个区分很关键：
 *  - 可执行断言：必须渲染成 engine 断言，失败即步骤失败
 *  - 纯文案载体：只有 text 没有可执行语义，仅喂给 keveGoal 的 expected，
 *    不产生任何断言（渲染成注释级信息）
 */

/** 可执行断言算子 */
export const ASSERT_OPERATIONS = [
  'ELEMENT_EXIST',
  'ELEMENT_NOT_EXIST',
  'ELEMENT_VISIBLE',
  'ELEMENT_NOT_VISIBLE',
  'TEXT_EXIST',
  'TEXT_NOT_EXIST',
  'TEXT_EQUAL',
  'EXPECTED_VALUE',
  'EXPECTED__PAGET_VALUE',
  'SCREEN_SHOT_COMPARE',
  'SCREENSHOT_COMPARE',
  'IMAGE_COMPARE',
] as const;

/**
 * 纯文案载体算子：不渲染断言。
 *
 * `TEXT` 是平台里占比最高的 expectation 类型（500+ 条），它只承载一句人话
 * （「列表提示无匹配」），没有任何可执行的定位/期望值。把它当未知算子抛错会
 * 让大批存量用例在生成期就失败 —— 它的语义本来就已经由 keveGoal 的 expected
 * 承载了。
 */
export const TEXT_ONLY_ASSERT_OPERATIONS = ['TEXT'] as const;

const ASSERT_OPERATION_SET: ReadonlySet<string> = new Set(ASSERT_OPERATIONS);
const TEXT_ONLY_SET: ReadonlySet<string> = new Set(TEXT_ONLY_ASSERT_OPERATIONS);

export function isKnownAssert(type: string): boolean {
  return ASSERT_OPERATION_SET.has(String(type || ''));
}

export function isTextOnlyAssert(type: string): boolean {
  return TEXT_ONLY_SET.has(String(type || ''));
}

/**
 * EXPECTED_VALUE 的受支持比较维度。
 * ctype 是「比什么」，cexpression 是「怎么比」（chai 风格，历史字段）。
 */
export const EXPECTED_VALUE_CTYPES = ['text', 'class', 'placeholder', 'style', 'index'] as const;

export const COMPARISON_EXPRESSIONS = ['include', 'eq', 'not.include', 'not.eq'] as const;

/** 历史字段 cexpression → 语义方向 */
export function parseComparison(cexpression: string): { mode: 'include' | 'eq'; negated: boolean } {
  const raw = String(cexpression || 'include').trim().toLowerCase();
  const negated = raw.startsWith('not.');
  const mode = raw.replace(/^not\./, '') === 'eq' ? 'eq' : 'include';
  return { mode, negated };
}
