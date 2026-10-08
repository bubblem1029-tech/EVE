/**
 * goal-heuristics — keveGoal 的错误归因判定（引擎无关）
 *
 * 为什么单独成模块：Playwright 的 keveGoal（core/keve-test.ts 的 fixture）与
 * Cypress 的 keveGoal（engine-cypress/keveGoal.ts）必须对同一段错误字符串给出
 * 完全相同的结论 —— 否则「环境问题」在一端是 BLOCKED、另一端是 FAIL，
 * 报告与置信度都会漂移。
 *
 * 约束：纯函数 + 零依赖（Cypress 浏览器 bundle 会直接打包本模块）。
 */

/**
 * 判断错误是否属于「环境阻塞」：这类错误 Agent Re-Act 无法修复，
 * 应直接判 BLOCKED 而不是烧 token 探索。
 *
 * 覆盖：空 URL、连接拒绝、导航超时、IDC 网段限制、SSO 跳转、页面/浏览器已关闭。
 * 注意：定位器超时**不算**（那是脚本选择器问题，应交给 Agent 自愈）。
 */
export function isEnvironmentBlockedError(err: any): boolean {
  const msg = (err?.message || String(err)).toLowerCase();

  // Empty/undefined URL: page.goto('') or page.goto(undefined)
  if (msg.includes('url must not be empty') || msg.includes('url is empty')
    || msg.includes('invalid url') || msg.includes('url is undefined')
    || msg.includes('navigation to ""') || msg.includes("navigation to ''")) {
    return true;
  }

  // 参数为 undefined（如 PAGE_* 环境变量缺失）
  if ((msg.includes('expected string') || msg.includes('expected a string'))
    && (msg.includes('got undefined') || msg.includes('got null') || msg.includes('received undefined'))) {
    return true;
  }

  // 连接被拒 / 网络不可达
  if (msg.includes('err_connection_refused') || msg.includes('connection refused')
    || msg.includes('net::err_connection') || msg.includes('err_name_not_resolved')
    || msg.includes('err_address_unreachable') || msg.includes('err_internet_disconnected')
    || msg.includes('err_connection_timed_out') || msg.includes('err_connection_reset')) {
    return true;
  }

  // 导航超时（页面不可达）
  if (msg.includes('navigation timeout of') || msg.includes('timeout of') && msg.includes('exceeded')
    || msg.includes('page.goto: timeout') || msg.includes('navigating to') && msg.includes('timed out')
    || msg.includes('[cypress-engine] 导航超时') || msg.includes('[cypress-engine] 刷新超时')) {
    return true;
  }

  // IDC 网段限制
  if (msg.includes('unable to access on the idc network segment')
    || msg.includes('idc network segment') || msg.includes('40314')) {
    return true;
  }

  // SSO / 登录跳转（非应用自身问题）
  if (msg.includes('sso redirect') || msg.includes('login redirect detected')
    || msg.includes('err_too_many_redirects')) {
    return true;
  }

  // 页面/上下文/浏览器已关闭 —— Agent 无法探索
  if (msg.includes('target page, context or browser has been closed')
    || msg.includes('page has been closed') || msg.includes('browser has been closed')
    || msg.includes('context has been closed') || msg.includes('未找到 aut frame')) {
    return true;
  }

  return false;
}

/**
 * 判断错误是否为「确定性断言失败」（Expected/Received 形态）。
 *
 * 这类失败是事实而非判断：即使 Agent 认为「通过」，也必须由确定性结果覆盖。
 * 同时用于在错误文案里保留精确的 expected/received 信息。
 */
export function isAssertionFailure(error: string): boolean {
  const msg = (error || '').toLowerCase();

  // 排除 API 参数类型错误（不是值断言）
  if (msg.includes('expected string') || msg.includes('expected a string')
    || msg.includes('expected number') || msg.includes('expected boolean')) {
    if (msg.includes('got undefined') || msg.includes('got null')
      || msg.includes('received undefined') || msg.includes('received null')) {
      return false;
    }
  }

  // Jest/Vitest/Playwright 断言：Expected: X, Received: Y
  if (msg.includes('expected') && msg.includes('received')) return true;

  if (msg.includes('assertionerror') || msg.includes('assertion failed')
    || msg.includes('assertion error')) return true;

  // 引擎侧断言文案（CypressEngine.expect* / PlaywrightEngine.expect*）
  if (msg.includes('断言失败')) return true;

  if ((msg.includes(' to be ') && !msg.includes('timeout') && !msg.includes('waiting for') && !msg.includes('exceeded'))
    || msg.includes(' to equal ') || msg.includes(' to deeply equal ')) return true;

  if (msg.includes('expected ') && (msg.includes(' but ') || msg.includes(' got ') || msg.includes(' received '))) return true;

  return false;
}

/**
 * 推导 done action 的三态结论（pass/fail/blocked）。
 *
 * 4 级回退：step 级 conclusion → action.verdict → action.result → action.success / 文本关键词。
 * 文本匹配必须先判 fail/blocked 再判 pass，否则「不通过」会被「通过」命中。
 */
export function deriveActionConclusion(
  stepConclusion: string | undefined,
  action: any,
): 'pass' | 'fail' | 'blocked' | undefined {
  if (action?.tool !== 'done') return undefined;
  if (stepConclusion) return stepConclusion as any;

  const verdict = action?.verdict;
  if (verdict === 'pass' || verdict === 'fail' || verdict === 'blocked') return verdict;

  const raw = action?.result;
  if (raw === 'pass' || raw === 'fail' || raw === 'blocked') return raw;
  if (typeof action?.success === 'boolean') return action.success ? 'pass' : 'fail';

  const tv = String(action?.text || '').trim().toLowerCase();
  if (tv.includes('fail') || tv.includes('failure')
    || tv.includes('失败') || tv.includes('未通过') || tv.includes('不通过')) return 'fail';
  if (tv.includes('blocked') || tv.includes('阻塞') || tv.includes('阻止')) return 'blocked';
  if (tv.includes('pass') || tv.includes('success') || tv.includes('ok')
    || tv.includes('完成') || tv.includes('成功') || tv.includes('通过') || tv.includes('验证通过')) return 'pass';
  return undefined;
}
