declare module '@kkeve/core/llm' {
  export interface Message {
    role: string;
    content: string | ContentItem[];
  }
  export interface ContentItem {
    type: string;
    [key: string]: any;
  }
  export interface Tool {
    name?: string;
    description: string;
    parameters?: any;
    inputSchema?: any;
    execute?: (args: any) => Promise<any>;
    [key: string]: any;
  }
  export interface ToolCallResult {
    content: any;
    toolCalls?: any[];
    [key: string]: any;
  }
  export class LLM {
    constructor(options: any);
    invoke(messages: Message[], tools?: Tool[] | Record<string, Tool>, signal?: any, options?: any): Promise<ToolCallResult>;
    chat(messages: Message[], options?: any): Promise<any>;
  }
}

declare module '*.md?raw' {
  const content: string;
  export default content;
}
