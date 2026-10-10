/**
 * DSL → @kkeve/suite 装饰器脚本（纯投影，零 DB / 零框架依赖）
 *
 * 输入：**已展开、已解析**的 stepDsl 清单（内嵌场景已递归展开、source 元素库
 * 引用已解析成 locator 跳、变量已可查表）。输出：可被 Playwright 与 Cypress
 * 两个引擎同时执行的装饰器脚本源码。
 *
 * 为什么生成器放在 suite 包而不是调用方：
 *  1. 同一份 DSL 必须只投影出一种脚本 —— 两端报告一致的前提是执行体一致
 *  2. 探索期由 LLM 生成的 @kkeve/suite 脚本，后续要能回填成 DSL；正反变换
 *     放在同一个包里才闭得上环，否则两边算子语义会各自漂移
 *
 * 分层约定：本模块**不做任何 IO**。DB 装载、内嵌展开、元素库解析、变量表
 * 查询全部留在调用方的 service 层（见 keve 侧 dslLoader）。这样本模块可以被
 * Cypress 浏览器 bundle 直接引用。
 *
 * 关于「不支持就报错」：未知算子渲染成确定性 throw，而不是静默跳过 —— 静默
 * 跳过会让报告出现「验证通过」的假绿。但**已知的纯文案载体**（TEXT 断言、
 * 无 type 的 expectation）不是未知算子，它们只喂 expected 文案，不产生断言。
 */

import {
  isKnownOperation,
  isKnownAssert,
  isTextOnlyAssert,
  parseComparison,
} from './ops.js';

// ─── 输入 / 输出类型 ──────────────────────────────────────────────────

/** 平台定位跳（context / expectation.context 的元素） */
export interface DslHop {
  type?: string;
  value?: any;
  /** 历史字段：部分步骤把定位写在 selector 上 */
  selector?: string;
  /** 1-based；-1 / undefined 表示不取第几个 */
  index?: number;
}

/** 平台 DSL 值：字面量或 { type, value } 包装 */
export type DslValue =
  | string
  | number
  | null
  | undefined
  | { type?: string; value?: any; variable?: Array<{ key: string; value: any }> };

/** 一条断言 / 预期 */
export interface DslExpectation {
  text?: string;
  type?: string;
  /** 比较维度：text | class | placeholder | style | index | url | title */
  ctype?: string;
  /** 比较方式：include | eq | not.include（chai 风格历史字段） */
  cexpression?: string;
  value?: DslValue;
  context?: DslHop[];
  baseImgUrl?: string;
}

/** 一条步骤 */
export interface DslStep {
  id?: number;
  operation?: string | null;
  text?: string;
  value?: DslValue;
  context?: DslHop[];
  wait?: Array<{ waitType?: string; value?: any }>;
  expectation?: DslExpectation[];
  /** 拖拽目标 / 嵌套上下文 */
  child?: any;
  urlPart?: string;
}

/** 变量表行（按环境列取值） */
export interface DslVariableRow {
  id?: number;
  name?: string;
  variable?: Array<{ key: string; value: any }>;
  [env: string]: any;
}

export interface ToDecoratorOptions {
  /** 平台 stepGroup id（用于生成稳定类名 / 场景 id） */
  stepGroupId: number;
  caseName: string;
  /** 已展开的 DSL 步骤清单 */
  dslList: DslStep[];
  /** 变量取值环境列名（test / rc / pre / online） */
  env: string;
  /** 变量表（按 id 或 name 引用） */
  variableList?: DslVariableRow[];
  /** 账号占位插值：${loginName} / ${pwd} */
  account?: { name: string; password: string };
  /** 是否已注入 SSO cookie（仅写进注释，供执行现场排查） */
  ssoInject?: boolean;
  /** import 来源，默认 @kkeve/suite/keve-test */
  importFrom?: string;
}

// ─── 生成入口 ────────────────────────────────────────────────────────

/** 生成装饰器脚本源码（UTF-8 文本） */
export function toDecorator(options: ToDecoratorOptions): string {
  const { stepGroupId, caseName, dslList, env, account } = options;
  const ctx: RenderCtx = {
    env,
    variableList: options.variableList || [],
    account,
  };
  const lines: string[] = [];
  const L = (s: string) => lines.push(s);

  L(`// ⚠️ 自动生成 —— 勿手改：改平台 DSL（stepGroup ${stepGroupId}）后重新生成`);
  L(`// 源: stepGroup ${stepGroupId}「${caseName}」→ @kkeve/suite 装饰器投影`);
  L(`// 环境: ${env} / 账号: ${account ? account.name : '无'} / SSO 注入: ${options.ssoInject ? '开' : '关'}`);
  L(`import { keveModel, keveScene } from '${options.importFrom || '@kkeve/suite/keve-test'}';`);
  L('');
  L(`// 平台定位链透传：context 多跳 → ElementRef.chain`);
  L(`const C = (...hops: any[]) => ({`);
  L(`  chain: hops.filter(h => h && String(h.type || '') !== '' && String(h?.value ?? '') !== '')`);
  L(`});`);
  L('');
  L(`@keveModel('M_SG${stepGroupId}', ${q(caseName)})`);
  L(`export class Model_SG${stepGroupId} {`);
  L(`  @keveScene('S${stepGroupId}', ${q(`${caseName}（源 DSL 转译）`)})`);
  L(`  static async scene_SG${stepGroupId}({ engine, keveGoal }: any) {`);

  for (let i = 0; i < dslList.length; i++) {
    const d = dslList[i];
    const op = String(d?.operation || '');

    // 就绪门预注册：OPEN_PAGE 后紧跟的 WAIT_RESPONSE 必须合并进导航步骤体
    //（先注册监听、再导航），否则导航期间到达的响应会因「先导航后注册」而丢失。
    if (op === 'OPEN_PAGE') {
      let j = i + 1;
      const gates: DslStep[] = [];
      while (j < dslList.length && String(dslList[j]?.operation || '') === 'WAIT_RESPONSE') {
        gates.push(dslList[j++]);
      }
      if (gates.length) {
        const seg = renderOpenPageWithGates(d, gates, ctx);
        if (seg.length) appendBlock(lines, seg);
        i = j - 1;
        continue;
      }
    }

    const seg = renderStep(d, ctx);
    if (seg.length) appendBlock(lines, seg);
  }

  L(`  }`);
  L(`}`);
  L('');
  return lines.join('\n');
}

