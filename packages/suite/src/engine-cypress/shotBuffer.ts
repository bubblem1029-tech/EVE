/**
 * shotBuffer — 截图对比结果的 goal 级缓冲（浏览器侧）
 *
 * core/screenshotDiff.ts 是 Node 模块（依赖 fs），不能被打进 Cypress 的浏览器
 * bundle。但结构必须一致：keveGoal 要把本 goal 内所有对比结果（matched /
 * baseline_required / exceeded）写进 attachment 的 screenshotDiff 字段。
 * 这里只做「暂存 + 取出」，真正的对比在 Node 侧经 bridge 完成。
 */

export interface CyShotDiffResult {
  key: string;
  status: 'matched' | 'exceeded' | 'baseline_required' | 'size_mismatch';
  diffRatio: number | null;
  threshold: number;
  baselineVersion: number;
  baselineState?: 'candidate' | 'active';
  baselinePath: string;
  actualPath: string;
  diffPath: string;
  env: string;
  viewport: string;
  /** 差异热区（与 core/screenshotDiff.ts 的 ShotDiffResult.regions 同形，始终存在） */
  regions: Array<{ x: number; y: number; w: number; h: number; ratio: number }>;
  message: string;
  comparedAt: string;
}

/** 与 Playwright 的 ScreenshotDiffError 同形：带 shotDiff 结构，keveGoal 据此短路 */
export class CypressScreenshotDiffError extends Error {
  shotDiff: CyShotDiffResult;
  constructor(result: CyShotDiffResult) {
    super(result.message);
    this.name = 'ScreenshotDiffError';
    this.shotDiff = result;
  }
}

let buffer: CyShotDiffResult[] | null = null;

export function beginGoalShotDiffCapture(): void {
  buffer = [];
}

export function isGoalShotDiffCaptureActive(): boolean {
  return buffer !== null;
}

export function drainGoalShotDiff(): CyShotDiffResult[] {
  const out = buffer || [];
  buffer = null;
  return out;
}

export function recordShotDiff(result: CyShotDiffResult): void {
  if (buffer) buffer.push(result);
}
