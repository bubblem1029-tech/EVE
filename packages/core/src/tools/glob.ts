/**
 * glob tool — file search with glob pattern matching
 *
 * Reference: gemini-cli GlobTool
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod/v4';
import type { ToolDefinition, ToolExecutionContext } from '../agent-loop/types';

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. **/*.vue, src/**/*.ts)'),
  cwd: z.string().optional().describe('Root directory to search in'),
  maxResults: z.number().default(100).describe('Maximum number of results'),
});

export const globTool: ToolDefinition = {
  name: 'glob',
  description: 'Search files using glob patterns. Supports **/*.vue, src/**/*.ts etc. Returns matching file paths.',
  inputSchema: GlobInputSchema,
  execute: async (args: z.infer<typeof GlobInputSchema>, context?: ToolExecutionContext) => {
    const searchDir = args.cwd ?? context?.cwd ?? process.cwd();

    // Simple glob using Node.js fs
    // Production: replace with fast-glob / glob package
    const results: string[] = [];
    const pattern = args.pattern;

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 10 || results.length >= args.maxResults) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= args.maxResults) break;
        const fullPath = path.join(dir, entry.name);

        // Skip node_modules, .git, dist
        if (entry.isDirectory() && ['node_modules', '.git', 'dist', '.next', '.nuxt'].includes(entry.name)) continue;

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const relativePath = path.relative(searchDir, fullPath);
          if (matchGlob(relativePath, pattern)) {
            results.push(relativePath);
          }
        }
      }
    }

    await walk(searchDir, 0);
    return results.sort();
  },
};

/** Simple glob matching — supports **, *, ? */
function matchGlob(filePath: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{GLOBSTAR}}/g, '.*');
  return new RegExp(`^${regex}$`).test(filePath);
}