function appendBlock(lines: string[], seg: string[]): void {
  lines.push('');
  for (const s of seg) lines.push(s);
}

// ─── 步骤转译 ────────────────────────────────────────────────────────

interface RenderCtx {
  env: string;
  variableList: DslVariableRow[];
  account?: { name: string; password: string };
}

function renderStep(d: DslStep, ctx: RenderCtx): string[] {
  const op = d.operation as string | null;
  // operation 为空 = 内嵌场景引用：正常路径下装载器已递归展开，走到这里说明
  // 展开漏了（如引用了空场景）。静默跳过会让后续步骤在错误页面上跑，故显式报错。
  if (!op) {
    return [
      `throw new Error(${q(`内嵌场景引用未展开（步骤「${String(d.text || '')}」，id=${d.id ?? '未知'}）`)});`,
    ];
  }
  if (!isKnownOperation(op)) {
    return [
      `throw new Error(${q(
        `不支持的 DSL 操作「${op}」: ${String(d.text || '')} —— 请移除该步骤，或先为该算子补齐转译规则`,
      )});`,
    ];
  }

  const out: string[] = [];
  const stepText = String(d.text || op);
  const expTexts = (d.expectation || []).map((e) => String(e.text || '')).filter(Boolean);
  const expected = expTexts.length ? expTexts.join('；') : '操作完成，页面正常响应';
  const chain = chainExpr(d.context);
  const expLines: string[] = [];
  for (const e of d.expectation || []) {
    const a = renderExpectation(e, ctx);
    if (a) expLines.push(a);
  }

  const emit = (body: string[]) => {
    out.push(`await keveGoal({ step: ${q(stepText)}, expected: ${q(expected)}${reactOption(d)} }, async () => {`);
    for (const b of [...body, ...expLines]) out.push(`  ${b}`);
    out.push(`});`);
  };

  switch (op) {
    case 'OPEN_PAGE': {
      const resolved = resolveOpenPage(d, ctx);
      const body: string[] = [];
      if (resolved.url) {
        body.push(`// 目标页面解析来源: ${resolved.via}`);
        body.push(`await engine.navigate(${q(resolved.url)});`);
      } else {
        body.push(
          `throw new Error(${q(
            `OPEN_PAGE 无法解析有效 URL（步骤文案「${stepText}」，value=${JSON.stringify(d.value)}）`
              + ' —— 该步骤未配置页面变量，且文案未能匹配到变量表中的页面模板',
          )});`,
        );
      }
      body.push(...waitExprs(d));
      emit(body);
      break;
    }
    case 'REDIRECT_TO': {
      // 历史算子：目标 URL 常在 value，也可能写在步骤文案的引号里
      const direct = resolveValue(d.value, ctx);
      const fromText = /[「"'“]([^」"'”]{4,})[」"'”]/.exec(String(d.text || ''))?.[1] || '';
      const raw = direct || fromText;
      const url = /^https?:\/\//i.test(raw) ? raw : raw ? `https://${raw}` : '';
      if (!url) {
        throw new Error(`REDIRECT_TO 未解析到目标 URL: ${stepText}`);
      }
      emit([`await engine.navigate(${q(url)});`, ...waitExprs(d)]);
      break;
    }
    case 'CLICK_ELEMENT':
      emit([`await engine.click(${chain});`, ...waitExprs(d)]);
      break;
    case 'FORCE_CLICK_ELEMENT':
      emit([`await engine.forceClick(${chain});`, ...waitExprs(d)]);
      break;
    case 'DB_CLICK_ELEMENT':
      emit([`await engine.dblClick(${chain});`, ...waitExprs(d)]);
      break;
    case 'CHECK_TEXT': {
      // 平台把「校验文案」建模成一个步骤，真正的期望放在 expectation 里
      // （type=TEXT_EXIST）。所以这里不产生操作体，只让 expLines 生效。
      // 少数步骤把待检文案直接放在 value：此时补一条包含断言，与老引擎
      // cy.contains(value).should('be.visible') 语义对齐。
      const val = resolveValue(d.value, ctx);
      emit(val ? [`await engine.expectText(${q(val)}, ${chain});`] : []);
      break;
    }
    case 'INPUT_ELEMENT': {
      const val = resolveValue(d.value, ctx);
      if (!val) {
        throw new Error(`INPUT_ELEMENT 缺少输入值，拒绝生成可误报通过的跳过步骤: ${stepText}`);
      }
      emit([`await engine.type(${q(val)}, ${chain});`, ...waitExprs(d)]);
      break;
    }
    case 'MOVE_ELEMENT':
      emit([`await engine.hover(${chain});`, ...waitExprs(d)]);
      break;
    case 'SCROLL':
      emit([`await engine.scroll(${chain});`, ...waitExprs(d)]);
      break;
    case 'CLEAN':
      emit([`await engine.clear(${chain});`, ...waitExprs(d)]);
      break;
    case 'WAIT_EVENTS': {
      // 元素就绪门：context 带 selector 时按元素真实状态等待，不退化成固定延时
      const sel = firstContextSelector(d.context);
      if (sel) {
        const budget = Math.round(waitMs(d) || 10000);
        emit([`await engine.waitForElement(${q(sel)}, { timeout: ${budget} });`]);
        break;
      }
      const ms = waitMs(d);
      if (ms > 0) emit([`await engine.wait(${ms});`]);
      else throw new Error(`WAIT_EVENTS 缺少有效时长或目标元素: ${stepText}`);
      break;
    }
    case 'WAIT_RESPONSE': {
      const urlPart = resolveValue(d.value, ctx) || String(d.urlPart || '');
      if (!urlPart) {
        throw new Error(`WAIT_RESPONSE 缺少目标 URL，拒绝生成可误报通过的跳过步骤: ${stepText}`);
      }
      const opts = waitResponseOptions(d);
      emit([`await engine.waitForResponse(${q(urlPart)}${opts});`]);
      break;
    }
    case 'REFRESH_PAGE':
      emit([`await engine.refresh();`, ...waitExprs(d)]);
      break;
    case 'DRAGGING': {
      // 拖拽：context 为源，value/child 携带目标链；缺失目标不得伪装成悬停成功
      const valueCtx = (typeof d.value === 'object' && d.value !== null ? (d.value as any).context : undefined);
      const targetCtx = valueCtx || d.child?.context || d.child;
      if (Array.isArray(targetCtx) && targetCtx.length) {
        emit([`await engine.drag(${chain}, ${chainExpr(targetCtx)});`, ...waitExprs(d)]);
      } else {
        throw new Error(`DRAGGING 缺少目标元素，拒绝退化为悬停: ${stepText}`);
      }
      break;
    }
    case 'WRITE_GLOBAL': {
      // 真实数据里表达式写在 context 的 javascript 跳上，value 只是变量名
      const jsHop = firstHopOfType(d.context, 'javascript');
      const expr = jsHop ? String(jsHop.value ?? '') : resolveValue(d.value, ctx) || (typeof d.child === 'string' ? d.child : d.child?.value);
      if (expr) emit([`await engine.evaluate(${q(String(expr))});`]);
      else throw new Error(`WRITE_GLOBAL 缺少表达式: ${stepText}`);
      break;
    }
    case 'SCREEN_SHOT':
    case 'SCREENSHOT':
    case 'TAKE_SCREENSHOT': {
      // 平台截图步骤 → 基线对比断言（无基线建候选，超阈值抛 ScreenshotDiffError）
      const shotName = resolveValue(d.value, ctx) || sanitizeShotKey(stepText);
      const shotChain = chainExprOrNull(d.context);
      // 区域截图容错：元素不在当前页面（权限阻断等）时降级为整页截图，
      // 是否一致由基线比对决定，截图本身不做权限硬门。
      if (shotChain) {
        out.push(`await keveGoal({ step: ${q(stepText)}, expected: ${q(expected)}${reactOption(d)} }, async () => {`);
        out.push(`  try {`);
        out.push(`    await engine.screenshot(${q(shotName)}, ${shotChain});`);
        out.push(`  } catch (_shotErr: any) {`);
        out.push(`    // 区域截图失败（元素不在页面上，如权限阻断/加载异常）—— 降级为整页截图`);
        out.push(`    if (/timeout|waiting.*locator|not found|no element/i.test(String(_shotErr?.message || ''))) {`);
        out.push(`      console.warn('[dsl] 区域截图降级为整页截图:', ${q(shotName)}, _shotErr?.message);`);
        out.push(`      await engine.screenshot(${q(shotName)});`);
        out.push(`    } else { throw _shotErr; }`);
        out.push(`  }`);
        for (const e of d.expectation || []) {
          const a = renderExpectation(e, ctx);
          if (a) out.push(`  ${a}`);
        }
        out.push(`});`);
      } else {
        emit([`await engine.screenshot(${q(shotName)});`, ...waitExprs(d)]);
      }
      break;
    }
    default:
      // isKnownOperation 已放行全部已知算子；走到这里说明表与 switch 不同步
      emit([
        `throw new Error(${q(
          `算子「${op}」已在算子表登记但缺少转译实现: ${stepText} —— 请补齐 toDecorator 的 switch 分支`,
        )});`,
      ]);
  }
  return out;
}

