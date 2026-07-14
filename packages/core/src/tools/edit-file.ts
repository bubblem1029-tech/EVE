/**
 * edit_file tool — precise string replacement editing
 *
 * Reference: gemini-cli EditTool (replace oldString → newString)
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod/v4';
import type { ToolDefinition, ToolExecutionContext } from '../agent-loop/types';

export const EditFileInputSchema = z.object({
  path: z.string().describe('File path'),
  oldString: z.string().describe('Original text to replace (must match exactly)'),
  newString: z.string().describe('New text to replace with'),
  replaceAll: z.boolean().default(false).describe('Replace all occurrences (default: first only)'),
});

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit file by precise string replacement. oldString must match exactly, replaced with newString.',
  inputSchema: EditFileInputSchema,
  execute: async (args: z.infer<typeof EditFileInputSchema>, context?: ToolExecutionContext) => {
    const cwd = context?.cwd ?? process.cwd();
    const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);

    const content = await fs.readFile(filePath, 'utf-8');

    // Check if oldString exists
    if (!content.includes(args.oldString)) {
      return { ok: false, error: `oldString not found in ${filePath}` };
    }

    // Check uniqueness (if not replaceAll)
    if (!args.replaceAll) {
      const count = content.split(args.oldString).length - 1;
      if (count > 1) {
        return { ok: false, error: `oldString found ${count} times in ${filePath}, but replaceAll=false. Provide more context to make it unique.` };
      }
    }

    const newContent = args.replaceAll
      ? content.split(args.oldString).join(args.newString)
      : content.replace(args.oldString, args.newString);

    await fs.writeFile(filePath, newContent, 'utf-8');
    return { ok: true, path: filePath, replaced: args.oldString.length };
  },
};
