// src/mcp-server/sqlite-server.ts — 一个最小的 SQLite MCP Server
// 协议版本 2026-07-28：无会话、无握手，版本随每条请求的 _meta 走；
// 用它自带的 server/discover 供客户端开场探测，tools/call 的每个结果都带 resultType
// 暴露 list_tables / query 两个工具，全程只读

import Database from "better-sqlite3";
import { createInterface } from "node:readline";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  MetaObject,
  ServerDiscoverResult,
  ToolCallCompleteResult,
  ToolsListResult,
} from "../mcp/types.js";

const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO = { name: "sqlite-server", version: "0.1.0" };

/** 工具定义，形状与 client 侧的 McpToolDefinition 对齐 */
const TOOLS: McpToolDefinition[] = [
  {
    name: "list_tables",
    description: "List all tables in the SQLite database",
    // 无参数工具的规范推荐写法：明确只接受空对象
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "query",
    description: "Execute a read-only SQL query",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "The SQL query to execute (SELECT only)",
        },
      },
      required: ["sql"],
    },
  },
];

// ---- 启动：解析参数，以只读方式打开数据库 ----

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: tsx sqlite-server.ts <database-path>");
  process.exit(1);
}

// readonly 是第二道保险：即使下面的 SELECT-only 检查被绕过，写操作也会在驱动层失败
const db = new Database(dbPath, { readonly: true });
console.error(`[sqlite-server] Opened ${dbPath} (read-only, protocol ${PROTOCOL_VERSION})`);

// ---- MCP 协议层 ----

/** 从 stdin 读到的原始消息：字段都未经校验*/
interface IncomingMessage {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

/** 每个响应统一带上的 _meta：告诉客户端是谁在回话 */
function responseMeta(): MetaObject {
  return { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
}

function fail(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * 文本里不带 "Error:" 前缀——是否出错由 isError 表达，
 * 前缀由客户端框架层统一加，否则会出现 "Error: Error: ..."
 */
function complete(id: JsonRpcRequest["id"], text: string, isError = false): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      content: [{ type: "text", text }],
      isError,
      _meta: responseMeta(),
    } satisfies ToolCallCompleteResult,
  };
}

function handleRequest(msg: IncomingMessage): JsonRpcResponse | null {
  // 没有 id 是通知，不需要响应
  if (msg.id === undefined || msg.id === null) return null;
  const id = msg.id as JsonRpcRequest["id"];

  const method = typeof msg.method === "string" ? msg.method : "";

  // 协议是无状态、无握手的：每条请求都必须自带 _meta 里的协议字段，
  // 服务端不得从连接或先前的请求里推断这些信息。
  const meta = msg.params?._meta as Record<string, unknown> | undefined;
  const requested = meta?.["io.modelcontextprotocol/protocolVersion"];
  const clientCapabilities = meta?.["io.modelcontextprotocol/clientCapabilities"];

  // 缺必填字段 = 请求非法，规范指定用 -32602 拒掉
  if (
    typeof requested !== "string" ||
    typeof clientCapabilities !== "object" ||
    clientCapabilities === null
  ) {
    return fail(
      id,
      -32602,
      "Missing required _meta fields: io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities"
    );
  }

  // 版本不认识：必须回 -32022 UnsupportedProtocolVersionError 并带上 supported 列表，
  // 客户端据此挑一个双方都支持的版本重试。server/discover 也不例外：
  // 带 supported 的 -32022 正是它要的答案，客户端也能据此认出对面是现代服务端。
  if (requested !== PROTOCOL_VERSION) {
    return fail(id, -32022, "Unsupported protocol version", {
      supported: [PROTOCOL_VERSION],
      requested,
    });
  }

  switch (method) {
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          instructions:
            "Read-only SQLite access. Call list_tables to inspect the schema, then query with SELECT.",
          _meta: responseMeta(),
        } satisfies ServerDiscoverResult,
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          tools: TOOLS,
          _meta: responseMeta(),
        } satisfies ToolsListResult,
      };

    case "tools/call":
      return handleToolCall(id, msg.params);

    default:
      return fail(id, -32601, `Unknown method: ${method}`);
  }
}

// ---- 工具实现 ----

function handleToolCall(
  id: JsonRpcRequest["id"],
  params: Record<string, unknown> | undefined
): JsonRpcResponse {
  const name = params?.name;
  if (typeof name !== "string") {
    return fail(id, -32602, "tools/call requires a string 'name'");
  }
  const args = (params?.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "list_tables": {
        const rows = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        return complete(id, JSON.stringify(rows.map((r) => r.name), null, 2));
      }

      case "query": {
        const sql = args.sql;
        if (typeof sql !== "string") {
          return complete(id, "the 'sql' argument must be a string", true);
        }
        // 只读检查；配合上面的 readonly 打开，构成两道防线
        if (!/^\s*SELECT\b/i.test(sql)) {
          return complete(id, "Only SELECT queries allowed", true);
        }
        const rows = db.prepare(sql).all();
        return complete(id, JSON.stringify(rows, null, 2));
      }

      default:
        // 未知工具属于协议错误（请求结构本身有问题），规范指定 -32602；
        // -32601 留给未知 method
        return fail(id, -32602, `Unknown tool: ${name}`);
    }
  } catch (err) {
    // 执行期错误是"工具失败"，不是"请求非法"：按 isError 结果回，让模型能看到并改
    return complete(id, (err as Error).message, true);
  }
}

// ---- stdio 循环 ----

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: IncomingMessage;
  try {
    msg = JSON.parse(trimmed) as IncomingMessage;
  } catch {
    return; // 非 JSON 行，忽略
  }

  const response = handleRequest(msg);
  if (response) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
});
