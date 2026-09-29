import * as readline from "readline/promises";
import type { Message, ProviderConfig } from "./providers/index.js";
import { initProvider } from "./providers/index.js";
import { createToolRegistry } from "./tool/index.js";

const systemPrompt = `You are ling, a coding assistant. You have access to tools to read, write, edit files , search code, and run commands. Use tools to accomplish tasks step by step.`;

const registry = createToolRegistry();

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
async function agentLoop(
  query: string,
  config: Partial<ProviderConfig>,
  history: Message[],
) {
  const provider = initProvider(config);

  history.push({ role: "user", content: query });

  const MAX_TURNS = 20;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await provider.chat(history, registry.toToolDefinitions());

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
      const args = JSON.parse(tc.arguments);
      let result: string;
      try {
        result = await registry.execute(name, args);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }

      console.log(
        `[tool] ${tc.name}(${JSON.stringify(args)}) -> ${result.slice(0, 100)}...`,
      );
      history.push({ role: "tool", toolCallId: tc.id, content: result });
    }
  }

  console.log("[ling] Reached max turns, stopping.");
  return "(reached max turns)";
}

// === 入口 ===
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const config = parseArgs();
  const history: Message[] = [];

  // 加载 systemPrompt
  history.push({
    role: "system",
    content: systemPrompt,
  });

  console.log("Ling Agent — type your request, Ctrl+C to exit\n");

  while (true) {
    let input: string;
    try {
      input = await rl.question("You: ");
    } catch {
      break; // stdin 已关闭（Ctrl+D 或管道读完）
    }
    if (!input.trim()) continue;

    try {
      const reply = await agentLoop(input, config, history);
      console.log(`\nLing: ${reply}\n`);
    } catch (err) {
      console.log(`Error: ${(err as Error).message}\n`);
    }
  }

  rl.close();
}

main();
