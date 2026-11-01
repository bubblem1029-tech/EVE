import { estimateRequestTokens } from '@kkeve/core/llm';

/** Budgeted mode is explicit; custom system prompts are never silently replaced. */
export const COMPACT_SYSTEM_PROMPT = `You operate a browser E2E test in a Re-Act loop. Respond in Chinese and call AgentOutput once per step.
Execute the requested action AND verify the entire expected result. Never invent evidence or infer success from a successful tool call alone.
Execute only the current test step. Do not advance to later workflow steps or confirm a subsequent dialog unless this step requires it.
Use the latest accessibility refs exactly as provided; refs may change after actions. Read current state and history before acting.
When a deterministic fn succeeded, verify any remaining expected result, then finish without repeating its action. On a precise assertion mismatch confirm at most once and report fail. Connection/SSO errors are blocked. Runtime/locator errors may be recoverable.
Handle the active popup before its parent. Do not repeatedly submit a validation-blocked form or repeat a failed strategy. Report fail/blocked honestly when no progress is possible.
If a list reports no results, inspect its search and scope filters before scrolling. The target may exist outside the current filter.
done requires verdict pass/fail/blocked and text with observed evidence. Never claim pass without completing and checking the task.
The tree may be partial. Absence from a partial tree does NOT establish absence from the page. Use execute_javascript to inspect missing content, or scroll/reobserve. Do not change application data beyond the requested test.
Keep evaluation, memory and next_goal concise; do not restate the full history. Tool parameters are declared in AgentOutput.`;

