/**
 * action-log-writer — Append action-log entries to action-log.jsonl
 *
 * Each line is a JSON object: { scene, step, action, source, result, timestamp }
 * Used by script-refine agent to discover deterministic callbacks from Re-Act traces.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ActionLogRecord {
  scene: string;           // test title
  step: string;            // keveGoal step description
  stepOrder: number;        // goal order within the test
  action: {                 // the executed action
    tool: string;
    role?: string;
    name?: string;
    url?: string;
    text?: string;
    key?: string;
    direction?: string;
    time?: number;
    submit?: boolean;
    reason?: string;
    success?: boolean;
  };
  source: 'deterministic' | 'react' | 'evaluate';  // who performed this action
  result: 'ok' | 'error' | 'achieved' | 'not_achieved';
  error?: string;
  // ── Rich logging fields ──
  evaluation?: string;       // LLM's evaluation of previous step (react) or evaluateGoal result
  memory?: string;           // LLM's memory/observations
  nextGoal?: string;         // LLM's next goal
  gap?: string;              // evaluateGoal gap description
  screenshotPath?: string;   // path to screenshot at this step
  snapshotPreview?: string;  // first 500 chars of ariaSnapshot
  fnSource?: string;         // fn.toString() for deterministic mode
  timestamp: string;
}

export class ActionLogWriter {
  private filePath: string;

  constructor(taskDir?: string) {
    const dir = taskDir || process.env.KEVE_TASK_DIR || '.keve';
    const logDir = path.join(dir, 'test-artifacts', `round-${process.env.KEVE_ROUND || 'latest'}`);
    fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, 'action-log.jsonl');
  }

  /** Append a single record */
  append(record: ActionLogRecord): void {
    const line = JSON.stringify(record);
    fs.appendFileSync(this.filePath, line + '\n', 'utf-8');
  }

  /** Append multiple records */
  appendAll(records: ActionLogRecord[]): void {
    for (const record of records) {
      this.append(record);
    }
  }

  /** Read all records (for script-refine) */
  readAll(): ActionLogRecord[] {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  /** Get file path for external consumers */
  getFilePath(): string {
    return this.filePath;
  }
}
