/**
 * learned-actions — In-memory cache for same-round Re-Act discovery sharing
 *
 * When one keveGoal's Re-Act loop discovers a working action sequence,
 * other goals in the same round can use those discoveries as hints.
 *
 * v2: Fuzzy matching by token Jaccard similarity + page URL pattern.
 *     Exact match is tried first; if no hit, fuzzy search across all entries.
 */

interface CacheEntry {
  step: string;
  actions: any[];
  url?: string;
  success: boolean;
}

export class LearnedActions {
  private cache: Map<string, CacheEntry> = new Map();

  /** Store discovered actions for a step (with optional page URL for context matching)
   *  @param success Whether the step succeeded — failed entries are stored with warnings only
   */
  add(step: string, actions: any[], url?: string, success: boolean = true): void {
    if (actions.length > 0) {
      this.cache.set(step, { step, actions, url, success });
    }
  }

  /** Retrieve discovered actions for a step (exact match) */
  get(step: string): any[] | undefined {
    return this.cache.get(step)?.actions;
  }

  /** Tokenize a Chinese/mixed step description for fuzzy matching.
   *  Uses bigram (character pair) extraction for Chinese — more granular than
   *  whitespace splitting, captures shared sub-phrases like "指标标准名称".
   */
  private tokenize(text: string): string[] {
    // 1. Split by delimiters to get chunks
    const chunks = text
      .replace(/[，。、；：""''（）【】《》\s,.;:!?/\\|]+/g, ' ')
      .split(' ')
      .filter(t => t.length > 0);

    // 2. For each chunk, extract character bigrams (for Chinese sub-phrase matching)
    //    AND keep the original chunk (for exact chunk matches)
    const tokens: string[] = [];
    for (const chunk of chunks) {
      tokens.push(chunk.toLowerCase());
      // Generate bigrams: sliding window of 2 chars
      for (let i = 0; i < chunk.length - 1; i++) {
        tokens.push(chunk.substring(i, i + 2).toLowerCase());
      }
    }
    return tokens;
  }

