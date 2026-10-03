// src/config/config.ts — 组合根
//
// 所有组件的创建集中在这里, 按依赖顺序构造, 调用方拿到一个装配好的对象。
//
// 刻意不导出模块级单例(export const provider = ...): 那样的话创建发生在
// "某个模块被 import 的那一刻", 时机不受调用方控制, 而且一次进程只能有一份 ——
// 测试换不掉件, SDK / CI 入口也会被 initProvider 的报错堵死。
// 包成函数, 创建就发生在 createConfig() 被调用的那一刻。

import { initProvider, resolveConfig, StreamRenderer } from "../providers/index.js";
import type { LLMProvider, ProviderConfig } from "../providers/index.js";
import { createToolRegistry } from "../tool/index.js";
import type { ToolRegistry, AskChannel, AskFn } from "../tool/index.js";
import { buildSystemPrompt, Compactor, getGitBranch } from "../context/index.js";
import { PermissionGuard, loadPermissionConfig } from "../permissions/index.js";
import type { ConfirmFn, PermissionConfig } from "../permissions/index.js";
import { SessionStore } from "../session/index.js";
import type { SessionMetadata } from "../session/index.js";
import { HookEngine, loadHooksConfig } from "../hooks/index.js";
import { loadMcpServers, shutdownMcpServers } from "../mcp/index.js";
import { AgentSpawner, buildAgentTool } from "../agents/index.js";

/** CLI 参数解析 */
export interface CliArgs {
  continue: boolean; // --continue：恢复最近一次会话
  resume?: string; // --resume <id>：恢复指定会话
  name?: string; // --name <name>：给会话命名
  listSessions: boolean; // --list-sessions：列出历史
}

/**
 * 宿主交互通道。REPL 用自己那一个 readline 实现它, SDK 走自己的通道,
 * CI 不给 —— 不给就是无交互模式(确认一律拒绝, ask_user 返回报错串)。
 */
export interface HostIO {
  confirm: ConfirmFn;
  ask: AskFn;
}

export interface CreateConfigOptions {
  /** 命令行参数(不含 node 和脚本名)。默认 process.argv.slice(2) */
  argv?: string[];
  /** 项目根, 相对路径的锚点。默认 process.cwd() */
  projectRoot?: string;
  /** 上下文窗口 token 数。默认读 CONTEXT_WINDOW 环境变量 */
  contextWindow?: number;
}

export interface LingApp {
  cliArgs: CliArgs;
  providerConfig: Partial<ProviderConfig>;
  projectRoot: string;
  contextWindow: number;

  provider: LLMProvider;
  registry: ToolRegistry;
  guard: PermissionGuard;
  permissionConfig: PermissionConfig;
  hooks: HookEngine;
  renderer: StreamRenderer;
  sessions: SessionStore;
  compactor: Compactor;
  spawner: AgentSpawner;
  systemPrompt: string;

  /** 宿主通道就绪后回填。可在 createConfig 之后任意时刻调用 */
  attachHostIO(io: HostIO): void;
  /** 收掉 createConfig 期间拉起的资源(MCP 子进程) */
  shutdown(): Promise<void>;
}

// === 解析命令行参数 ===
export function parseArgs(argv: string[]): {
  cliArgs: CliArgs;
  providerConfig: Partial<ProviderConfig>;
} {
  const providerConfig: Partial<ProviderConfig> = {};
  const cliArgs: CliArgs = { continue: false, listSessions: false };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--provider":
      case "-p":
        providerConfig.provider = argv[++i] as ProviderConfig["provider"];
        break;
      case "--model":
      case "-m":
        providerConfig.model = argv[++i];
        break;
      case "--continue":
      case "-c":
        cliArgs.continue = true;
        break;
      case "--resume":
      case "-r":
        cliArgs.resume = argv[++i];
        break;
      case "--name":
      case "-n":
        cliArgs.name = argv[++i];
        break;
      case "--list-sessions":
      case "-l":
        cliArgs.listSessions = true;
        break;
      default:
        break;
    }
  }

  return { cliArgs, providerConfig };
}

// 会话元信息: 只在创建时写入, 记录这次对话发生的环境
export function detectMetadata(
  projectRoot: string,
  providerConfig: Partial<ProviderConfig>,
): SessionMetadata {
  const { provider, model } = resolveConfig(providerConfig);
  return {
    cwd: projectRoot,
    provider,
    model,
    gitBranch: getGitBranch(projectRoot),
  };
}

/**
 * 按依赖顺序装配全部组件。
 *
 * 缺 API key 等配置错误会抛异常, 由调用方决定怎么收场 —— CLI 打印并 exit(1),
 * 测试断言, CI 记录失败。这里不 process.exit。
 */
export async function createConfig(
  opts: CreateConfigOptions = {},
): Promise<LingApp> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const contextWindow =
    opts.contextWindow ?? parseInt(process.env.CONTEXT_WINDOW || "32000", 10);

  const { cliArgs, providerConfig } = parseArgs(
    opts.argv ?? process.argv.slice(2),
  );

  // 宿主通道槽位: 先建空壳, attachHostIO 时回填。
  // 工具在 execute 时才读它, 所以回填晚于注册也没问题。
  const host: AskChannel = {};

  const provider = initProvider(providerConfig);
  const registry = createToolRegistry({ host });
  const permissionConfig = loadPermissionConfig(projectRoot);
  // 先不传 confirmFn: 未注入交互通道时保持"需要确认即拒绝"的原有语义
  const guard = new PermissionGuard(permissionConfig);
  const renderer = new StreamRenderer();
  const sessions = new SessionStore();
  const compactor = new Compactor(provider, {
    keepRecentTurns: 4,
    maxHistoryTokens: 50000,
  });

  const hooks = new HookEngine();
  hooks.load(await loadHooksConfig(projectRoot));

  // spawner 必须在 registry 之后: 它要绑定这一份 registry
  const spawner = new AgentSpawner(provider, registry);

  registry.register(buildAgentTool(spawner));

  // MCP 的加载与收尾配成一对, 都归 shutdown() 管
  const { clients, tools } = await loadMcpServers(projectRoot);
  for (const tool of tools) {
    if (registry.get(tool.name)) {
      console.error(`[mcp] 工具 ${tool.name} 与已注册工具重名，已跳过`);
      continue;
    }
    registry.register(tool);
  }

  // system prompt 是派生状态, 每次启动重建, 拼到会话最前面
  const systemPrompt = await buildSystemPrompt({ cwd: projectRoot });

  return {
    cliArgs,
    providerConfig,
    projectRoot,
    contextWindow,
    provider,
    registry,
    guard,
    permissionConfig,
    hooks,
    renderer,
    sessions,
    compactor,
    spawner,
    systemPrompt,

    attachHostIO(io: HostIO): void {
      host.ask = io.ask;
      guard.confirmFn = io.confirm;
    },

    async shutdown(): Promise<void> {
      await shutdownMcpServers(clients).catch(() => {});
    },
  };
}
