// 当前客户端版本是 2026-07-28 ,最小实现
// clientCapabilities 声明为空集：本客户端不支持 elicitation，就不宣称支持。
// 注意「声明空集」与「不发送该字段」在协议上不等价，后者属于缺必填字段。

import { spawn, ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerConfig,
  McpToolDefinition,
  ToolsListResult,
  ToolCallParams,
  ToolCallResult,
  ToolCallCompleteResult,
  ServerDiscoverResult,
  MetaObject,
} from "./types.js";

const PROTOCOL_VERSION = "2026-07-28";

/** 服务端不支持请求里的协议版本时，规范指定的错误码 */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** 方法不存在：说明对面根本不是 2026-07-28 的服务端 */
const METHOD_NOT_FOUND = -32601;
/** tools/list 分页时最多跟多少页，防止服务端一直回同一个 cursor */
const MAX_TOOL_LIST_PAGES = 100;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * 对端返回的 JSON-RPC 错误。带出协议错误码，上层才能按码分支
 * （比如 -32022 要读 data.supported 才能告诉用户该用哪个版本）。
 * 纯本地的错误（超时、spawn 失败）不用这个类，以免被误认为来自对端。
 */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

export class McpClient {
  private process: ChildProcess | null = null;
  private requestIdCounter = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = "";
  // 跨 chunk 保留未完成的多字节序列
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly serverName: string;
  private readonly config: McpServerConfig;
  private readonly cwd?: string;
  private tools: McpToolDefinition[] = [];
  private serverCapabilities: ServerDiscoverResult["capabilities"] = {};

  // 固定客户端元信息，全局统一，所有请求自动注入。
  // protocolVersion 与 clientCapabilities 是 _meta 里的必填字段，少一个服务端
  // 就得按 -32602 拒掉整条请求；空对象才是「声明不支持任何能力」的正确写法。
  private readonly clientMeta: MetaObject = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {
      name: "ling-agent",
      version: "1.0.0",
    },
    // 本客户端不支持 elicitation / sampling / roots，故为空集合
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  /**
   * @param cwd 子进程的工作目录。mcp.json 里的 command/args 常写相对路径，
   *   而配置本身是项目级的，所以这些路径应当相对 projectRoot 解析，
   *   而不是相对 ling 进程恰好被启动的位置。
   */
  constructor(serverName: string, config: McpServerConfig, cwd?: string) {
    this.serverName = serverName;
    this.config = config;
    this.cwd = cwd;
  }

  public getTools(): McpToolDefinition[] {
    return [...this.tools];
  }

  public getCapabilities() {
    return this.serverCapabilities;
  }

