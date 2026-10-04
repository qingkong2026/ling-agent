// Print 模式 - 非交互执行,跑完即退

import type {
  LLMProvider,
  Message,
  ToolDefinition,
} from "../providers/index.js";
import type { CliOptions } from "./parser.js";
import type { LingApp } from "../config/config.js";

import {
  extractJson,
  loadSchema,
  validateAgainstSchema,
} from "./schema-validator.js";
import { writeOutput, writeStreamEvent } from "./output.js";

/**
 * 非交互模式主函数
 */
export async function runPrintMode(
  app: LingApp,
  query: string,
  options: CliOptions,
  provider: LLMProvider,
): Promise<number> {
  // 初始化工具注册表和权限守卫
  const registry = app.registry;
  const permissionGuard = app.guard;
  let systemPrompt = app.systemPrompt;

  let schemaConstraint: ReturnType<typeof loadSchema> | null = null;
  if (options.schema) {
    schemaConstraint = loadSchema(options.schema);
    systemPrompt += "\n\n" + schemaConstraint.promptInstructions;
  }

  // 用户没显式传 -m 时 options.model 是 undefined, 解析后的模型在 providerConfig 里
  const model = app.providerConfig.model;

  const allTools: ToolDefinition[] = registry.toToolDefinitions();

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: query },
  ];

  // stream 模式发一个 start 事件
  if (options.format === "stream") {
    writeStreamEvent({ type: "start", model });
  }

  let turns = 0;
  let finalContent = "";
  // 区分"模型给出了最终回答"和"轮次烧光了" —— 后者不能当成功收场
  let answered = false;

  while (turns < options.maxTurns) {
    turns++;

    const response = await provider.chat(messages, allTools);
    finalContent = response.content ?? "";

    // stream 模式实时输出
    if (options.format === "stream" && finalContent) {
      writeStreamEvent({ type: "text_delta", content: finalContent });
    }

    messages.push({
      role: "assistant",
      content: finalContent,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    // 没有 tool_calls，说明模型给出了最终回答，结束循环
    if (response.toolCalls.length === 0) {
      answered = true;
      break;
    }

    // 有 tool_calls,执行
    for (const tc of response.toolCalls) {
      const toolName = tc.name;
      let args: Record<string, unknown>;

      try {
        args = JSON.parse(tc.arguments);
      } catch {
        // LLM 返回了无效 JSON，尝试修复常见问题
        const fixed = tc.arguments
          .replace(/float\('inf'\)/g, "null")
          .replace(/float\('nan'\)/g, "null")
          .replace(/'/g, '"');
        try {
          args = JSON.parse(fixed);
        } catch {
          const errorResult = `Error: invalid tool arguments: ${tc.arguments}`;
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            content: errorResult,
          });
          continue;
        }
      }

      if (options.format === "stream") {
        writeStreamEvent({
          type: "tool_use",
          tool: toolName,
          args: args,
        });
      }

      // 工具调用前的权限检查
      let result: string;
      const decision = await permissionGuard.check(toolName, args);
      if (!decision.allowed) {
        // 带原因回给模型, 它能据此换一个不被拒的做法, 而不是反复撞同一面墙
        const reason = decision.reason ?? "blocked by permission guard";
        result = `[Permission denied] Tool "${toolName}" was blocked: ${reason}`;
      } else {
        try {
          result = await registry.execute(toolName, args, {
            toolCallId: tc.id,
          });
        } catch (err) {
          result = `Error executing ${toolName}: ${(err as Error).message}`;
        }
      }

      if (options.format === "stream") {
        writeStreamEvent({ type: "tool_result", tool: toolName, result });
      }

      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: result,
      });
    }
  }

  if (!answered) {
    process.stderr.write(
      `Error: exceeded --max-turns (${options.maxTurns}) without a final answer. ` +
        `The model was still calling tools -- usually repeated permission denials.\n`,
    );
    return 1;
  }

  // 如果有 schema 约束,验证输出
  let structuredOutput: unknown = undefined;
  if (schemaConstraint) {
    try {
      const parsed = extractJson(finalContent);
      const { valid, errors } = validateAgainstSchema(
        parsed,
        schemaConstraint.schema,
      );

      if (!valid) {
        process.stderr.write(`Schema validation failed: ${errors.join(", ")}\n`);
        return 1;
      }

      structuredOutput = parsed;
      // schema 模式下，输出纯 JSON
      finalContent = JSON.stringify(parsed, null, 2);
    } catch (err) {
      process.stderr.write(
        `Failed to parse structured output: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  // 最终输出
  writeOutput(options.format, {
    content: finalContent,
    model,
    turns,
    structuredOutput,
  });

  return 0;
}
