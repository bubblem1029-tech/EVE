/**
 * playwright-page — 把 Playwright `Page` 适配成 AgentPage 契约。
 *
 * 之所以需要这一层：`page-agent` 现在只依赖 `page-like.ts` 定义的最小 API，
 * 这样同一份 Re-Act 循环既能跑在 Playwright 上，也能跑在 Cypress（CDP）上。
 *
 * 约束：只允许 `import type`（本文件会被打进 Cypress 浏览器 bundle，
 * 运行时 import `@playwright/test` 会经 playwright-core → node:fs 让 esbuild 失败）。
 */

import type { Page } from '@playwright/test';
import type {
  AgentBoundingBox,
  AgentKeyboard,
  AgentLocator,
  AgentMouse,
  AgentPage,
  AgentScreenshot,
} from './page-like.js';

function wrapLocator(locator: any): AgentLocator {
  const wrapped: AgentLocator = {
    click: (options) => locator.click(options),
    dblclick: (options) => locator.dblclick(options),
    fill: (value, options) => locator.fill(value, options),
    hover: (options) => locator.hover(options),
    pressSequentially: (text, options) => locator.pressSequentially(text, options),
    evaluate: (fn, arg) => locator.evaluate(fn, arg),
    textContent: (options) => locator.textContent(options),
    innerText: (options) => locator.innerText(options),
    inputValue: (options) => locator.inputValue(options),
    isChecked: (options) => locator.isChecked(options),
    setChecked: (checked, options) => locator.setChecked(checked, options),
    selectOption: (values, options) => locator.selectOption(values, options),
    waitFor: (options) => locator.waitFor(options),
    boundingBox: async (options): Promise<AgentBoundingBox | null> => await locator.boundingBox(options),
    getAttribute: (name, options) => locator.getAttribute(name, options),
    count: () => locator.count(),
    allInnerTexts: () => locator.allInnerTexts(),
    isVisible: (options) => locator.isVisible(options),
    first: () => wrapLocator(locator.first()),
    last: () => wrapLocator(locator.last()),
    nth: (index) => wrapLocator(locator.nth(index)),
    filter: (options) => wrapLocator(locator.filter(options)),
    locator: (selector) => wrapLocator(locator.locator(selector)),
    screenshot: async (options): Promise<AgentScreenshot> => {
      const buf = await locator.screenshot(options);
      return { base64: buf.toString('base64') };
    },
  };
  return wrapped;
}

/**
 * 是否已经是 AgentPage 实现。
 *
 * 判断依据取 Playwright `Page` 独有、而 AgentPage 契约里没有的 `context()`：
 * 两侧都有 `locator/keyboard/mouse/screenshot`，只靠能力探测无法区分。
 */
export function isPlaywrightPage(page: any): boolean {
  return typeof page?.context === 'function' && typeof page?.locator === 'function';
}

/** Playwright `Page` → AgentPage（幂等：传入 AgentPage 时原样返回） */
export function toAgentPage(page: Page | AgentPage): AgentPage {
  if (!isPlaywrightPage(page)) return page as AgentPage;
  const p = page as Page;
  return {
    locator: (selector) => wrapLocator(p.locator(selector)),
    getByText: (text, options) => wrapLocator(p.getByText(text, options)),
    getByRole: (role, options) => wrapLocator(p.getByRole(role as any, options)),
    ariaSnapshot: (options) => p.ariaSnapshot(options as any),
    url: () => p.url(),
    title: () => p.title(),
    goto: async (url, options) => {
      await p.goto(url, options);
    },
    reload: async (options) => {
      await p.reload(options);
    },
    evaluate: (fn) => p.evaluate(fn),
    screenshot: async (options): Promise<AgentScreenshot> => {
      const buf = await p.screenshot(options);
      return { base64: buf.toString('base64') };
    },
    viewportSize: () => p.viewportSize(),
    setViewportSize: (size) => p.setViewportSize(size),
    waitForTimeout: (ms) => p.waitForTimeout(ms),
    on: (event, handler) => {
      p.on(event as any, handler as any);
    },
    keyboard: {
      press: (key, options) => p.keyboard.press(key, options),
      type: (text, options) => p.keyboard.type(text, options),
      down: (key) => p.keyboard.down(key),
      up: (key) => p.keyboard.up(key),
    } satisfies AgentKeyboard,
    mouse: {
      click: (x, y, options) => p.mouse.click(x, y, options),
      move: (x, y) => p.mouse.move(x, y),
      down: (options) => p.mouse.down(options),
      up: (options) => p.mouse.up(options),
      wheel: (deltaX, deltaY) => p.mouse.wheel(deltaX, deltaY),
    } satisfies AgentMouse,
  };
}
