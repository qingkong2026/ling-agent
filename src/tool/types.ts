
// Tool 接口定义与注册中心

import type { ToolDefinition } from "../providers/types.js";

/** 一次工具调用的执行上下文 */
export interface ToolCallContext {
  /** 对应 provider 返回的 ToolCall.id, 用于还原调用链 */
  toolCallId: string;
}

/** 可执行工具：在给模型看的工具声明之上，多了 execute 实现 */
export interface Tool extends ToolDefinition {
  execute(
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if(this.tools.has(tool.name)){
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<string> {
    const tool = this.get(name);
    if(!tool){
      throw new Error(`Unknown tool: "${name}"`);
    }
    return tool.execute(params, ctx);
  }

  // 只保留给模型看的声明部分，转换为适配器统一的工具格式
  toToolDefinitions(): ToolDefinition[] {
    return this.list().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

}