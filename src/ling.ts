// src/ling.ts — REPL 入口

import * as readline from "readline/promises";
import { calculateBudget, estimateTokens } from "./context/index.js";
import { parseConfirmation } from "./permissions/index.js";
import { ToolCallCollector } from "./providers/index.js";
import { createConfig, detectMetadata } from "./config/config.js";
import type { LingApp } from "./config/config.js";
import type { Session } from "./session/index.js";
import type { HookContext, HookResult } from "./hooks/index.js";
import { parseCli, readStdin, runPrintMode } from "./cli/index.js";

const VERSION = "0.1.0";

const HELP = `
Ling - AI Coding Agent
 
Usage:
  ling [options]                  Start interactive REPL
  ling -p "query"                 Non-interactive mode
  cat file | ling -p "analyze"    Pipe input + query
 
Options:
  -p, --print <query>    Non-interactive mode, print result and exit
  -f, --format <fmt>     Output format: text (default), json, stream
      --schema <file>    Constrain output with JSON Schema
      --provider <name>  LLM provider (default: deepseek)
  -m, --model <name>     Model name (default: deepseek-flash)
      --max-turns <n>    Max agent loop turns (default: 20)
  -c, --continue         Resume last session
  -r, --resume <id>      Resume specific session
  -n, --name <name>      Name the session
  -h, --help             Show this help
  -v, --version          Show version
`;

/**
 * hook 失败提醒
 */
function reportHookFailures(
  app: LingApp,
  event: HookContext["event"],
  results: HookResult[],
): void {
  for (const r of results) {
    if (!r.ok) {
      const detail = (r.error ?? "unknown error").slice(0, 200);
      app.renderer.warn(`[hook] ${event} 未生效: ${detail}`);
    }
  }
}

// === Agent 主循环 ===
async function agentLoop(query: string, session: Session, app: LingApp) {
  const { provider, registry, renderer, compactor, guard, hooks } = app;

  session.messages.push({ role: "user", content: query });

  // 自动压缩上下文
  if (compactor.shouldCompact(session.messages)) {
    console.log("[ling] Context getting large, auto-compacting...");
    session.messages = await compactor.compact(session.messages);
  }

  // 跟非交互模式共用同一个 --max-turns, 免得同名的 flag 只在一边生效
  const MAX_TURNS = app.cliArgs.maxTurns;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    renderer.reset();
    const collector = new ToolCallCollector();
    let fullText = "";

    for await (const chunk of provider.stream(
      session.messages,
      registry.toToolDefinitions(),
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

    // 没有工具调用 → 模型已经给出最终回答, 结束
    if (toolCalls.length === 0) {
      const stopResults = await hooks.trigger({
        event: "Stop",
        sessionId: session.id,
        timestamp: Date.now(),
      });
      reportHookFailures(app, "Stop", stopResults);
      return;
    }

    // 执行工具
    for (const tc of toolCalls) {
      const toolName = tc.name;
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
      const decision = await guard.check(toolName, params);
      if (!decision.allowed) {
        // 带上原因, 模型才知道该换个什么法子, 而不是盲目重试同一条命令
        const reason = decision.reason ?? "blocked by the permission system";
        session.messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: `Permission denied: ${reason}. Try a different approach.`,
        });
        continue; // 跳过执行，但不中断
      }

      // 权限通过, 正常执行
      const summary = JSON.stringify(params).slice(0, 60);
      renderer.startToolExecution(toolName, summary);

      // --- PreToolUse Hook ---
      const preContext: HookContext = {
        event: "PreToolUse",
        sessionId: session.id,
        timestamp: Date.now(),
        toolCall: { tool: toolName, params: params },
      };
      const preResults = await hooks.trigger(preContext);
      reportHookFailures(app, "PreToolUse", preResults);

      // 检查是否被拦截
      const blocked = preResults.find((r) => r.blocked);
      if (blocked) {
        console.log(`[hook] Blocked: ${blocked.blockReason}`);
        session.messages.push({
          role: "tool",
          toolCallId: tc.id,
          content: `Tool call blocked by hook: ${blocked.blockReason}`,
        });

        renderer.stopToolExecution(toolName, false);
        continue;
      }

      // 按序应用所有改动: engine 也是按同样顺序累计的, 结果一致
      for (const r of preResults) {
        if (r.modifiedParams) {
          params = { ...params, ...r.modifiedParams };
          console.log(`[hook] Params modified`);
        }
      }

      // 执行工具调用
      // agent 工具走的是同一条路: 它自己持有 spawner, 不再是主循环的特判
      let result: string;
      let success = true;

      try {
        result = await registry.execute(toolName, params, {
          toolCallId: tc.id,
        });
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
        success = false;
      }

      renderer.stopToolExecution(toolName, success);

      // --- PostToolUse Hook ---
      const postResults = await hooks.trigger({
        event: "PostToolUse",
        sessionId: session.id,
        timestamp: Date.now(),
        toolCall: { tool: toolName, params: params, result },
      });
      reportHookFailures(app, "PostToolUse", postResults);

      session.messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: result,
      });
    }
  }

  console.log("[ling] Reached max turns, stopping.");
}

