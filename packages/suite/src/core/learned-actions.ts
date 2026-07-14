/**
 * learned-actions — In-memory cache for same-round Re-Act discovery sharing
 *
 * When one keveGoal's Re-Act loop discovers a working action sequence,
 * other goals in the same round can use those discoveries as hints.
 *
 * Key format: "${step}" — the step description
 * Value: ActionLogEntry[] — the successful action sequence
 */

export class LearnedActions {
  private cache: Map<string, any[]> = new Map();

  /** Store discovered actions for a step */
  add(step: string, actions: any[]): void {
    // Only store successful action sequences (ending with expected met)
    if (actions.length > 0) {
      this.cache.set(step, actions);
    }
  }

  /** Retrieve discovered actions for a step */
  get(step: string): any[] | undefined {
    return this.cache.get(step);
  }

  /** Get a JSON hint string for injecting into Re-Act prompt */
  getHint(step: string): string | undefined {
    const actions = this.cache.get(step);
    if (!actions || actions.length === 0) return undefined;

    // Summarize: only include action type + role/name, not full snapshot
    const summary = actions
      .filter(a => a.action.tool !== 'done')
      .map(a => {
        const act = a.action;
        if (act.tool === 'navigate') return `navigate(${act.url})`;
        if (act.tool === 'click') return `click(${act.role} "${act.name}")`;
        if (act.tool === 'type') return `type(${act.role} "${act.name}", "${act.text}"${act.submit ? ', Enter' : ''})`;
        if (act.tool === 'hover') return `hover(${act.role} "${act.name}")`;
        if (act.tool === 'pressKey') return `pressKey(${act.key})`;
        if (act.tool === 'scroll') return `scroll(${act.direction})`;
        if (act.tool === 'wait') return `wait(${act.time}ms)`;
        return act.tool;
      });

    return `Previous successful actions for "${step}": ${summary.join(' → ')}`;
  }

  /** Get all cached entries */
  getAll(): Map<string, any[]> {
    return this.cache;
  }

  /** Clear all cached entries (typically at round start) */
  clear(): void {
    this.cache.clear();
  }
}

/** Global singleton for same-round sharing */
export const learnedActions = new LearnedActions();