/**
 * OPEN_PAGE + 紧随其后的 WAIT_RESPONSE 就绪门，合并为一个 keveGoal 步骤。
 *
 * 预注册时序：
 *   const __gate0 = engine.waitForResponse(urlPart, {...});  // 调用瞬间同步注册监听
 *   await engine.navigate(url);                             // 然后才触发导航
 *   await __gate0;                                          // 导航期间的响应也能命中
 */
function renderOpenPageWithGates(d: DslStep, gates: DslStep[], ctx: RenderCtx): string[] {
  const out: string[] = [];
  const stepText = String(d.text || 'OPEN_PAGE');
  const gateTexts = gates.map((g) => String(g.text || '')).filter(Boolean);
  const gateExpects = gates
    .flatMap((g) => (g.expectation || []).map((e) => String(e.text || '')))
    .filter(Boolean);
  const expected =
    [...gateTexts, ...gateExpects].filter(Boolean).join('；') || '打开目标页面并等待就绪响应';
  const resolved = resolveOpenPage(d, ctx);
  const body: string[] = [];
  if (!resolved.url) {
    body.push(
      `throw new Error(${q(
        `OPEN_PAGE 无法解析有效 URL（步骤文案「${stepText}」，value=${JSON.stringify(d.value)}）`
          + ' —— 该步骤未配置页面变量，且文案未能匹配到变量表中的页面模板',
      )});`,
    );
  } else {
    gates.forEach((g, gi) => {
      const urlPart = resolveValue(g.value, ctx) || String(g.urlPart || '');
      if (!urlPart) return; // 就绪门无目标 URL 时跳过注册，由普通 WAIT_RESPONSE 分支报错
      body.push(`const __gate${gi} = engine.waitForResponse(${q(urlPart)}${waitResponseOptions(g)}); // 预注册就绪门`);
    });
    body.push(`// 目标页面解析来源: ${resolved.via}`);
    body.push(`await engine.navigate(${q(resolved.url)});`);
    gates.forEach((g, gi) => {
      const urlPart = resolveValue(g.value, ctx) || String(g.urlPart || '');
      if (urlPart) body.push(`await __gate${gi}; // 等 ${String(g.text || '就绪响应')}`);
    });
  }
  out.push(`await keveGoal({ step: ${q(stepText)}, expected: ${q(expected)}${reactOption(d)} }, async () => {`);
  for (const b of body) out.push(`  ${b}`);
  out.push(`});`);
  return out;
}

