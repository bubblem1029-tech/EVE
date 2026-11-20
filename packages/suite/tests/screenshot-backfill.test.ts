import { describe, expect, it } from 'vitest';
import { backfillSkippedScreenshots } from '../src/engine-cypress/screenshotBackfill.js';

describe('backfillSkippedScreenshots', () => {
  it('uses neighbor frames for a skipped step without forging new paths', () => {
    const goals = backfillSkippedScreenshots([
      { order: 0, goalScreenshotBefore: 'a-before.png', goalScreenshotAfter: 'a-after.png' },
      { order: 1, screenshotsSkipped: true },
      { order: 2, goalScreenshotBefore: 'c-before.png', goalScreenshotAfter: 'c-after.png' },
    ]);
    expect(goals[1].goalScreenshotBefore).toBe('a-after.png');
    expect(goals[1].goalScreenshotAfter).toBe('c-before.png');
    expect(goals[1].agentScreenshots).toEqual(['c-before.png']);
  });

  it('keeps real capture failures empty instead of pretending success', () => {
    const goals = backfillSkippedScreenshots([
      { order: 0, goalScreenshotBefore: 'a-before.png', goalScreenshotAfter: 'a-after.png' },
      { order: 1 },
      { order: 2, goalScreenshotBefore: 'c-before.png' },
    ]);
    expect(goals[1].goalScreenshotBefore).toBeUndefined();
    expect(goals[1].goalScreenshotAfter).toBeUndefined();
  });

  it('leaves the tail skipped step without an after frame', () => {
    const goals = backfillSkippedScreenshots([
      { order: 0, goalScreenshotBefore: 'a-before.png', goalScreenshotAfter: 'a-after.png' },
      { order: 1, screenshotsSkipped: true },
    ]);
    expect(goals[1].goalScreenshotBefore).toBe('a-after.png');
    expect(goals[1].goalScreenshotAfter).toBeUndefined();
  });
});