  public async connect(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
      cwd: this.cwd,
    });

    const proc = this.process;

    proc.stdout!.on("data", (chunk: Buffer) => {
      // 用 StringDecoder 而不是 chunk.toString()：UTF-8 多字节字符可能被
      // 管道切在两个 chunk 中间，逐块 toString 会把它变成 U+FFFD
      this.buffer += this.stdoutDecoder.write(chunk);
      this.processBuffer();
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[MCP:${this.serverName}] ${chunk.toString().trim()}`);
    });

    // spawn 失败（命令不存在、没权限等）是异步的 'error' 事件；
    // 不监听会变成未捕获异常，把整个 agent 带走
    proc.on("error", (err) => {
      console.error(`[MCP:${this.serverName}] Failed to spawn: ${err.message}`);
      if (this.process === proc) this.process = null;
      this.cleanupPending(new Error(`Failed to spawn MCP server ${this.serverName}: ${err.message}`));
    });

    proc.on("exit", (code) => {
      console.error(`[MCP:${this.serverName}] Server exited, code=${code}`);
      if (this.process === proc) this.process = null;
      this.cleanupPending(new Error(`Server exited, code=${code}`));
    });

    // 2026-07-28 没有建会话的握手：server/discover 只是个普通 RPC，
    // 用来在正式调用前问一次对端支持什么版本、有什么能力
    const discoverResult = await this.discoverAndValidate();
    this.serverCapabilities = discoverResult.capabilities;
    const listRes = await this.toolsList();
    this.tools = listRes.tools;
    console.error(`[MCP:${this.serverName}] Connected, loaded ${this.tools.length} tools`);
  }

  /**
   * stdio 上没有 HTTP 状态码可用，规范建议客户端先发一次 server/discover，
   * 在正式调用前把版本和能力确定下来。失败时给用户一个能行动的报错，
   * 而不是笼统的 "connect failed"。
   */
  private async discoverAndValidate(): Promise<ServerDiscoverResult> {
    let discover: ServerDiscoverResult;
    try {
      discover = await this.serverDiscover();
    } catch (err) {
      throw this.describeDiscoveryFailure(err);
    }

    const supported = discover.supportedVersions ?? [];
    if (!supported.includes(PROTOCOL_VERSION)) {
      throw new Error(
        `[MCP:${this.serverName}] 服务端支持的协议版本是 [${supported.join(", ")}]，` +
          `本客户端只实现 ${PROTOCOL_VERSION}`
      );
    }
    return discover;
  }

  private describeDiscoveryFailure(err: unknown): Error {
    if (err instanceof McpRpcError) {
      if (err.code === UNSUPPORTED_PROTOCOL_VERSION) {
        const supported = (err.data as { supported?: unknown } | undefined)?.supported;
        const list = Array.isArray(supported) ? supported.join(", ") : "未知";
        return new Error(
          `[MCP:${this.serverName}] 服务端不支持协议版本 ${PROTOCOL_VERSION}，它支持的是 [${list}]`
        );
      }
      if (err.code === METHOD_NOT_FOUND) {
        return new Error(
          `[MCP:${this.serverName}] 服务端不认识 server/discover，` +
            `说明它不是 ${PROTOCOL_VERSION} 的服务端，本客户端只支持该版本`
        );
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  public async disconnect(): Promise<void> {
    const proc = this.process;
    this.process = null;

    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // 必须等子进程真的退出：SIGTERM 之后立刻 process.exit()，
      // 会把它（以及它的孙子进程）留成孤儿
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        proc.once("exit", done);
        proc.once("error", done);
        proc.kill("SIGTERM");
        // 兜底：3 秒还没退就 SIGKILL
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3000).unref();
      });
    }

    this.cleanupPending(new Error("Client disconnected"));
  }

  public async serverDiscover(): Promise<ServerDiscoverResult> {
    return await this.sendRequest<ServerDiscoverResult>("server/discover", {});
  }

  public async toolsList(): Promise<ToolsListResult> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    // tools/list 支持分页：不跟 nextCursor 会静默漏掉后面的工具。
    // 设页数上限，避免服务端一直回同一个 cursor 把这里拖死。
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const res = await this.sendRequest<ToolsListResult>(
        "tools/list",
        cursor === undefined ? {} : { cursor }
      );
      if (Array.isArray(res.tools)) tools.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }

    return { resultType: "complete", tools };
  }

  /**
   * result 是服务端发来的 JSON，联合类型只是编译期假设，必须按运行期取值判断
   */
  public async toolsCall(params: ToolCallParams): Promise<ToolCallCompleteResult> {
    const result = await this.sendRequest<ToolCallResult>("tools/call", params);

    // 协议要求：旧版 server（2025-11-25 及更早）不返回 resultType，
    // 客户端 MUST 视为 "complete"。这里就是那条向后兼容规则的落点。
    const resultType = result?.resultType ?? "complete";

    switch (resultType) {
      case "complete":
        return result as ToolCallCompleteResult;

      case "input_required":
        // 协议允许服务端发起 MRTR 问询，但本客户端未声明 elicitation 能力
        throw new Error(
          `[MCP:${this.serverName}] 服务端返回 input_required，但客户端未声明 elicitation 能力`
        );

      default: {
        // 编译期：协议新增 ResultType 会在此报错；运行期：畸形值在此被拦下
        const _exhaustive: never = resultType;
        throw new Error(
          `[MCP:${this.serverName}] 未知的 tools/call resultType: ${String(_exhaustive)}`
        );
      }
    }
  }

  /**
   * 底层发送请求：自动合并注入 _meta，上层无需关心
   */
  private async sendRequest<T>(method: string, params: object = {}): Promise<T> {
    if (!this.process || !this.process.stdin?.writable) {
      throw new Error(`MCP server ${this.serverName} is not connected`);
    }
    const id = ++this.requestIdCounter;

    // 自动注入meta；支持params自带_meta做覆盖（高级场景）
    const extraMeta = (params as { _meta?: MetaObject })._meta;
    const finalParams = {
      ...params,
      _meta: { ...this.clientMeta, ...extraMeta },
    };

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: finalParams,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timeout (id:${id})`));
      }, 30000);
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      const payload = JSON.stringify(req) + "\n";
      this.process!.stdin!.write(payload);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        this.handleMessage(msg);
      } catch {
        // 忽略非json行
      }
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (msg.id === undefined) return;
    const pending = this.pendingRequests.get(Number(msg.id));
    if (!pending) return;
    this.pendingRequests.delete(Number(msg.id));
    clearTimeout(pending.timeout);
    if (msg.error) {
      pending.reject(
        new McpRpcError(
          msg.error.code,
          `RPC error ${msg.error.code}: ${msg.error.message}`,
          msg.error.data
        )
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private cleanupPending(error: Error) {
    for (const item of this.pendingRequests.values()) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    this.pendingRequests.clear();
  }
}