// ─── 断言转译 ────────────────────────────────────────────────────────

/**
 * 步骤是否只有「纯文案期望」，必须依赖 LLM 才能判定。
 *
 * 平台 DSL 里有两类 expectation：
 *  - 可执行断言（ELEMENT_NOT_EXIST / TEXT_EXIST …）→ 转译成 engine 断言，
 *    成败在脚本里已经确定，无需再看页面；
 *  - 纯文案载体（TEXT / 无 type）→ 不产生任何断言，只以文字描述预期，
 *    脚本无法自证，只能交给 Agent 观察页面后判定。
 *
 * 只有第二类（且该步骤没有可执行断言）才需要保留 Agent Re-Act。
 */
function needsAgentJudge(d: DslStep): boolean {
  const expects = d.expectation || [];
  if (!expects.length) return false;
  const hasExecutable = expects.some((e) => {
    const type = String(e.type || '');
    return type && !isTextOnlyAssert(type);
  });
  if (hasExecutable) return false;
  return expects.some((e) => {
    const type = String(e.type || '');
    return !type || isTextOnlyAssert(type);
  });
}

/**
 * keveGoal 的 react 参数片段。
 *
 * 平台 DSL 是确定性录制产物：凡能自证的步骤都显式 react: false，跳过 Agent
 * Re-Act —— 否则每个步骤都会额外发起一轮 LLM 探索，既拖长整体耗时至超出
 * Cypress 用例超时（表现为「任务卡住」），也会让「报错1」这类仅作平台标签的
 * expected 文案参与最终结论。
 */
function reactOption(d: DslStep): string {
  return needsAgentJudge(d) ? '' : ', react: false';
}

