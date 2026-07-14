/**
 * write_file tool — write content to a file
 *
 * Reference: gemini-cli WriteFileTool
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod/v4';
import type { ToolDefinition, ToolExecutionContext } from '../agent-loop/types';

export const WriteFileInputSchema = z.object({
  path: z.string().describe('File path (relative to cwd or absolute)'),
  content: z.string().describe('Content to write to the file'),
  createDirs: z.boolean().default(true).describe('Automatically create parent directories'),
});

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file. Overwrites if exists, creates if not. Auto-creates parent directories.',
  inputSchema: WriteFileInputSchema,
  execute: async (args: z.infer<typeof WriteFileInputSchema>, context?: ToolExecutionContext) => {
    const cwd = context?.cwd ?? process.cwd();
    const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);

    if (args.createDirs) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    await fs.writeFile(filePath, args.content, 'utf-8');
    return { ok: true, path: filePath, bytes: Buffer.byteLength(args.content, 'utf-8') };
  },
};