/** A narrow, deterministic cue from recorded locator code, never an inferred label. */
export function recordedClickTarget(source: string): string | undefined {
  if (!/\.click\s*\(/.test(source)) return undefined;
  const match = source.match(/\.locator\(\s*(['"])text=([^'"\n]+)\1\s*\)/)
    || source.match(/\.getByText\(\s*(['"])([^'"\n]+)\1/)
    || source.match(/\btype:\s*['"](?:includes|text)['"]\s*,\s*value:\s*(['"])([^'"\n]+)\1/);
  return match?.[2];
}

export function clickMatchesTarget(snapshot: string, ref: string, target: string, source = ''): boolean {
  const lines = snapshot.split('\n');
  const at = lines.findIndex(line => line.includes(`[ref=${ref}]`));
  if (at < 0) return false;
  const indent = (i: number) => lines[i].search(/\S/);
  let context = lines[at];
  for (let j = at + 1; j < lines.length && indent(j) > indent(at); j++) context += '\n' + lines[j];
  let level = indent(at);
  for (let j = at - 1; j >= 0; j--) if (indent(j) < level) { context += '\n' + lines[j]; level = indent(j); }
  if (/c-dataset-item|tree-item-wrapper/.test(source) && !/\b(treeitem|row|listitem)\b/.test(context)) return false;
  return context.includes(target);
}

export function canHandOffRecordedClick(expected: string, source: string, snapshot: string, ref?: string): boolean {
  const target = recordedClickTarget(source);
  return expected.trim() === '操作完成，页面正常响应' && !!target && !!ref && clickMatchesTarget(snapshot, ref, target, source);
}

export function compactHistory(history: string): string {
  const steps = history.match(/<step_\d+>[\s\S]*?<\/step_\d+>/g) || [];
  const observations = [...new Set(history.match(/<sys>[\s\S]*?<\/sys>/g) || [])];
  const older = steps.slice(0, -3).map(s => {
    const action = s.match(/Action: ([^\n]*)/)?.[1] || '';
    const memory = s.match(/Memory: ([^\n]*)/)?.[1] || '';
    return `${action.slice(0, 160)} ${memory.slice(0, 160)}`;
  }).join('\n');
  return `Earlier actions (condensed):\n${older.slice(-1600)}\n` + steps.slice(-3).map(s =>
    s.split('\n').map(line => line.slice(0, 400)).join('\n')).join('\n') + '\n' + observations.slice(-3).join('\n');
}

/** Select complete lines and their ancestors; never change an element ref or name. */
export function selectSnapshot(snapshot: string, query: string, maxChars: number): { text: string; partial: boolean } {
  if (snapshot.length <= maxChars) return { text: snapshot, partial: false };
  const lines = snapshot.split('\n');
  const parent: number[] = [];
  const stack: number[] = [];
  const indent = lines.map(line => line.search(/\S/));
  for (let i = 0; i < lines.length; i++) {
    while (stack.length && indent[stack[stack.length - 1]] >= indent[i]) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    if (indent[i] >= 0) stack.push(i);
  }
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) || [])];
  // Chinese task phrases are often longer than actual labels: include their bigrams.
  const terms = words.flatMap(word => /[\u4e00-\u9fff]/.test(word)
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]);
  const scored = lines.map((line, i) => ({ i, score:
    (/dialog|alert|focused|checked|selected|暂无数据|没有匹配|无结果|No results/.test(line) ? 100 : 0) +
    terms.reduce((n, word) => n + (line.toLowerCase().includes(word) ? 20 : 0), 0) +
    (/button|textbox|combobox|menuitem|link|checkbox/.test(line) ? 5 : 0) }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set<number>();
  let size = 0;
  for (const { i, score } of scored) {
    const required = new Set<number>();
    for (let at = i; at >= 0 && !keep.has(at); at = parent[at]) required.add(at);
    // Preserve an entire YAML block scalar if either its header or content is selected.
    for (const at of [...required]) {
      if (/[>|][-+]?\s*$/.test(lines[at])) {
        for (let j = at + 1; j < lines.length && indent[j] > indent[at]; j++) if (!keep.has(j)) required.add(j);
      }
    }
    const extra = [...required].reduce((n, at) => n + lines[at].length + 1, 0);
    if (size + extra > maxChars) continue;
    for (const at of required) keep.add(at);
    size += extra;
    // Search fields often have adjacent scope filters (e.g. "我创建").
    // Keep nearby context when it fits, after guaranteeing the target itself.
    if (score >= 20) {
      for (const j of [i - 1, i + 1, i - 2, i + 2, i + 3]) {
        if (j < 0 || j >= lines.length || keep.has(j)) continue;
        const nearby = new Set<number>();
        for (let at = j; at >= 0 && !keep.has(at); at = parent[at]) nearby.add(at);
        // Scalar payloads must remain complete; leave them for normal selection.
        if ([...nearby].some(at => /[>|][-+]?\s*$/.test(lines[at]))) continue;
        const cost = [...nearby].reduce((n, at) => n + lines[at].length + 1, 0);
        if (size + cost <= maxChars) { for (const at of nearby) keep.add(at); size += cost; }
      }
    }
  }
  return { text: [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n'), partial: true };
}

export function fitContext(system: string, original: string, tools: unknown[], inputBudget: number): {
  user: string; estimatedTokens: number; partial: boolean;
} {
  const estimate = (user: string) => estimateRequestTokens({ messages: [
    { role: 'system', content: system }, { role: 'user', content: user },
  ], tools });
  let user = original.replace(/<agent_history>([\s\S]*?)<\/agent_history>/,
    (_, history) => `<agent_history>\n${compactHistory(history)}\n</agent_history>`);
  // Preserve execution result; source remains in full execution artifacts.
  user = user.replace(/\nSource: [\s\S]*?(?=\n<\/prior_execution>)/, '\nSource omitted from model context; execution result retained.');
  const match = user.match(/Accessibility Tree \(YAML\):\n```yaml\n([\s\S]*?)\n```/);
  if (!match || estimate(user) <= inputBudget) return { user, estimatedTokens: estimate(user), partial: false };
  const snapshot = match[1];
  const query = (user.match(/<user_request>([\s\S]*?)<\/user_request>/)?.[1] || '') + '\n' +
    (user.match(/<prior_execution>([\s\S]*?)<\/prior_execution>/)?.[1] || '');
  // Reserve space for the current page before spending it on old reflection.
  // Keep action evidence rather than cutting away the entire observation tree.
  const emptyTree = (text: string) => text.replace(/```yaml\n[\s\S]*?\n```/, '```yaml\n\n```');
  const historyMatch = user.match(/<agent_history>([\s\S]*?)<\/agent_history>/);
  if (historyMatch && estimate(emptyTree(user)) + 600 > inputBudget) {
    const facts = (historyMatch[1].match(/Action: [^\n]*/g) || []).slice(-3).map(line => line.slice(0, 160));
    const observations = (historyMatch[1].match(/<sys>([\s\S]*?)<\/sys>/g) || []).slice(-1).map(line => line.slice(0, 160));
    let history = [...facts, ...observations].join('\n');
    user = user.replace(/<agent_history>[\s\S]*?<\/agent_history>/,
      `<agent_history>Recent actions (condensed):\n${history}\n</agent_history>`);
    const latestAction = facts.at(-1) || '';
    if (estimate(emptyTree(user)) + 600 > inputBudget && history !== latestAction) {
      history = latestAction;
      user = user.replace(/<agent_history>[\s\S]*?<\/agent_history>/,
        `<agent_history>Latest completed Agent action (after original fn failure):\n${history}\n</agent_history>`);
    }
  }
  let chars = snapshot.length;
  let partial = false;
  while (estimate(user) > inputBudget && chars > 0) {
    chars = Math.max(0, Math.floor(chars * 0.7) - 1);
    const selected = selectSnapshot(snapshot, query, chars);
    partial = selected.partial;
    user = user.replace(/Accessibility Tree \(YAML\):\n(?:\[PARTIAL[^\n]*\]\n)?```yaml\n[\s\S]*?\n```/,
      `Accessibility Tree (YAML):\n[PARTIAL tree; omitted nodes may exist. Inspect page before absence assertions.]\n\`\`\`yaml\n${selected.text}\n\`\`\``);
  }
  return { user, estimatedTokens: estimate(user), partial };
}