/** 渲染一条 expectation；返回 null 表示「纯文案载体，不产生断言」 */
function renderExpectation(e: DslExpectation, ctx: RenderCtx): string | null {
  const type = String(e.type || '');

  // 无 type / TEXT：纯「期望文案」载体，只喂 keveGoal.expected，不是断言
  if (!type || isTextOnlyAssert(type)) return null;

  const comment = e.text ? ` // ${e.text}` : '';
  const chain = chainExpr(e.context);
  const val = resolveExpectationValue(e, ctx);

  if (!isKnownAssert(type)) {
    // 未知断言不得静默跳过（旧实现只吐注释 = 断言不执行，是假绿的来源之一）
    return `throw new Error(${q(
      `不支持的断言类型「${type}」: ${e.text || ''} —— 请移除该断言，或先为该类型补齐转译规则`,
    )});`;
  }

  switch (type) {
    case 'ELEMENT_EXIST':
      return `await engine.expectExists(${chain});${comment}`;
    case 'ELEMENT_NOT_EXIST':
      return `await engine.expectNotExists(${chain});${comment}`;
    case 'ELEMENT_VISIBLE':
      return `await engine.expectVisible(${chain});${comment}`;
    case 'ELEMENT_NOT_VISIBLE':
      return `await engine.expectHidden(${chain});${comment}`;
    case 'TEXT_EXIST':
      // 平台把「校验页面标题包含 X」也存成 TEXT_EXIST + 默认 body 上下文。
      // 直接断言 body 文本会把标题里的命中判成失败（页面标题 ≠ 正文文案），
      // 按步骤/断言文案识别出页面标题语义，落到 title 维度。
      if (isPageTitleAssertion(e)) {
        return `await engine.expectTitle(${q(val)});${comment}`;
      }
      return `await engine.expectText(${q(val)}, ${chain});${comment}`;
    case 'TEXT_NOT_EXIST':
      // 平台里存在「只打开页面」类用例：断言存成 TEXT_NOT_EXIST 但期望值为空串。
      // 空串对任何页面都成立，属于无实际约束的占位断言；若照原样下发会变成
      // 「body 文本不包含空串」并永远失败（旧 Cypress 编译器同样只在期望值非空时
      // 才生成 text-absent 校验）。这里按同一语义跳过。
      if (!String(val || '').trim()) return null;
      return `await engine.expectNotText(${q(val)}, ${chain});${comment}`;
    case 'TEXT_EQUAL':
      return `await engine.expectTextEquals(${q(val)}, ${chain});${comment}`;
    case 'EXPECTED_VALUE':
      return renderExpectedValue(e, val, chain, comment);
    case 'EXPECTED__PAGET_VALUE':
      return renderPageValue(e, val, comment);
    case 'SCREEN_SHOT_COMPARE':
    case 'SCREENSHOT_COMPARE':
    case 'IMAGE_COMPARE': {
      // value 为基线 key（老平台基线 id 可回溯迁移来源）
      const shotName = String(val || e.text || '').trim() || sanitizeShotKey(e.text || 'baseline');
      const shotChain = chainExprOrNull(e.context);
      if (shotChain) {
        return [
          `try { await engine.screenshot(${q(shotName)}, ${shotChain}); }`,
          `catch (_shotErr: any) {`,
          `  if (/timeout|waiting.*locator|not found|no element/i.test(String(_shotErr?.message || ''))) {`,
          `    console.warn('[dsl] 区域截图降级为整页截图:', ${q(shotName)}, _shotErr?.message);`,
          `    await engine.screenshot(${q(shotName)});`,
          `  } else { throw _shotErr; }`,
          `}`,
        ].join(' ');
      }
      return `await engine.screenshot(${q(shotName)});${comment}`;
    }
    default:
      return `throw new Error(${q(
        `断言「${type}」已在算子表登记但缺少转译实现: ${e.text || ''} —— 请补齐 toDecorator`,
      )});`;
  }
}

/**
 * 判断一条断言表达的是「页面标题」而不是正文文本。
 *
 * 历史数据（stepDsl.expectation）里没有独立的 title 断言类型：
 * 「校验页面标题包含 EVE」被存成 TEXT_EXIST，且 context 为空 → 投影时默认成
 * body 定位，语义从「标题」漂移成「正文」。这里只在文案明确提到页面标题、
 * 且没有显式元素上下文时才改判，避免影响真正的正文断言。
 */
function isPageTitleAssertion(e: DslExpectation): boolean {
  if (String(e?.ctype || '').toLowerCase() === 'title') return true;
  if (collectHops(e?.context).length) return false;
  const text = `${e?.text || ''}`;
  return /页面\s*标题|网页\s*标题|page\s*title/i.test(text);
}

/**
 * EXPECTED_VALUE：比「元素某个属性/文本」与期望值的关系。
 *
 * 真实数据里出现的组合（ctype | cexpression）：
 *   text  | include / eq       （52 条）
 *   class | include / not.include（15 条）
 * 另留 placeholder / style / index 三个历史维度。
 */
function renderExpectedValue(
  e: DslExpectation,
  val: string,
  chain: string,
  comment: string,
): string {
  const ctype = String(e.ctype || 'text').toLowerCase();
  const { mode, negated } = parseComparison(String(e.cexpression || 'include'));

  switch (ctype) {
    case 'text':
      if (mode === 'eq') {
        return negated
          ? `await engine.expectTextNotEquals(${q(val)}, ${chain});${comment}`
          : `await engine.expectTextEquals(${q(val)}, ${chain});${comment}`;
      }
      return negated
        ? `await engine.expectNotText(${q(val)}, ${chain});${comment}`
        : `await engine.expectText(${q(val)}, ${chain});${comment}`;
    case 'class':
      return negated
        ? `await engine.expectNotClass(${q(val)}, ${chain});${comment}`
        : `await engine.expectClass(${q(val)}, ${chain});${comment}`;
    case 'placeholder':
      return `await engine.expectAttribute(${q('placeholder')}, ${q(val)}, ${chain});${comment}`;
    case 'style':
      return mode === 'eq'
        ? `await engine.expectAttribute(${q('style')}, ${q(val)}, ${chain});${comment}`
        : `await engine.expectAttributeContains(${q('style')}, ${q(val)}, ${chain});${comment}`;
    case 'index': {
      // index + eq：数「文本非空的元素个数」
      const n = Number(val);
      if (!Number.isFinite(n)) {
        return `throw new Error(${q(`EXPECTED_VALUE(ctype=index) 的期望值不是数字: ${val}`)});`;
      }
      return `await engine.expectNonEmptyCount(${n}, ${chain});${comment}`;
    }
    default:
      // 维度未知时不能当成通过 —— 但也不能硬失败：ctype 缺失的历史数据按 text 处理，
      // 明确写了未知维度的才报错。
      if (!e.ctype) {
        return `await engine.expectText(${q(val)}, ${chain});${comment}`;
      }
      return `throw new Error(${q(
        `不支持的 EXPECTED_VALUE 比较维度「${ctype}」: ${e.text || ''} —— 请改用 text/class/placeholder/style/index`,
      )});`;
  }
}

