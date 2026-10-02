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

  if (compactor.shouldCompact(history)) {
    console.log("[ling] Context getting large, auto-compacting...");
    history = await compactor.compact(history);
  }

  const MAX_TURNS = 20;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await provider.chat(history, toolRegistry.toToolDefinitions());

    // 把 assistant 消息存入历史
    history.push({
      role: "assistant",
      content: res.content || "",
      toolCalls: res.toolCalls.length > 0 ? res.toolCalls : undefined,
    });

    // 没有工具调用,输出结果,结束
    if (res.finishReason !== "tool_calls" || res.toolCalls.length == 0) {
      return res.content ?? "(no response)";
    }

    // 执行工具
    for (const tc of res.toolCalls) {
      const name = tc.name;
      const params = JSON.parse(tc.arguments);

      // ---- 权限检查：在执行前拦截 ----
      const allowed = await permissionGuard.check(name, params);
      if(!allowed){
        history.push({
          role: "tool",
          toolCallId: tc.id,
          content: `Permission denied: this operation was blocked by the permission system. Try a different approach.`,
        });
        continue; // 跳过执行，但不中断
      }

      // 权限通过, 正常执行
      let result: string;
      try {
        result = await toolRegistry.execute(name, params);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }

      console.log(
        `[tool] ${tc.name}(${JSON.stringify(params)}) -> ${result.slice(0, 100)}...`,
      );
      history.push({ role: "tool", toolCallId: tc.id, content: result });
    }
  }

  console.log("[ling] Reached max turns, stopping.");
  return "(reached max turns)";
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
  console.log(`Rules loaded: ${permissionConfig.rules.length}\n`)


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
      const reply = await agentLoop(input);
      console.log(`\nLing: ${reply}\n`);
    } catch (err) {
      console.log(`Error: ${(err as Error).message}\n`);
    }
  }

  rl.close();
}

main();
