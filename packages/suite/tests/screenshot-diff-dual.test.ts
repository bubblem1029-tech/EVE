import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodePng } from '../src/core/judge/pngCodec';

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return encodePng(width, height, data);
}

describe('screenshotDiff dual baseline', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keve-shot-dual-'));
    process.env.KEVE_BASELINE_DIR = dir;
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.KEVE_BASELINE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports drift after approved baseline diverges but last run stays stable', async () => {
    const diffMod = await import('../src/core/judge/screenshotDiff');
    const approved = solidPng(32, 32, [255, 255, 255]);
    const changed = solidPng(32, 32, [0, 0, 0]);
    const paths = diffMod.resolveBaselinePaths('demo.sidebar', 32, 32);
    fs.writeFileSync(paths.pngPath, approved);
    fs.writeFileSync(paths.metaPath, JSON.stringify({
      version: 1,
      state: 'active',
      threshold: 1,
      masks: [],
      updatedAt: new Date().toISOString(),
    }));

    let first: any;
    try {
      first = diffMod.compareWithBaseline('demo.sidebar', changed, {
        baselineMode: 'dual',
        threshold: 1,
        lastRunThreshold: 1,
        configHash: 'cfg-1',
      });
    } catch (error: any) {
      first = error.shotDiff;
    }
    expect(first.status).toBe('exceeded');
    expect(first.lastRunStatus).toBe('missing');

    const second = diffMod.compareWithBaseline('demo.sidebar', changed, {
      baselineMode: 'dual',
      threshold: 1,
      lastRunThreshold: 1,
      configHash: 'cfg-1',
    });
    expect(second.status).toBe('baseline_drift');
    expect(second.lastRunStatus).toBe('matched');
  });

  it('reports last-run anomaly when current matches approved baseline', async () => {
    const diffMod = await import('../src/core/judge/screenshotDiff');
    const approved = solidPng(32, 32, [255, 255, 255]);
    const changed = solidPng(32, 32, [0, 0, 0]);
    const paths = diffMod.resolveBaselinePaths('demo.main', 32, 32);
    fs.writeFileSync(paths.pngPath, approved);
    fs.writeFileSync(paths.metaPath, JSON.stringify({
      version: 1,
      state: 'active',
      threshold: 1,
      masks: [],
      updatedAt: new Date().toISOString(),
    }));
    diffMod.saveLastRunSnapshot('demo.main', changed, 'cfg-1');

    const result = diffMod.compareWithBaseline('demo.main', approved, {
      baselineMode: 'dual',
      threshold: 1,
      lastRunThreshold: 1,
      configHash: 'cfg-1',
    });
    expect(result.status).toBe('last_run_anomaly');
    expect(result.lastRunStatus).toBe('exceeded');
  });

  it('supports last-run-only mode without an approved baseline', async () => {
    const diffMod = await import('../src/core/judge/screenshotDiff');
    const first = diffMod.compareWithBaseline('demo.last-only', solidPng(16, 16, [255, 255, 255]), {
      baselineMode: 'lastRun',
      threshold: 1,
    });
    expect(first.status).toBe('baseline_required');
    expect(first.lastRunStatus).toBe('missing');

    const second = diffMod.compareWithBaseline('demo.last-only', solidPng(16, 16, [255, 255, 255]), {
      baselineMode: 'lastRun',
      threshold: 1,
    });
    expect(second.status).toBe('matched');
    expect(second.lastRunStatus).toBe('matched');
  });
});