  /** Compute Jaccard similarity between two token sets */
  private jaccard(a: string[], b: string[]): number {
    const setA = new Set(a.map(t => t.toLowerCase()));
    const setB = new Set(b.map(t => t.toLowerCase()));
    const intersection = [...setA].filter(t => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /** Find the best matching cached entry for a given step description */
  private findBestMatch(step: string): CacheEntry | undefined {
    const tokens = this.tokenize(step);
    let bestEntry: CacheEntry | undefined;
    let bestScore = 0;
    // Threshold: 18% token overlap — low enough to catch "填写其他必填项" vs "必填项填入合法值",
    // high enough to avoid completely unrelated steps matching
    const THRESHOLD = 0.18;

    for (const [, entry] of this.cache) {
      const entryTokens = this.tokenize(entry.step);
      const score = this.jaccard(tokens, entryTokens);
      if (score > bestScore && score >= THRESHOLD) {
        bestScore = score;
        bestEntry = entry;
      }
    }
    return bestEntry;
  }

  /** Get a hint string for injecting into Re-Act prompt.
   *  1. Exact match → direct reuse
   *  2. Fuzzy match by token similarity → similar step reuse
   *  3. Same-page fallback → if same URL path, use the most recent successful entry
   */
  getHint(step: string, currentUrl?: string): string | undefined {
    // 1. Try exact match first (prefer success entries over failures)
    const exact = this.cache.get(step);
    if (exact?.actions.length) {
      const hint = this.formatHint(exact.step, exact.actions, false, exact.success);
      if (hint) return hint;
    }

    // 2. Fuzzy match by step description similarity (prefer success, but include failures)
    const best = this.findBestMatch(step);
    if (best?.actions.length) {
      const hint = this.formatHint(best.step, best.actions, true, best.success);
      if (hint) return hint;
    }

    // 3. Same-page fallback: if on the same URL path as a cached entry, use the most
    //    relevant one (highest Jaccard, even if below fuzzy threshold).
    //    Minimum Jaccard = 0.08 to avoid completely unrelated steps on the same page.
    if (currentUrl) {
      const urlPath = this.extractPath(currentUrl);
      let bestSamePage: CacheEntry | undefined;
      let bestSamePageScore = 0;
      const SAME_PAGE_MIN = 0.08;
      const stepTokens = this.tokenize(step);
      for (const [, entry] of this.cache) {
        if (entry.url && this.extractPath(entry.url) === urlPath) {
          const entryTokens = this.tokenize(entry.step);
          const score = this.jaccard(stepTokens, entryTokens);
          if (score > bestSamePageScore && score >= SAME_PAGE_MIN) {
            bestSamePageScore = score;
            bestSamePage = entry;
          }
        }
      }
      if (bestSamePage?.actions.length) {
        const hint = this.formatHint(bestSamePage.step, bestSamePage.actions, true, bestSamePage.success);
        if (hint) return hint;
      }
    }

    return undefined;
  }

  /** Extract path portion of URL for same-page matching (ignore query/hash) */
  private extractPath(url: string): string {
    try {
      const u = new URL(url);
      return u.pathname;
    } catch {
      return url;
    }
  }

  /** Format a hint from a cache entry's actions.
   *  Success: action sequence summary + key discoveries
   *  Failure: warnings/blockers only — avoid misleading Agent into reusing failed paths
   */
  private formatHint(sourceStep: string, actions: any[], isFuzzy: boolean, success: boolean): string | undefined {
    if (!success) {
      // Failed step — surface warnings/blockers AND combobox conflict info
      const discoveries: string[] = [];
      for (const a of actions) {
        const out = a.toolOutput || '';
        if (out.startsWith('⚠️')) discoveries.push(out.slice(0, 120));
        // Also capture combobox "重复" conflicts — valuable for later goals to avoid same data
        if (out.includes('重复') || out.includes('duplicate') || out.includes('conflict')) {
          discoveries.push(`DATA CONFLICT: ${out.slice(0, 120)}`);
        }
      }
      if (discoveries.length === 0) return undefined;
      const prefix = isFuzzy
        ? `Previous FAILED step SIMILAR to "${sourceStep}"`
        : `Previous FAILED step "${sourceStep}"`;
      return `${prefix} — avoid these approaches. Blocked by: ${discoveries.slice(-3).map(d => `[${d}]`).join('; ')}`;
    }

    // Success — full action sequence + discoveries (existing logic)
    // Extract stable element identity from toolOutput (not from action fields which lack role/name)
    const summary = actions
      .filter(a => a.action?.tool !== 'done' && a.tool !== 'done')
      .map(a => {
        const act = a.action || a;
        const out = a.toolOutput || '';
        if (act.tool === 'navigate') return `navigate(${act.url})`;
        if (act.tool === 'click') {
          // Parse toolOutput: "✅ Clicked [ref=e688] button \"新增指标\"" → "button 新增指标"
          // or: "⚠️ Clicked [ref=e2843] button \"确定\" — dialog still open" → "button 确定"
          const descMatch = out.match(/Clicked \[ref=\w+\]\s+(\S+\s+"[^"]*"|\S+)/);
          if (descMatch) {
            // descMatch[1] = 'button "新增指标"' or 'button "确定"' or 'element'
            const clean = descMatch[1].replace(/"/g, '').trim();
            return `click(${clean})`;
          }
          return `click(?)`;
        }
        if (act.tool === 'type') {
          // Parse toolOutput for stable type info
          const typeMatch = out.match(/✅ (replace|append) "([^"]*)" into element \[ref=\w+\]/);
          if (typeMatch) return `type("${typeMatch[2].slice(0, 30)}"${typeMatch[1] === 'append' ? ', append' : ''})`;
          // Combobox selection
          const cbMatch = out.match(/✅ Selected "([^"]*)" in combobox/);
          if (cbMatch) return `select("${cbMatch[1].slice(0, 30)}")`;
          return `type(?)`;
        }
        if (act.tool === 'fill_form') {
          // Extract filled fields from multi-line toolOutput
          // Lines look like: "✅ textbox [e2755] = "测试指标标准名称"" or "✅ combobox [e2800] = "KwaiBI官方数据集DEMO" (custom)"
          const fields: string[] = [];
          for (const line of out.split('\n')) {
            const fieldMatch = line.match(/✅ (\w+) \[\w+\] = "?([^"]*?)"?\s*(\(custom\))?$/);
            if (fieldMatch && fieldMatch[2]) {
              const fType = fieldMatch[1];
              const fVal = fieldMatch[2].slice(0, 25);
              fields.push(`${fType}="${fVal}"`);
            }
          }
          return fields.length ? `fill_form(${fields.join(', ')})` : 'fill_form(...)';
        }
        if (act.tool === 'select_option') {
          const selMatch = out.match(/✅ Selected "([^"]*)"/);
          if (selMatch) return `select_option("${selMatch[1].slice(0, 30)}")`;
          return `select_option(?)`;
        }
        if (act.tool === 'hover') return `hover(${act.role || ''} "${act.name || ''}")`;
        if (act.tool === 'pressKey') return `pressKey(${act.key})`;
        if (act.tool === 'scroll') return `scroll(${act.direction})`;
        if (act.tool === 'wait') return `wait(${act.time}ms)`;
        if (act.tool === 'execute_javascript') {
          const jsResult = out.match(/✅ JS executed\. Result: (.+)/);
          if (jsResult) return `js(→ ${jsResult[1].slice(0, 40)})`;
          return 'js(?)';
        }
        return act.tool;
      });

    // Extract key toolOutput lines — discoveries that other goals need to know
    // Focus on: combobox option results (✅/❌), dialog warnings (⚠️), validation messages
    const discoveries: string[] = [];
    for (const a of actions) {
      const out = a.toolOutput || '';
      // Combobox option selection results (most valuable for form reuse)
      if (out.includes('combobox') && (out.includes('(custom)') || out.includes('could not find option'))) {
        discoveries.push(out.slice(0, 120));
      }
      // Dialog warnings that blocked submission
      if (out.startsWith('⚠️')) {
        discoveries.push(out.slice(0, 120));
      }
    }
    // Limit to 5 most important discoveries
    const discoveryLines = discoveries.length > 0
      ? `\nKey discoveries: ${discoveries.slice(-5).map(d => `[${d}]`).join('; ')}`
      : '';

    const prefix = isFuzzy
      ? `Previous successful actions for SIMILAR step "${sourceStep}"`
      : `Previous successful actions for "${sourceStep}"`;
    return `${prefix}: ${summary.join(' → ')}${discoveryLines}`;
  }

  /** Get all cached entries */
  getAll(): Map<string, CacheEntry> {
    return this.cache;
  }

  /** Clear all cached entries (typically at round start) */
  clear(): void {
    this.cache.clear();
  }
}

/** Global singleton for same-round sharing */
export const learnedActions = new LearnedActions();
