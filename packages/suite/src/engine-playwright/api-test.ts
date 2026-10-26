/** HTTP-only fixture. No page agent, browser session, SSO or screenshot hooks. */
import {test as base, expect} from '@playwright/test';
export {expect};
export const test = base.extend({
  browser: async ({}, use) => { throw new Error('API_MODE_BROWSER_FORBIDDEN: use request instead of browser'); },
  context: async ({}, use) => { throw new Error('API_MODE_BROWSER_FORBIDDEN: use request instead of context'); },
  page: async ({}, use) => { throw new Error('API_MODE_BROWSER_FORBIDDEN: use request instead of page'); },
});
