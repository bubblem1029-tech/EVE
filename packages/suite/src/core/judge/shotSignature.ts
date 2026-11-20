/**
 * shotSignature — 截图近似去重用的低分辨率灰度签名
 *
 * 场景：EVE 的执行链路对每个 goal 前后各截一张图，相邻截图经常只有
 * 输入框光标、hover 高亮这类像素级抖动，整张图落盘会让报告体积翻倍。
 *
 * 这里把 PNG 解码后降采样成 32×18 的灰度网格（576 个单元）：
 *   - 单元均值差 → 整图是否「基本没变」
 *   - 明显变化单元占比 → 是否存在局部真实变化（弹窗、抽屉、选中态）
 *
 * 两个指标同时低于阈值才判近似重复，避免「大面积没变 + 小区域弹窗」
 * 被误判成同一张图。尺寸不同一律视为不同画面。
 */

import { decodePng } from './pngCodec.js';

export const SIGNATURE_COLS = 32;
export const SIGNATURE_ROWS = 18;
/** 平均灰度差（百分比，0–100）低于该值才算「基本没变」 */
export const NEAR_DUPLICATE_MEAN_DIFF = 0.5;
/** 明显变化单元占比（百分比）超过该值即保留新图 */
export const NEAR_DUPLICATE_CHANGED_RATIO = 2;
/** 单元灰度差超过该值才算「变化单元」，过滤压缩噪声与抗锯齿 */
export const SIGNATURE_CELL_DELTA = 6;

export interface ShotSignature {
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** 行优先的灰度均值，取值 0–255 */
  cells: Float32Array;
}

export interface ShotSignatureDiff {
  /** 平均灰度差，换算成 0–100 的百分比 */
  meanDiff: number;
  /** 变化单元占比，0–100 的百分比 */
  changedRatio: number;
  sizeMismatch: boolean;
  nearDuplicate: boolean;
}

/** PNG → 32×18 灰度签名。解码失败直接抛出，由调用方决定是否退化为正常落盘。 */
export function computeShotSignature(
  png: Buffer,
  cols = SIGNATURE_COLS,
  rows = SIGNATURE_ROWS,
): ShotSignature {
  const image = decodePng(png);
  const cells = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const y0 = Math.floor((row * image.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * image.height) / rows));
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor((col * image.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * image.width) / cols));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * image.width + x) * 4;
          sum += 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
          count += 1;
        }
      }
      cells[row * cols + col] = count ? sum / count : 0;
    }
  }
  return { width: image.width, height: image.height, cols, rows, cells };
}

export function compareShotSignatures(a: ShotSignature, b: ShotSignature): ShotSignatureDiff {
  if (a.width !== b.width || a.height !== b.height || a.cols !== b.cols || a.rows !== b.rows) {
    return { meanDiff: 100, changedRatio: 100, sizeMismatch: true, nearDuplicate: false };
  }
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.cells.length; i++) {
    const delta = Math.abs(a.cells[i] - b.cells[i]);
    sum += delta;
    if (delta > SIGNATURE_CELL_DELTA) changed += 1;
  }
  const count = a.cells.length || 1;
  const meanDiff = (sum / count / 255) * 100;
  const changedRatio = (changed / count) * 100;
  return {
    meanDiff,
    changedRatio,
    sizeMismatch: false,
    nearDuplicate:
      meanDiff <= NEAR_DUPLICATE_MEAN_DIFF && changedRatio <= NEAR_DUPLICATE_CHANGED_RATIO,
  };
}
