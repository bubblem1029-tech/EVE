/**
 * grep tool — content search with regex
 *
 * Reference: gemini-cli GrepTool / ripgrep
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod/v4';
import type { ToolDefinition, ToolExecutionContext } from '../agent-loop/types';

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory to search in'),
  include: z.string().optional().describe('File filter pattern (e.g. *.vue, *.ts)'),
  maxResults: z.number().default(50).describe('Maximum number of matches to return'),
  contextLines: z.number().default(2).describe('Number of context lines around matches'),
});

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents with regex. Returns matching file paths, line numbers, and content.',
  inputSchema: GrepInputSchema,
  execute: async (args: z.infer<typeof GrepInputSchema>, context?: ToolExecutionContext) => {
    const searchDir = args.path ?? context?.cwd ?? process.cwd();
    const absPath = path.isAbsolute(searchDir) ? searchDir : path.resolve(context?.cwd ?? process.cwd(), searchDir);

    const includeFlag = args.include ? `--include="${args.include}"` : '';
    const contextFlag = args.contextLines > 0 ? `-C ${args.contextLines}` : '';
    const maxCount = args.maxResults > 0 ? `-m ${args.maxResults}` : '';

    try {
      const result = execSync(
        `grep -rn ${contextFlag} ${maxCount} ${includeFlag} -E "${args.pattern.replace(/"/g, '\\"')}" "${absPath}" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 15_000, maxBuffer: 1024 * 1024 }
      ).trim();

      if (!result) return { matches: [], count: 0 };

      const lines = result.split('\n').filter(Boolean);
      return {
        matches: lines.slice(0, args.maxResults),
        count: lines.length,
      };
    } catch {
      return { matches: [], count: 0 };
    }
  },
};
