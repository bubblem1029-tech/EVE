import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { pageReadySource, type PageReadyResult } from '../src/dsl/pageReadySource';

function createDom(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://example.test/dashboard',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const win = dom.window as any;
  win.getComputedStyle = (el: any) => ({
    visibility: el?.style?.visibility || 'visible',
    display: el?.style?.display || 'block',
    opacity: el?.style?.opacity || '1',
  });
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    let node: any = this;
    while (node) {
      if (node.style?.display === 'none' || node.hidden) {
        return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
      }
      node = node.parentElement;
    }
    return {
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  };
  return dom;
}

async function run(html: string, options: Record<string, any> = {}): Promise<PageReadyResult> {
  const dom = createDom(html);
  const result = await dom.window.eval(
    pageReadySource({ stableTimes: 1, intervalMs: 10, timeoutMs: 2000, ...options }),
  );
  dom.window.close();
  return result as PageReadyResult;
}

describe('pageReadySource', () => {
  it('detects visible content', async () => {
    const result = await run('<div id="app"><div>数据看板内容</div></div>');
    expect(result.ready).toBe(true);
    expect(result.reason).toBe('CONTENT_VISIBLE');
  });

  it('detects a blank app root', async () => {
    const result = await run('<div id="app"></div>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('BLANK_APP_ROOT');
  });

  it('does not let header text hide a blank business region', async () => {
    const result = await run('<div><header>Dashboard navigation</header><main></main></div>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('BLANK_APP_ROOT');
  });

  it('ignores hidden dialog text inside the app root', async () => {
    const result = await run(
      '<div id="app"><div class="el-dialog" style="display:none"><span>浏览器提示</span></div></div>',
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('BLANK_APP_ROOT');
    expect(result.textLength).toBe(0);
  });

  it('ignores aria-hidden placeholder text inside the app root', async () => {
    const result = await run('<div id="app"><div aria-hidden="true">浏览器提示</div></div>');
    expect(result.ready).toBe(false);
    expect(result.textLength).toBe(0);
  });

  it('does not count chrome media as business content', async () => {
    const result = await run('<div id="app"><header><img src="logo.png" /></header><div class="content"></div></div>');
    expect(result.ready).toBe(false);
    expect(result.visibleMedia).toBe(0);
  });

  it('detects a page-level loader that lives outside the app root', async () => {
    const result = await run(
      '<div id="app"><div class="content"></div></div><div class="loading-wrapper"><span class="loading-text">加载中...</span></div>',
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('PERSISTENT_LOADING');
    expect(result.loadingMarkers).toBeGreaterThan(0);
  });

  it('detects a local spinner inside the business region', async () => {
    const result = await run('<main><div class="loading-spinner"></div><div>KPI cards</div></main>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('PERSISTENT_LOADING');
    expect(result.loadingMarkers).toBeGreaterThan(0);
  });

  it('detects persistent loading', async () => {
    const result = await run('<div id="app"><div class="el-loading-mask"></div></div>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('PERSISTENT_LOADING');
  });

  it('detects a login page', async () => {
    const result = await run('<div id="app"><input type="password" /></div>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('LOGIN_REQUIRED');
  });

  it('detects an error page', async () => {
    const result = await run('<div id="app">404 页面不存在</div>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('ERROR_PAGE');
  });

  it('treats a canvas-only page as unverified by default', async () => {
    const result = await run('<div id="app"><canvas></canvas></div>');
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('CANVAS_CONTENT_UNVERIFIED');
    expect(result.canvasUnverified).toBe(true);
  });

  it('allows a canvas-only page when explicitly configured', async () => {
    const result = await run('<div id="app"><canvas></canvas></div>', { allowCanvas: true });
    expect(result.ready).toBe(true);
    expect(result.canvasUnverified).toBe(true);
  });
});