// === 入口 ===
async function main() {

  let earlyArgs;
  try {
    earlyArgs = parseCli(process.argv.slice(2));
  } catch (err) {
    // 参数非法和配置错误一样, 都在 CLI 边界收敛成退出码
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
  if (earlyArgs.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (earlyArgs.version) {
    console.log(`ling v${VERSION}`);
    process.exit(0);
  }

  let app: LingApp;
  try {
    app = await createConfig();
  } catch (err) {
    // 配置错误(缺 key 等)在 CLI 边界上才收敛成退出码
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const {
    cliArgs,
    providerConfig,
    projectRoot,
    contextWindow,
    registry,
    permissionConfig,
    renderer,
    sessions,
    hooks,
    systemPrompt,
    provider,
  } = app;

  // --list-sessions: 打印后退出
  if (cliArgs.listSessions) {
    const list = await sessions.list();
    if (list.length === 0) {
      console.log("No sessions found");
      return;
    }
    console.log("Sessions:\n");
    for (const s of list) {
      const date = new Date(s.updatedAt).toLocaleString();
      const label = s.name ? `${s.name}` : s.id.slice(0, 8);
      const preview = s.lastUserMessage ?? "(empty)";
      console.log(`  ${label}  ${s.messageCount} msgs  ${date}`);
      console.log(`    ${preview}\n`);
    }
    // createConfig 已经把 MCP 子进程拉起来了, 提前返回也要收尸
    await app.shutdown();
    return;
  }

  // --- 非交互模式 ---
  // 用 !== undefined 判断: -p "" 也是显式请求非交互模式, 不该掉回 REPL
  if (cliArgs.print !== undefined) {
    // 检查是否有 stdin 管道输入
    const stdinContent = await readStdin();
    let query = cliArgs.print;

    if (stdinContent) {
      // 把 stdin 内容拼进 query
      query = `${stdinContent}\n\n---\n\n${query}`;
    }

    // try/finally: 出错(如 401)时同样要收掉 MCP 子进程, 否则被 reparent 留在系统里。
    // runPrintMode 只回退出码、不自己 exit, 就是为了让这个 finally 一定跑到。
    let exitCode = 0;
    try {
      exitCode = await runPrintMode(app, query, cliArgs, provider);
    } finally {
      await app.shutdown().catch(() => {});
    }
    process.exit(exitCode);
  }

  // 决定是新建还是恢复会话
  let session: Session;

  if (cliArgs.continue) {
    const latestId = await sessions.getLatestId();
    if (!latestId) {
      console.log("No previous session found. Starting new session.");
      session = await sessions.create(
        detectMetadata(
          projectRoot,
          providerConfig.provider,
          providerConfig.model,
        ),
        cliArgs.name,
      );
    } else {
      session = (await sessions.load(latestId))!;
      console.log(
        `Resuming session ${session.id.slice(0, 8)}... (${session.messages.length} messages)`,
      );
    }
  } else if (cliArgs.resume) {
    // 加载指定会话
    const loaded = await sessions.load(cliArgs.resume);
    if (!loaded) {
      console.error(`Session not found: ${cliArgs.resume}`);
      process.exit(1);
    }
    session = loaded;
    console.log(
      `Resuming session ${session.id.slice(0, 8)}... (${session.messages.length} messages)`,
    );
  } else {
    session = await sessions.create(
      detectMetadata(
        projectRoot,
        providerConfig.provider,
        providerConfig.model,
      ),
      cliArgs.name,
    );
    console.log(`New session: ${session.id.slice(0, 8)}`);
  }

  // 退出时收掉 MCP 子进程, 否则它们会被 reparent 留在系统里
  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.shutdown().catch(() => {});
    process.exit(code);
  }
  // 挂了 SIGINT handler 后必须显式 exit, 否则 Ctrl+C 不再能终止进程
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(0));

  // 启动时打印预算信息
  session.messages = [
    { role: "system" as const, content: systemPrompt },
    ...session.messages,
  ];

  const toolDefs = JSON.stringify(registry.toToolDefinitions());
  const budget = calculateBudget(contextWindow, systemPrompt, toolDefs, "");
  console.log(
    `[ling] Project detected. System prompt: ${budget.systemPrompt} tokens`,
  );
  console.log(
    `[ling] Budget: ${budget.available} tokens available (${budget.reserved} reserved for tool results)`,
  );
  // Permission rule
  console.log(`Project root: ${permissionConfig.projectRoot}`);
  console.log(`Rules loaded: ${permissionConfig.rules.length}\n`);

  // 准备读取用户的输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 宿主 I/O 就绪, 一次性把两个通道回填给 app:
  // 权限确认和 ask_user 都复用 REPL 自己这一个 readline, 避免抢 stdin
  app.attachHostIO({
    confirm: async (tool, arg, reason) => {
      const display = arg.length > 80 ? arg.slice(0, 77) + "..." : arg;
      console.error(
        `\n[permission] ${tool}: ${display}${reason ? ` (${reason})` : ""}`,
      );
      const answer = await rl.question("Allow? [Y/n]: ");
      return parseConfirmation(answer);
    },
    // ask_user 提问期间要把 spinner 让出来,
    // 否则用户正在输入的内容每 80ms 被重画盖掉
    ask: async (question) => {
      renderer.pauseSpinner();
      try {
        return await rl.question(`\n🤖 Agent asks: ${question}\n> `);
      } finally {
        renderer.resumeSpinner();
      }
    },
  });

  console.log(`Ling Agent v${VERSION}\n`);

  // 触发 SessionStart Hook
  const startResults = await hooks.trigger({
    event: "SessionStart",
    sessionId: session.id,
    timestamp: Date.now(),
  });
  reportHookFailures(app, "SessionStart", startResults);

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
      session.messages = await app.compactor.compact(session.messages);
      await sessions.save(session);
      console.log("[ling] Conversation compacted.");
      continue;
    }

    try {
      await agentLoop(input, session, app);

      // 每轮对话后自动保存
      await sessions.save(session);
    } catch (err) {
      console.log(`Error: ${(err as Error).message}\n`);
    }
  }

  rl.close();
  await shutdown(0);
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
