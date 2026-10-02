import * as readline from "readline/promises";
import type { ProviderConfig } from "./providers/index.js";
import { initProvider, resolveConfig } from "./providers/index.js";
import { createToolRegistry } from "./tool/index.js";
import { buildSystemPrompt } from "./context/index.js";
import { Compactor } from "./context/index.js";
import {
  calculateBudget,
  estimateTokens,
  getGitBranch,
} from "./context/index.js";
import {
  PermissionGuard,
  loadPermissionConfig,
  parseConfirmation,
} from "./permissions/index.js";
import { StreamRenderer } from "./providers/index.js";
import { ToolCallCollector } from "./providers/index.js";
import { Session, SessionMetadata, SessionStore } from "./session/index.js";

const CONTEXT_WINDOW = parseInt(process.env.CONTEXT_WINDOW || "32000", 10);

const cwd = process.cwd();

const toolRegistry = createToolRegistry();
const { cliArgs, providerConfig } = parseArgs();
const provider = initProvider(providerConfig);
const compactor = new Compactor(provider, {
  keepRecentTurns: 4,
  maxHistoryTokens: 50000,
});

// Permission
const permissionConfig = loadPermissionConfig();
const permissionGuard = new PermissionGuard(permissionConfig);

// renderer
const renderer = new StreamRenderer();

// 会话存储管理
const sessionStore = new SessionStore();

// CLI 参数解析
interface CliArgs {
  continue: boolean; // --continue：恢复最近一次会话
  resume?: string; // --resume <id>：恢复指定会话
  name?: string; // --name <name>：给会话命名
  listSessions: boolean; // --list-sessions：列出历史
}

// === 解析命令行参数 ===
function parseArgs(): {
  cliArgs: CliArgs;
  providerConfig: Partial<ProviderConfig>;
} {
  const args = process.argv.slice(2);

  const providerConfig: Partial<ProviderConfig> = {};
  const cliArgs: CliArgs = { continue: false, listSessions: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
      case "-p":
        providerConfig.provider = args[++i] as ProviderConfig["provider"];
        break;
      case "--model":
      case "-m":
        providerConfig.model = args[++i];
        break;
      case "--continue":
      case "-c":
        cliArgs.continue = true;
        break;
      case "--resume":
      case "-r":
        cliArgs.resume = args[++i];
        break;
      case "--name":
      case "-n":
        cliArgs.name = args[++i];
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
function detectMetadata(): SessionMetadata {
  const { provider, model } = resolveConfig(providerConfig);
  return { cwd, provider, model, gitBranch: getGitBranch(cwd) };
}

// === Agent 主循环 ===
async function agentLoop(query: string, session: Session) {
  session.messages.push({ role: "user", content: query });

  // 自动压缩上下文
  if (compactor.shouldCompact(session.messages)) {
    console.log("[ling] Context getting large, auto-compacting...");
    session.messages = await compactor.compact(session.messages);
  }

  const MAX_TURNS = 20;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    renderer.reset();
    const collector = new ToolCallCollector();
    let fullText = "";

    for await (const chunk of provider.stream(
      session.messages,
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
    session.messages.push({
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
        session.messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: "Error: invalid JSON in tool arguments",
        });
        continue;
      }

      // ---- 权限检查：在执行前拦截 ----
      const allowed = await permissionGuard.check(name, params);
      if (!allowed) {
        session.messages.push({
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

      session.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: result,
      });
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
  // --list-sessions: 打印后退出
  if (cliArgs.listSessions) {
    const sessions = await sessionStore.list();
    if (sessions.length === 0) {
      console.log("No sessions found");
      return;
    }
    console.log("Sessions:\n");
    for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleString();
      const label = s.name ? `${s.name}` : s.id.slice(0, 8);
      const preview = s.lastUserMessage ?? "(empty)";
      console.log(`  ${label}  ${s.messageCount} msgs  ${date}`);
      console.log(`    ${preview}\n`);
    }
    return;
  }

  // 决定是新建还是恢复会话
  let session: Session;

  if (cliArgs.continue) {
    const latestId = await sessionStore.getLatestId();
    if (!latestId) {
      console.log("No previous session found. Starting new session.");
      session = await sessionStore.create(detectMetadata(), cliArgs.name);
    } else {
      session = (await sessionStore.load(latestId))!;
      console.log(
        `Resuming session ${session.id.slice(0, 8)}... (${session.messages.length} messages)`,
      );
    }
  } else if (cliArgs.resume) {
    // 加载指定会话
    const loaded = await sessionStore.load(cliArgs.resume);
    if (!loaded) {
      console.error(`Session not found: ${cliArgs.resume}`);
      process.exit(1);
    }
    session = loaded;
    console.log(
      `Resuming session ${session.id.slice(0, 8)}... (${session.messages.length} messages)`,
    );
  } else {
    session = await sessionStore.create(detectMetadata(), cliArgs.name);
    console.log(`New session: ${session.id.slice(0, 8)}`);
  }

  // 初始化上下文环境: system prompt 是派生状态, 每次启动重建, 拼到会话最前面
  const systemPrompt = await buildSystemPrompt({ cwd });
  session.messages = [
    { role: "system", content: systemPrompt },
    ...session.messages,
  ];

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
    const historyTokens = estimateTokens(JSON.stringify(session.messages));
    let input: string;
    try {
      input = await rl.question(`[${historyTokens} tokens]> : `);
    } catch {
      break; // stdin 已关闭（Ctrl+D 或管道读完）
    }
    if (!input.trim()) continue;

    // compact 命令: 手动触发压缩
    if (input.trim() === "/compact") {
      session.messages = await compactor.compact(session.messages);
      await sessionStore.save(session);
      console.log("[ling] Conversation compacted.");
      continue;
    }

    try {
      await agentLoop(input, session);

      // 每轮对话后自动保存
      await sessionStore.save(session);
    } catch (err) {
      console.log(`Error: ${(err as Error).message}\n`);
    }
  }

  rl.close();
}

main();
