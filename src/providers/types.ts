
// 统一消息类型
/** 统一的工具声明：只描述给模型看的接口，不含执行逻辑 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string,unknown>; // JSON Schema
}

/** 工具调用请求 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

/** 工具执行结果：我们把结果喂回去 */
export interface ToolResult {
  toolCallId: string;
  content: string;
}

/** 统一消息类型 */
export type Message = 
  | { role: "system"; content: string} 
  | { role: "user"; content: string}
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]}
  | { role: "tool"; toolCallId: string ; content: string};

export type StreamChunkType = 
  | "text"               // 普通文本
  | "tool_call_start"    // 工具调用开始
  | "tool_call_delta"    // 工具调用参数的增量片段
  | "tool_call_end"      // 工具调用结束
  | "finish" ;           // 整个响应结束

/** 模型返回的统一响应 */
export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "unknown";
  usage?: { promptTokens: number ; completionTokens: number };
}

/** 流式响应返回的 chunk */
export interface StreamChunk {
  type: StreamChunkType,
  content: string;        // text 类型时是文本类型, tool_call_delta 时是参数 JSON 片段
  toolCallId?: string;   // 工具调用的唯一 ID
  toolName?: string;    //  仅在 tool_call_start 时出现
  index?: number;       //  同一响应中第几个工具调用
}

/** Provider 接口-所有适配器必须实现这两个方法 */
export interface LLMProvider {
  readonly name: string;
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
  stream(messages: Message[], tools?: ToolDefinition[]): AsyncIterableIterator<StreamChunk>;
}

/** Provider 配置 */
export interface ProviderConfig {
  provider: "deepseek" | "claude" | "openai";
  apiKey: string;
  model: string;
  baseURL?: string;
}