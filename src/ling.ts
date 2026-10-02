import * as readline from "readline/promises";
import type { Message, ProviderConfig } from "./providers/index.js";
import { initProvider } from "./providers/index.js";
import { createToolRegistry } from "./tool/index.js";
import { buildSystemPrompt } from "./context/system-prompts.js";
import { Compactor } from "./context/compactor.js";
import { calculateBudget, estimateTokens } from "./context/token-budget.js";
import {
  PermissionGuard,
  loadPermissionConfig,
  parseConfirmation,
} from "./permissions/index.js";
import { StreamRenderer } from "./providers/renderer.js";
import { ToolCallCollector } from "./providers/collector.js";

const CONTEXT_WINDOW = parseInt(process.env.CONTEXT_WINDOW || "32000", 10);
const cwd = process.cwd();

const toolRegistry = createToolRegistry();
const argsConfig = parseArgs();
const provider = initProvider(argsConfig);
const compactor = new Compactor(provider, {
  keepRecentTurns: 4,
  maxHistoryTokens: 50000,
});

// Permission
const permissionConfig = loadPermissionConfig();
const permissionGuard = new PermissionGuard(permissionConfig);

// renderer
const renderer = new StreamRenderer();

let history: Message[] = [];

// === 解析命令行参数 ===
function parseArgs(): Partial<ProviderConfig> {
  const args = process.argv.slice(2);
  const config: Partial<ProviderConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
      case "-p":
        config.provider = args[++i] as ProviderConfig["provider"];
        break;
      case "--model":
      case "-m":
        config.model = args[++i];
        break;
      default:
        break;
    }
  }

  return config;
}

// === Agent 主循环 ===
async function agentLoop(query: string) {
  history.push({ role: "user", content: query });

  // 自动压缩上下文
  if (compactor.shouldCompact(history)) {
    console.log("[ling] Context getting large, auto-compacting...");
    history = await compactor.compact(history);
  }

  const MAX_TURNS = 20;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    renderer.reset();
    const collector = new ToolCallCollector();
    let fullText = "";

    for await (const chunk of provider.stream(
      history,
      toolRegistry.toToolDefinitions(),
    )) {
      // 1.渲染到终端
      renderer.onChunk(chunk);

      // 2.收集文本
      if (chunk.type == "text") {
        fullText += chunk.content;
      }

      // 3.收集工具调用片段
      collector.feed(chunk);
    }

    // 收集结果
    const toolCalls = collector.drain();

    // 把 assistant 消息存入历史
    history.push({
      role: "assistant",
      content: fullText || "",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    // 执行工具
    for (const tc of toolCalls) {
      const name = tc.name;
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(tc.arguments);
      } catch {
        // 参数非法: 也必须回一条 tool_result, 否则 tool_use 会失去配对
        history.push({
          role: "tool",
          toolCallId: tc.id,
          content: "Error: invalid JSON in tool arguments",
        });
        continue;
      }

      // ---- 权限检查：在执行前拦截 ----
      const allowed = await permissionGuard.check(name, params);
      if (!allowed) {
        history.push({
          role: "tool",
          toolCallId: tc.id,
          content: `Permission denied: this operation was blocked by the permission system. Try a different approach.`,
        });
        continue; // 跳过执行，但不中断
      }

      // 权限通过, 正常执行
      const summary = JSON.stringify(params).slice(0, 60);
      renderer.startToolExecution(name, summary);

      // 执行工具调用
      let result: string;
      let success = true;
      try {
        result = await toolRegistry.execute(name, params);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
        success = false;
      }

      renderer.stopToolExecution(name, success);

      history.push({ role: "tool", toolCallId: tc.id, content: result });
    }

    // 没有工具调用 → 模型已经给出最终回答, 结束
    if (toolCalls.length === 0) {
      return;
    }
  }

  console.log("[ling] Reached max turns, stopping.");
}

// === 入口 ===
async function main() {
  // 1.初始化上下文环境
  const systemPrompt = buildSystemPrompt({ cwd });
  // 启动时打印预算信息
  const toolDefs = JSON.stringify(toolRegistry.toToolDefinitions());
  const budget = calculateBudget(CONTEXT_WINDOW, systemPrompt, toolDefs, "");
  console.log(
    `[ling] Project detected. System prompt: ${budget.systemPrompt} tokens`,
  );
  console.log(
    `[ling] Budget: ${budget.available} tokens available (${budget.reserved} reserved for tool results)`,
  );
  // Permission rule
  console.log(`Project root: ${permissionConfig.projectRoot}`);
  console.log(`Rules loaded: ${permissionConfig.rules.length}\n`);

  history.push({ role: "system", content: systemPrompt });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 权限确认复用 REPL 自己的 readline,避免抢 stdin
  permissionGuard.confirmFn = async (tool, arg, reason) => {
    const display = arg.length > 80 ? arg.slice(0, 77) + "..." : arg;
    console.error(
      `\n[permission] ${tool}: ${display}${reason ? ` (${reason})` : ""}`,
    );
    const answer = await rl.question("Allow? [Y/n]: ");
    return parseConfirmation(answer);
  };

  console.log("Ling Agent — type your request, Ctrl+C to exit\n");

  while (true) {
    const historyTokens = estimateTokens(JSON.stringify(history));
    let input: string;
    try {
      input = await rl.question(`[${historyTokens} tokens]> : `);
    } catch {
      break; // stdin 已关闭（Ctrl+D 或管道读完）
    }
    if (!input.trim()) continue;

    // compact 命令: 手动触发压缩
    if (input.trim() === "/compact") {
      history = await compactor.compact(history);
      console.log("[ling] Conversation compacted.");
      continue;
    }

    try {
      await agentLoop(input);
    } catch (err) {
      console.log(`Error: ${(err as Error).message}\n`);
    }
  }

  rl.close();
}

main();
