// src/mcp/types.ts - MCP 2026-07-28 版本
export interface MetaObject {
  "io.modelcontextprotocol/protocolVersion"?: "2026-07-28";
  "io.modelcontextprotocol/clientInfo"?: {
    name: string;
    version: string;
  };
  "io.modelcontextprotocol/clientCapabilities"?: Record<string, unknown>;
  "io.modelcontextprotocol/serverInfo"?: {
    name: string;
    version: string;
  };
  ttlMs?: number;
  [key: string]: unknown;
}

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown> & {
    _meta?: MetaObject;
  };
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: Record<string, unknown> & {
    _meta?: MetaObject;
  };
  error?: JsonRpcError;
}

/** JSON-RPC 错误 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** server/discover 返回结构 */
export interface ServerDiscoverResult {
  resultType: "complete";
  supportedVersions: string[];
  capabilities: {
    tools?: {};
    resources?: {};
    prompts?: {};
    elicitation?: {};
  };
  instructions?: string;
  ttlMs?: number;
  _meta?: MetaObject;
}

/**
 * JSON-RPC 工具定义。
 * 形状照搬 schema.ts 的 `Tool`（仅保留本客户端会读的字段；
 * 规范另有 icons / annotations / _meta，我们不消费，故不声明）。
 */
export interface McpToolDefinition {
  name: string;
  title?: string;
  /** 规范里是可选的，只有 name 和 inputSchema 必填 */
  description?: string;
  inputSchema: { $schema?: string; type: "object"; [key: string]: unknown };
  outputSchema?: { $schema?: string; [key: string]: unknown };
}

/** tools/list 响应 */
export interface ToolsListResult {
  resultType: "complete";
  tools: McpToolDefinition[];
  /** 分页游标；非空表示还有下一页 */
  nextCursor?: string;
  ttlMs?: number;
  _meta?: MetaObject;
}

/** tools/call 请求参数 */
export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 工具结果的内容块。协议共五种：text / image / audio / resource_link / resource。
 * 遇到不认识的新类型时应忽略该块，而不是让整条结果失败。
 */
export type ToolContentBlock =
  | { type: "text"; text: string; annotations?: unknown }
  | { type: "image"; data: string; mimeType: string; annotations?: unknown }
  | { type: "audio"; data: string; mimeType: string; annotations?: unknown }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
      annotations?: unknown;
    }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        annotations?: unknown;
      };
    };

/** tools/call 正常完成结果 */
export interface ToolCallCompleteResult {
  resultType: "complete";
  content: ToolContentBlock[];
  /** 工具声明了 outputSchema 时，真正的结果在这里 */
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: MetaObject;
}

/**
 * MRTR 里的 elicitation 问询（协议定义，本客户端未实现）。
 * 规范允许的取值还有 sampling/createMessage 与 roots/list；
 * 本客户端不声明任何能力，合规服务端本就不该发这些问询。
 */
export interface ElicitationInputRequest {
  method: "elicitation/create";
  params: {
    /** 缺省即 form 模式 */
    mode?: "form" | "url";
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * tools/call 问询中断结果 (MRTR)。
 * inputRequests 是「服务端分配的 key → 请求对象」的映射，不是数组；
 * 且 inputRequests 与 requestState 均为可选，规范只要求至少含其一。
 */
export interface ToolCallInputRequiredResult {
  resultType: "input_required";
  inputRequests?: Record<string, ElicitationInputRequest>;
  requestState?: string;
  _meta?: MetaObject;
}

// tools/call 结果类型：完整照搬协议，客户端目前只实现 complete 分支
export type ToolCallResult = ToolCallCompleteResult | ToolCallInputRequiredResult;

/** mcp.json server config */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}