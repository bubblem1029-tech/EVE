/**
 * screenshotBackfill — 不截图步骤的画面补齐
 *
 * 等待、变量赋值这类步骤不改变 UI，采集截图只会增加报告体积。
 * 报告仍然需要「执行前/执行后」两格画面，这里用相邻步骤补齐：
 *   before ← 上一步的 after（同一画面）
 *   after  ← 下一步的 before（同一画面）
 *
 * 只处理显式标记 screenshotsSkipped 的步骤：真实采集失败的步骤不补，
 * 否则会把「没截到」伪装成「截到了」。
 */

export interface BackfillGoal {
  order: number;
  goalScreenshotBefore?: string;
  goalScreenshotAfter?: string;
  agentScreenshots?: string[];
  screenshotsSkipped?: boolean;
}

export function backfillSkippedScreenshots<T extends BackfillGoal>(goals: T[]): T[] {
  const ordered = [...goals].sort((a, b) => Number(a.order) - Number(b.order));
  for (let i = 0; i < ordered.length; i++) {
    const goal = ordered[i];
    if (!goal.screenshotsSkipped) continue;
    const prev = ordered[i - 1];
    const next = ordered[i + 1];
    if (!goal.goalScreenshotBefore && prev?.goalScreenshotAfter) {
      goal.goalScreenshotBefore = prev.goalScreenshotAfter;
    }
    if (!goal.goalScreenshotAfter && next?.goalScreenshotBefore) {
      goal.goalScreenshotAfter = next.goalScreenshotBefore;
    }
    if (!goal.agentScreenshots?.length && goal.goalScreenshotAfter) {
      goal.agentScreenshots = [goal.goalScreenshotAfter];
    }
  }
  return goals;
}