/**
 * EXPECTED__PAGET_VALUE：比页面级属性（历史拼写错误，保留原名）。
 * 真实数据里只有 ctype=url + cexpression=eq。
 */
function renderPageValue(e: DslExpectation, val: string, comment: string): string {
  const ctype = String(e.ctype || 'url').toLowerCase();
  const { mode, negated } = parseComparison(String(e.cexpression || 'eq'));
  if (ctype === 'url') {
    if (mode === 'eq') {
      return negated
        ? `await engine.expectUrlNotEquals(${q(val)});${comment}`
        : `await engine.expectUrlEquals(${q(val)});${comment}`;
    }
    return negated
      ? `await engine.expectUrlNotContains(${q(val)});${comment}`
      : `await engine.expectUrlContains(${q(val)});${comment}`;
  }
  if (ctype === 'title') {
    return mode === 'eq'
      ? `await engine.expectTitleEquals(${q(val)});${comment}`
      : `await engine.expectTitle(${q(val)});${comment}`;
  }
  return `throw new Error(${q(
    `不支持的页面属性断言维度「${ctype}」: ${e.text || ''} —— 请改用 url/title`,
  )});`;
}

// ─── 值 / 链解析 ─────────────────────────────────────────────────────

/**
 * OPEN_PAGE 目标页面解析（三级）：
 *  1) 步骤自带 value → 直接解析
 *  2) value 缺失（平台存在大量 value=NULL 的「页面向导」步骤）→ 按步骤文案关键词
 *     匹配变量表中的页面模板，并做 ${key} 参数替换
 *  3) 仍无解 → 返回空，由调用方生成显式报错（避免空白页导致后续步骤集体超时）
 */
