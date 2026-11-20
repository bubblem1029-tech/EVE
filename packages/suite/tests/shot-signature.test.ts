import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/core/judge/pngCodec.js';
import { compareShotSignatures, computeShotSignature } from '../src/core/judge/shotSignature.js';

function solidPng(width: number, height: number, rgb: [number, number, number], box?: {
  x0: number; y0: number; x1: number; y1: number; color: [number, number, number];
}): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inBox = box && x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
      const color = inBox ? box.color : rgb;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return encodePng(width, height, data);
}

describe('shotSignature', () => {
  it('treats identical frames as near duplicates', () => {
    const png = solidPng(320, 180, [240, 240, 240]);
    const diff = compareShotSignatures(computeShotSignature(png), computeShotSignature(png));
    expect(diff.meanDiff).toBe(0);
    expect(diff.changedRatio).toBe(0);
    expect(diff.nearDuplicate).toBe(true);
  });

  it('keeps frames with a large visible change', () => {
    const before = solidPng(320, 180, [240, 240, 240]);
    const after = solidPng(320, 180, [240, 240, 240], {
      x0: 40, y0: 30, x1: 280, y1: 150, color: [60, 60, 60],
    });
    const diff = compareShotSignatures(computeShotSignature(before), computeShotSignature(after));
    expect(diff.changedRatio).toBeGreaterThan(40);
    expect(diff.nearDuplicate).toBe(false);
  });

  it('ignores tiny pixel-level noise', () => {
    const before = solidPng(320, 180, [240, 240, 240]);
    const after = solidPng(320, 180, [240, 240, 240], {
      x0: 10, y0: 10, x1: 12, y1: 12, color: [0, 0, 0],
    });
    const diff = compareShotSignatures(computeShotSignature(before), computeShotSignature(after));
    expect(diff.nearDuplicate).toBe(true);
  });

  it('never collapses frames of different sizes', () => {
    const a = computeShotSignature(solidPng(320, 180, [240, 240, 240]));
    const b = computeShotSignature(solidPng(640, 360, [240, 240, 240]));
    const diff = compareShotSignatures(a, b);
    expect(diff.sizeMismatch).toBe(true);
    expect(diff.nearDuplicate).toBe(false);
  });
});
