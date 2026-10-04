
export type OutputFormat = "text" | "json" | "stream";


export interface WriteContent {
  content: string;
  model: string;
  turns: number;
  structuredOutput?: unknown;
}

// 流式事件类型
export interface StreamEvent {
  type: "start" | "text_delta" | "tool_use" | "tool_result" | "end" | "error";
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  model?: string;
  turns?: number;
}


export interface SchemaConstraint {
  schema: Record<string, unknown>;
  promptInstructions: string;
}