function resolveOpenPage(d: DslStep, ctx: RenderCtx): { url: string; via: string } {
  const direct = resolveValue(d.value, ctx);
  if (/^https?:\/\//i.test(direct)) return { url: direct, via: 'value' };

  const text = String(d.text || '');
  if (text) {
    const row = pickVariableByStepText(text, ctx.variableList);
    if (row) {
      const url = buildVariableUrl(row, ctx.env, textOverrides(text), d.value);
      if (/^https?:\/\//i.test(url)) return { url, via: `文案匹配变量「${row.name}」` };
    }
  }
  return { url: '', via: '' };
}

/**
 * 步骤文案关键词 → 变量表页面名片段。
 * 顺序敏感：更具体的模式必须排在前面。
 *
 * ⚠️ 这张表是页面模板的**启发式兜底**，只在 DSL 没有显式绑定页面变量时生效。
 * 新增页面时优先在可视化编辑器里显式绑定变量，而不是往这里加关键词。
 */
const PAGE_KEYWORD_MAP: Array<[RegExp, string]> = [
  [/数据准备数据集.*(编辑|模型编辑)|数据集.*编辑页|数据集编辑页/, '数据准备数据集-编辑页'],
  [/数据准备数据集.*预览|数据集.*预览/, '数据准备数据集-预览页'],
  [/天策业务门户|业务门户/, '天策业务门户'],
  [/天策个人门户|个人门户/, '天策个人门户'],
  [/看板洞察|洞察/, '看板洞察页面'],
  [/看板编辑|看板.*编辑|编辑页|编辑态/, '看板编辑页'],
  [/看板预览|看板.*预览|预览页|预览态/, '看板预览页'],
  [/智能应用管理/, '智能应用管理页面'],
  [/Agent\s*编辑/, 'Agent编辑页'],
  [/Agent\s*体验/, 'Agent体验页'],
  [/天玑/, '天玑主页'],
  [/KwaiBook\s*管理/, 'KwaiBook管理页'],
  [/KwaiBook\s*编辑/, 'KwaiBook编辑页'],
  [/KwaiBook\s*独立/, 'KwaiBook独立页'],
  [/KwaiBook/, 'KwaiBook首页'],
  [/看板列表|可视化看板列表|可视化首页|看板管理|我的看板/, '可视化首页'],
  [/移动端看板/, '移动端看板'],
  [/大屏/, '大屏'],
  [/组件市场/, '组件市场'],
  [/指标取数/, '指标取数'],
  [/SQL\s*取数|自助取数/, 'SQL取数'],
  [/取数/, '取数'],
  [/多维分析|多维|olap/i, '多维'],
  [/数据准备数据集|数据集管理/, '数据准备数据集'],
  [/数据集/, '数据集'],
  [/数据接入/, '数据接入'],
  [/KIM\s*推送|推送页面|推送/, '推送'],
  [/活动页面|可视化-活动|新建活动/, '活动'],
  [/数据应用/, '数据应用'],
  [/门户/, '门户'],
  [/KwaiBI\s*首页|KwaiBI首页/, 'KwaiBI首页'],
  [/KwaiData/, 'KwaiData首页'],
  [/[（(]\s*\d+\s*\/\s*\d+\s*[)）]/, '看板预览页'],
];

/** 文案中的参数覆盖值：`key=value` + `（dashboardId/sheetId）` 定位对 */
function textOverrides(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pair = /[（(]\s*(\d+)\s*\/\s*(\d+)\s*(?:\/\s*([^)）]*))?[)）]/.exec(text);
  if (pair) {
    out.dashboardId = pair[1];
    out.sheetId = pair[2];
  }
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z0-9_\-.:/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

/** 按步骤文案挑选变量表中的页面模板（同区域优先） */
function pickVariableByStepText(text: string, variableList: DslVariableRow[]): DslVariableRow | null {
  if (!Array.isArray(variableList) || !variableList.length) return null;
  const wantOversea = /海外|\bsgp\b/i.test(text);
  for (const [re, phrase] of PAGE_KEYWORD_MAP) {
    if (!re.test(text)) continue;
    const cands = variableList.filter((r) => typeof r.name === 'string' && String(r.name).includes(phrase));
    if (!cands.length) continue;
    const sameRegion = cands.filter((r) => (wantOversea ? /海外/.test(String(r.name)) : !/海外/.test(String(r.name))));
    const pool = sameRegion.length ? sameRegion : cands;
    const domestic = pool.filter((r) => /国内/.test(String(r.name)));
    const pickFrom = domestic.length ? domestic : pool;
    return pickFrom.slice().sort((a, b) => String(a.name).length - String(b.name).length)[0];
  }
  return null;
}

/** 变量行 → 目标 URL（按环境列取值 + 占位符替换） */
function buildVariableUrl(
  row: DslVariableRow,
  env: string,
  overrides: Record<string, string>,
  stepValue: DslValue,
): string {
  const raw = pickVariableValue(row, env);
  const kv = new Map<string, string>();
  for (const item of row.variable || []) {
    if (item && item.key !== undefined) kv.set(String(item.key), String(item.value ?? ''));
  }
  const stepVar = stepValue && typeof stepValue === 'object' ? stepValue.variable : undefined;
  for (const item of stepVar || []) {
    if (item && item.key !== undefined) kv.set(String(item.key), String(item.value ?? ''));
  }
  for (const [k, v] of Object.entries(overrides || {})) kv.set(k, v);
  let url = String(raw ?? '').replace(/\$\{([^}]+)}/g, (m, k: string) =>
    kv.has(k) ? String(kv.get(k)) : m,
  );
  // 模板把 id 写成字面量查询参数时 ${key} 替换无效，需直接改写同名查询参数
  for (const [k, v] of kv) {
    if (!v || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
    const re = new RegExp(`([?&])${k}=[^&#]*`);
    if (re.test(url)) url = url.replace(re, `$1${k}=${v}`);
  }
  return url;
}

/**
 * 变量行取值（按环境列）。
 *
 * 老系统语义是 `row[env]` 直取，但平台数据里存在两类情况必须兼容：
 *  1) env 列填的是占位值（如 test 列 = "1"，表示该环境未单独配置）→ 回退真实地址列
 *  2) 地址列含 `${shareId}` 等占位符 → 交给调用方做变量替换
 */
function pickVariableValue(row: DslVariableRow, env: string): string {
  const cols = [env, 'test', 'online', 'rc', 'pre'];
  const isUrl = (x: any) => typeof x === 'string' && /^https?:\/\//i.test(x.trim());
  const isPlaceholder = (x: any) => /^(1|0|true|false)$/i.test(String(x ?? '').trim());
  for (const c of cols) if (isUrl(row[c])) return String(row[c]);
  for (const c of cols) {
    const val = row[c];
    if (typeof val === 'string' && val.trim() && !isPlaceholder(val)) return val;
  }
  return String(row[env] ?? '');
}

/** DSL value → 字面量：CUSTOM 插值账号占位；VARIABLE 查变量表取环境列 */
function resolveValue(v: DslValue, ctx: RenderCtx): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  const raw = String(v.value ?? '');
  if (v.type === 'VARIABLE') {
    const row = ctx.variableList.find((r) => Number(r.id) === Number(raw));
    if (!row) return '';
    return buildVariableUrl(row, ctx.env, {}, v);
  }
  // CUSTOM：插值账号占位 + 按变量名引用变量表
  const interpolated = raw
    .replace(/\$\{loginName\}/g, ctx.account?.name ?? '')
    .replace(/\$\{pwd\}/g, ctx.account?.password ?? '');
  return interpolated.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => {
    const row = (ctx.variableList || []).find((r) => String(r.name) === String(name));
    if (!row) return m;
    const u = buildVariableUrl(row, ctx.env, {}, v);
    return u || m;
  });
}

