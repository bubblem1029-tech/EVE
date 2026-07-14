/**
 * Tool registry factory — general tools
 *
 * General tools (gemini-cli aligned):
 * - bash, read_files, write_file, edit_file, glob, grep, ask_user
 *
 * Business tools (keve, record_step_result) have been moved to agent package.
 * MCP browser tools (pw_*) have been removed — use keve-suite or agent package instead.
 */

import { ToolRegistry } from '../agent-loop/types';
import type { RuntimeEnvironment } from '../agent-loop/runtime';
import { bashTool } from './bash';
import { readFilesTool } from './read-files';
import { writeFileTool } from './write-file';
import { editFileTool } from './edit-file';
import { globTool } from './glob';
import { grepTool } from './grep';
import { askUserTool } from './ask-user';

export { bashTool, readFilesTool, writeFileTool, editFileTool, globTool, grepTool, askUserTool };

/**
 * Create default tool registry — general tools only
 */
export function createDefaultToolRegistry(runtime: RuntimeEnvironment): ToolRegistry {
  (globalThis as any).__runtime = runtime;

  const registry = new ToolRegistry();

  registry.register(bashTool);
  registry.register(readFilesTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(askUserTool);

  return registry;
}

export function getBuiltinToolNames(): string[] {
  return ['bash', 'read_files', 'write_file', 'edit_file', 'glob', 'grep', 'ask_user'];
}
