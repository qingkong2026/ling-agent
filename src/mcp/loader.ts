// src/mcp/loader.ts — 从 mcp.json 加载并启动所有 MCP Server

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpClient } from "./client.js";
import type { McpConfig, McpServerConfig, ToolContentBlock } from "./types.js";
import type { Tool } from "../tool/types.js";

/**
 * 加载 mcp.json，启动所有 server，返回可直接 register 进 ToolRegistry 的工具列表
 */
export async function loadMcpServers(projectRoot: string): Promise<{
  clients: McpClient[];
  tools: Tool[];
}> {
  const configPath = join(projectRoot, ".ling", "mcp.json");
  let config: McpConfig;

  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { clients: [], tools: [] };
    }
    console.error(`[mcp] Failed to load ${configPath}:`, err.message);
    return { clients: [], tools: [] };
  }

  const clients: McpClient[] = [];
  const tools: Tool[] = [];

  // JSON.parse 出来的是 any：合法 JSON 但形状不对（{}、{"servers":{}}、null、
  // mcpServers 是数组）都必须当成配置错误处理，不能让它冒泡成未捕获异常。
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    console.error(
      `[mcp] ${configPath} 缺少有效的 "mcpServers" 对象，已跳过 MCP 加载`
    );
    return { clients: [], tools: [] };
  }

  for (const [serverName, serverConfig] of Object.entries(
    servers as Record<string, McpServerConfig>
  )) {
    // 单个 server 的配置也可以写错，同样只跳过它自己
    if (typeof serverConfig?.command !== "string") {
      console.error(`[mcp] 跳过 ${serverName}: 配置缺少 "command" 字段`);
      continue;
    }

    // 用 projectRoot 作为子进程 cwd：配置里的相对路径（脚本、数据库文件等）
    // 按项目根解析，这样从任何目录启动 ling 行为都一致
    const client = new McpClient(serverName, serverConfig, projectRoot);

    try {
      await client.connect();
    } catch (err: any) {
      // connect() 一进来就 spawn 了子进程，探测失败也要收尸，否则留下孤儿进程
      await client.disconnect().catch(() => {});
      console.error(
        `[mcp] Failed to connect to ${serverName}:`,
        err.message
      );
      continue;
    }

    clients.push(client);

    // 把 server 的工具注册到全局，加上命名前缀避免和内置工具重名
    for (const tool of client.getTools()) {
      tools.push({
        name: `mcp__${serverName}__${tool.name}`,
        // description 在规范里是可选的；缺省时退回工具名，避免拼出 "undefined"
        description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
        parameters: tool.inputSchema,
        execute: (params) => callRemoteTool(client, tool.name, params),
      });
    }
  }

  console.error(
    `[mcp] ${clients.length} server(s), ${tools.length} tool(s) total`
  );
  return { clients, tools };
}

/**
 * 关闭所有 MCP server 连接
 */
export async function shutdownMcpServers(
  clients: McpClient[]
): Promise<void> {
  await Promise.all(clients.map((c) => c.disconnect()));
}

/**
 * 执行一次远端工具调用，把 MCP 的 content 数组摊平成字符串
 * ToolRegistry.execute 只认字符串，所以非文本内容降级成占位描述
 */
async function callRemoteTool(
  client: McpClient,
  remoteName: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.toolsCall({ name: remoteName, arguments: args });

  const text = result.content
    .map(contentBlockToText)
    .filter((s) => s.length > 0)
    .join("\n");

  // 声明了 outputSchema 的工具，真正的结果在 structuredContent 里，content 可能为空；
  // 兜底取结构化结果，避免整条结果变成空串。
  const output =
    text ||
    (result.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent, null, 2)
      : "");

  // 与内置工具一致：失败就抛，交给上层工具循环处理
  if (result.isError) {
    throw new Error(output || `[MCP:${remoteName}] tool returned an error`);
  }
  return output;
}

/**
 * 把单个内容块摊平成文本。协议共五种块类型，遇到不认识的新类型
 * 降级成占位描述，而不是让整条结果失败。
 */
function contentBlockToText(part: ToolContentBlock): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return `[image: ${part.mimeType}]`;
    case "audio":
      return `[audio: ${part.mimeType}]`;
    case "resource_link":
      return `[resource_link: ${part.uri}]`;
    case "resource":
      // 嵌入资源：是文本就直接用，二进制降级成占位
      return part.resource.text ?? `[resource: ${part.resource.uri}]`;
    default: {
      // 编译期：协议新增内容块类型会在此报错；运行期：未知类型降级
      const _exhaustive: never = part;
      const unknown = _exhaustive as { type?: unknown; mimeType?: unknown };
      return `[${String(unknown?.type ?? "unknown")}: ${String(
        unknown?.mimeType ?? "unknown"
      )}]`;
    }
  }
}