/** 断言取期望值：VARIABLE 优先查 id，其次按 name（历史数据两种都存过） */
function resolveExpectationValue(e: DslExpectation, ctx: RenderCtx): string {
  const v = e.value;
  if (v && typeof v === 'object' && v.type === 'VARIABLE') {
    const raw = String(v.value ?? '');
    const byId = ctx.variableList.find((r) => Number(r.id) === Number(raw));
    const byName = byId || ctx.variableList.find((r) => String(r.name) === raw);
    if (byName) return pickVariableValue(byName, ctx.env) || raw;
  }
  return resolveValue(v, ctx);
}

/** context 多跳 → C(...) 链表达式（selector/class/includes/text 原样透传） */
function chainExpr(context: DslHop[] | undefined): string {
  const hops = collectHops(context);
  if (!hops.length) return `C({ type: 'selector', value: 'body' })`;
  return `C(${hops.map(h => `{ type: ${q(h.type)}, value: ${q(h.value)}${h.index !== undefined ? `, index: ${h.index}` : ''} }`).join(', ')})`;
}

/** 同 chainExpr，但无有效跳时返回 ''（截图对比：无上下文 = 整页截图） */
function chainExprOrNull(context: DslHop[] | undefined): string {
  const hops = collectHops(context);
  if (!hops.length) return '';
  return `C(${hops.map(h => `{ type: ${q(h.type)}, value: ${q(h.value)}${h.index !== undefined ? `, index: ${h.index}` : ''} }`).join(', ')})`;
}

interface CollectedHop {
  type: string;
  value: string;
  index?: number;
}

/**
 * 归一化定位跳。
 *
 * `source` 跳是**元素库引用**（context: [{ type:'source', value: <elementId> }]），
 * 需要查 element 表才能拿到真实 selector —— 那是 IO，按分层约定由装载器预先
 * 解析成 selector/class 跳。这里如果还看到 source，说明装载器漏解析了：
 * 直接抛错，而不是把它当作空定位静默退化成 body（那会让点击打到整页元素上）。
 */
function collectHops(context: DslHop[] | undefined): CollectedHop[] {
  const out: CollectedHop[] = [];
  for (const h of Array.isArray(context) ? context : []) {
    const type = String(h?.type || '');
    const value = String(h?.value ?? h?.selector ?? '');
    if (type === 'source') {
      throw new Error(
        `定位链里的元素库引用（type=source, value=${value}）未被解析成 locator`
          + ' —— 装载器需要先把 source 跳展开成 selector/class 跳再交给生成器',
      );
    }
    if (type === 'javascript') continue; // 仅 WRITE_GLOBAL 用，不参与元素定位
    if (type === '' || value === '') continue;
    const idx = h?.index;
    const hasIdx = idx !== undefined && idx !== null && Number(idx) > 0;
    out.push(hasIdx ? { type, value, index: Number(idx) } : { type, value });
  }
  return out;
}

/** 截图基线 key 兜底：步骤文案 → 稳定 key（同步骤重复生成不变） */
function sanitizeShotKey(text: string): string {
  return String(text || 'shot').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_').slice(0, 40);
}

/** step.wait 数组 → engine.wait 语句 */
function waitExprs(d: DslStep): string[] {
  const out: string[] = [];
  for (const w of d?.wait || []) {
    const ms = Number(w?.value ?? 0);
    if (ms > 0) out.push(`await engine.wait(${ms});`);
  }
  return out;
}

function waitMs(d: DslStep): number {
  const v = d?.value;
  const n = Number(typeof v === 'object' && v !== null ? (v as any).value : v ?? 0);
  if (n > 0) return n;
  for (const w of d?.wait || []) {
    const m = Number(w?.value ?? 0);
    if (m > 0) return m;
  }
  return 0;
}

/** WAIT_RESPONSE 选项对象字面量（含前导逗号；无选项时返回空串） */
function waitResponseOptions(d: DslStep): string {
  const w: any = d?.wait && !Array.isArray(d.wait) ? d.wait : {};
  const opts: string[] = [];
  if (Number(w.timeout) > 0) opts.push(`timeout: ${Number(w.timeout)}`);
  if (w.method) opts.push(`method: ${q(String(w.method))}`);
  if (Array.isArray(w.status) && w.status.length) {
    opts.push(`status: [${w.status.map((x: any) => Number(x)).filter(Number.isFinite).join(', ')}]`);
  }
  if (w.required === true) opts.push(`required: true`);
  if (Number(w.afterMs) > 0) opts.push(`afterMs: ${Number(w.afterMs)}`);
  return opts.length ? `, { ${opts.join(', ')} }` : '';
}

/** context 中第一个 type=selector 跳的值（元素就绪门真检测用） */
function firstContextSelector(context: DslHop[] | undefined): string {
  for (const h of Array.isArray(context) ? context : []) {
    if (String(h?.type || '') === 'selector') {
      const v = String(h?.value ?? h?.selector ?? '').trim();
      if (v) return v;
    }
  }
  return '';
}

function firstHopOfType(context: DslHop[] | undefined, type: string): DslHop | undefined {
  return (Array.isArray(context) ? context : []).find((h) => String(h?.type || '') === type);
}

/** 字符串字面量（保证生成代码语法安全） */
function q(s: string): string {
  return JSON.stringify(String(s ?? ''));
}
