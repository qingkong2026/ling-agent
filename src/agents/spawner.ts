// src/agents/spawner.ts 子 Agent 的创建和管理

import type {
  LLMProvider,
  ToolDefinition,
  Message,
} from "../providers/index.js";
import { ToolRegistry } from "../tool/index.js";
import type { Tool, ToolExecContext } from "../tool/index.js";

import type { SubAgentConfig, SubAgentResult } from "./types.js";
import { resolveRole } from "./roles.js";

const DEFAULT_MAX_TURNS = 15; // 默认最大对话轮次

// --- agent 工具: 让 LLM 自己决定何时启动子 Agent
//
// spawner 由调用方(组合根)注入, 而不是在这里 import 一个全局单例 ——
// 这样工具拿到的是"本次运行"的 spawner, 它背后的 registry 也是本次的。
export function buildAgentTool(spawner: AgentSpawner): Tool {
  return {
    name: "agent",
    description: `Launch a sub-agent to handle a task independently. The sub-agent has its own context and tools. Available roles: plan (read-only analysis), code (full tools), review (read-only review).`,
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["plan", "code", "review"],
          description: "The role of the sub-agent",
        },
        name: {
          type: "string",
          description:
            "A short name for this sub-agent (e.g. 'route-migrator')",
        },
        task: {
          type: "string",
          description: "The specific task for the sub-agent",
        },
      },
      required: ["role", "task"],
    },
    async execute(params, ctx) {
      const role = params.role as string;
      const task = params.task as string;
      const name = (params.name as string) || `${role}-agent`;

      const config = resolveRole(role, name, task);
      if (!config) return `Unknown role: ${role}`;

      // 把本次调用的 id 传给子 Agent, 它的结果里会带上父指针
      const result = await spawner.spawn(config, task, {
        parentToolCallId: ctx.toolCallId,
      });
      return result.success
        ? result.output
        : `[${result.name}] Failed: ${result.error}\n${result.output}`;
    },
  };
}

export class AgentSpawner {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;

  constructor(provider: LLMProvider, toolRegistry: ToolRegistry) {
    this.provider = provider;
    this.toolRegistry = toolRegistry;
  }

  /** 启动一个子 Agent, 返回其最终输出 */
  async spawn(
    config: SubAgentConfig,
    task: string,
    opts: { parentToolCallId?: string } = {},
  ): Promise<SubAgentResult> {
    const startTime = Date.now();
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const parentToolCallId = opts.parentToolCallId;

    // 1.从全局工具表中过滤出 Agent 允许用的工具
    const allowedTools: ToolDefinition[] = [];
    const executors = new Map<
      string,
      (params: Record<string, unknown>, ctx: ToolExecContext) => Promise<string>
    >();

    for (const toolName of config.tools) {
      const entry = this.toolRegistry.get(toolName);
      if (entry) {
        allowedTools.push(entry);
        executors.set(toolName, entry.execute);
      }
    }

    // 2.独立的消息历史 - 这是上下文隔离的关键
    const messages: Message[] = [
      { role: "system", content: config.role },
      { role: "user", content: task },
    ];

    console.log(
      `\n[${config.name}] Started (provider=${this.provider.name}, tools=${config.tools.join(",")}, parent=${parentToolCallId ?? "main"})`,
    );

    let turns = 0;
    try {
      while (turns < maxTurns) {
        turns++;
        // 3.调用 LLM Provider 获取响应
        const response = await this.provider.chat(
          messages,
          allowedTools.length > 0 ? allowedTools : undefined,
        );

        // 4.记录 Assistant 的输出
        messages.push({
          role: "assistant",
          content: response.content ?? "",
          toolCalls:
            response.toolCalls.length > 0 ? response.toolCalls : undefined,
        });

        // 没有工具调用,子 Agent 结束
        if (response.toolCalls.length === 0) {
          console.log(`[${config.name}] Completed in ${turns} turns`);
          return {
            name: config.name,
            success: true,
            output: response.content ?? "",
            turns,
            durationMs: Date.now() - startTime,
            parentToolCallId,
          };
        }

        // 执行工具调用
        for (const tc of response.toolCalls) {
          const toolName = tc.name;
          const params = JSON.parse(tc.arguments);

          // 安全检查,子 Agent 只能调用允许的工具
          const executor = executors.get(toolName);
          if (!executor) {
            messages.push({
              role: "tool",
              toolCallId: tc.id,
              content: `Error: tool "${toolName}" is not allowed for this agent.`,
            });
            continue;
          }

          console.log(
            `[${config.name}] ${toolName} id=${tc.id} (${tc.arguments.slice(0, 100)})`,
          );

          // 执行工具调用; 把本次调用的 id 传下去, 子 Agent 再 spawn 时才能接上链路
          const result = await executor(params, { toolCallId: tc.id });
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: result,
          });
        }
      }

      // 超过最大轮次
      console.log(`[${config.name}] Exceeded max turns (${maxTurns})`);
      return {
        name: config.name,
        success: false,
        output: "Reached maximum turns without completing.",
        turns,
        durationMs: Date.now() - startTime,
        error: `Exceeded ${maxTurns} turns`,
        parentToolCallId,
      };
    } catch (err) {
      return {
        name: config.name,
        success: false,
        output: "",
        turns,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
        parentToolCallId,
      };
    }
  }
}
