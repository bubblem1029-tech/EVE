/**
 * AgentFactory — creates execution resources for AgentLoop
 *
 * - Creates LLM, ToolRegistry, RuntimeEnvironment
 * - Provides AgentLoader for agent discovery
 * - Creates sub-agent ToolRegistry with configurable allowed/blocked tools
 */

import * as path from 'node:path';
import type { LLMConfig } from '../llm/types';
import type { RuntimeEnvironment } from '../agent-loop/runtime';
import { ToolRegistry } from '../agent-loop/types';
import { LLM } from '../llm/index';
import { detectRuntimeEnvironment } from '../agent-loop/runtime';
import { createDefaultToolRegistry } from '../tools/index';
import { AgentLoader } from './loader';

export class AgentFactory {
  private llm: LLM;
  private runtime: RuntimeEnvironment;
  private toolRegistry: ToolRegistry;
  private agentLoader!: AgentLoader;

  constructor(
    llmConfig: LLMConfig,
    workspaceDir?: string,
  ) {
    this.llm = new LLM({
      ...llmConfig,
      baseURL: llmConfig.baseURL || process.env.LLM_BASE_URL || '',
      model: llmConfig.model || process.env.LLM_MODEL_NAME || process.env.LLM_MODEL || '',
      apiKey: llmConfig.apiKey || process.env.LLM_API_KEY || '',
    });
    this.runtime = detectRuntimeEnvironment(
      process.cwd(),
      workspaceDir || path.join(process.cwd(), 'workspace'),
    );
    this.toolRegistry = createDefaultToolRegistry(this.runtime);
  }

  async init(agentsDir: string): Promise<void> {
    this.agentLoader = new AgentLoader(agentsDir);
    await this.agentLoader.discover();
  }

  getLLM(): LLM {
    return this.llm;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getRuntime(): RuntimeEnvironment {
    return this.runtime;
  }

  getAgentLoader(): AgentLoader {
    return this.agentLoader;
  }

  createSubAgentToolRegistry(allowedTools?: string[], blockedTools?: string[]): ToolRegistry {
    const subRegistry = new ToolRegistry();

    const toolFilter = (allowedTools && allowedTools.length > 0)
      ? new Set(allowedTools)
      : null;

    const blocked = new Set(blockedTools ?? []);

    for (const name of this.toolRegistry.getAllToolNames()) {
      if (blocked.has(name)) continue;
      if (toolFilter && !toolFilter.has(name)) continue;
      const tool = this.toolRegistry.get(name);
      if (tool) subRegistry.register(tool);
    }

    return subRegistry;
  }
}
