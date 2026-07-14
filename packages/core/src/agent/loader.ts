/**
 * AgentLoader — discovers and loads .md agent definitions from a directory
 *
 * Mirrors SkillLoader pattern (instance-based, no singleton).
 * Each .md file uses YAML frontmatter (same as SKILL.md) to define agent metadata.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { parseSkillFrontmatter } from '../skill/frontmatter-parser';
import type { AgentRegistryDefinition } from './types';

export class AgentLoader {
  private agents = new Map<string, AgentRegistryDefinition>();

  constructor(private agentsDir: string) {}

  async discover(): Promise<void> {
    const absoluteDir = path.resolve(this.agentsDir);
    try {
      const stats = await fs.stat(absoluteDir).catch(() => null);
      if (!stats || !stats.isDirectory()) {
        console.warn(`[AgentLoader] Agents directory not found: ${absoluteDir}`);
        return;
      }

      const agentFiles = await glob('*.md', {
        cwd: absoluteDir,
        absolute: true,
        nodir: true,
      });

      for (const agentFile of agentFiles) {
        try {
          const content = await fs.readFile(agentFile, 'utf-8');
          const parsed = parseSkillFrontmatter(content);
          if (!parsed || !parsed.name) {
            console.warn(`[AgentLoader] Invalid agent file: ${agentFile}`);
            continue;
          }

          const tools = parsed.allowedTools ?? [];
          const agent: AgentRegistryDefinition = {
            name: parsed.name,
            description: parsed.description,
            tools,
            outputType: parsed.outputType,
            model: undefined,
            prompt: parsed.body,
            location: agentFile,
          };

          this.agents.set(parsed.name, agent);
          console.log(`[AgentLoader] Loaded agent: "${parsed.name}" (tools: ${tools.join(', ')}, outputType: ${parsed.outputType ?? 'N/A'})`);
        } catch (err: any) {
          console.warn(`[AgentLoader] Failed to load ${agentFile}: ${err.message}`);
        }
      }

      console.log(`[AgentLoader] Total agents: ${this.agents.size}`);
    } catch (err: any) {
      console.warn(`[AgentLoader] Error discovering agents: ${err.message}`);
    }
  }

  get(name: string): AgentRegistryDefinition | undefined {
    return this.agents.get(name);
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  getAll(): Map<string, AgentRegistryDefinition> {
    return this.agents;
  }

  listAvailable(): Array<{ name: string; description: string; outputType?: string }> {
    return Array.from(this.agents.values()).map(a => ({
      name: a.name,
      description: a.description,
      outputType: a.outputType,
    }));
  }

  reset(): void {
    this.agents.clear();
  }
}
