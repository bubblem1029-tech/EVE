export interface AgentRegistryDefinition {
  name: string;
  description: string;
  tools: string[];
  outputType?: string;
  model?: string;
  prompt: string;
  location: string;
}
