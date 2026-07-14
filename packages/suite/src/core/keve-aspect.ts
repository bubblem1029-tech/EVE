/**
 * keve-aspect — Framework-internal aspect registry for keveGoal lifecycle
 *
 * Three phases: before → (goal body or rescue) → after
 * User-invisible: aspects are registered by the framework, not by test authors.
 *
 * Built-in aspects:
 * - screenshot-on-enter (before, order=10) — capture screenshot before goal
 * - react-rescue (rescue, order=0) — Re-Act loop when fn() throws
 * - expected-check (after, order=0) — verify expected state via aiAssert
 * - action-log-write (after, order=10) — append to action-log.jsonl
 * - learnedActions-update (after, order=20) — update in-memory cache
 * - screenshot-on-fail (after, order=30) — capture screenshot on failure
 */

export type AspectPhase = 'before' | 'rescue' | 'after';

export interface GoalContext {
  page: import('@playwright/test').Page;
  step: string;
  expected: string;
  precondition?: string;
  order: number;            // goal order within the test
  testTitle: string;
  specFilePath?: string;    // .keve.ts 文件路径（供 script-refine 使用）
}

export interface GoalResult {
  success: boolean;
  error?: Error;
  actions?: any[];          // ActionLogEntry[] from react-loop
  finalSnapshot?: string;
  evalResult?: {            // evaluateGoal result (when fn was provided)
    achieved: boolean;
    gap: string;
    nextAction: string;
    fnSource?: string;
    screenshotPath?: string;
    snapshotPreview?: string;
  };
}

export interface AspectDefinition {
  name: string;
  phase: AspectPhase;
  order: number;           // lower = earlier within phase
  execute: (ctx: GoalContext, result?: GoalResult, error?: Error) => Promise<GoalResult | void>;
}

export class KeveAspectRegistry {
  private aspects: AspectDefinition[] = [];

  register(def: AspectDefinition): void {
    this.aspects.push(def);
  }

  unregister(name: string): void {
    this.aspects = this.aspects.filter(a => a.name !== name);
  }

  getByPhase(phase: AspectPhase): AspectDefinition[] {
    return this.aspects
      .filter(a => a.phase === phase)
      .sort((a, b) => a.order - b.order);
  }

  /** Run all aspects of a phase, chaining results */
  async runPhase(
    phase: AspectPhase,
    ctx: GoalContext,
    result?: GoalResult,
    error?: Error,
  ): Promise<GoalResult | undefined> {
    const aspects = this.getByPhase(phase);
    let currentResult = result;
    for (const aspect of aspects) {
      try {
        const aspectResult = await aspect.execute(ctx, currentResult, error);
        if (aspectResult && phase === 'after') {
          currentResult = aspectResult;
        }
      } catch (err: any) {
        console.warn(`[keve-aspect] ${aspect.name} failed: ${err.message}`);
        // Aspects should not throw — they are framework-internal
      }
    }
    return currentResult;
  }
}

/** Global singleton aspect registry */
export const keveAspect = new KeveAspectRegistry();
