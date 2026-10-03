// src/agents/scheduler.ts — 并行调度器

import type { SubAgentConfig, SubAgentResult } from "./types.js";
import { AgentSpawner } from "./spawner.js";

/** 调度任务 */
export interface SchedulerTask {
  config: SubAgentConfig;
  task: string;
}

export async function runParaller(
  spawner: AgentSpawner,
  tasks: SchedulerTask[],
  options: { timeoutMs?: number } = {},
): Promise<SubAgentResult[]> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000; // 默认 5 分钟超时

  console.log(
    `\n[Scheduler] Running ${tasks.length} tasks in parallel with timeout ${timeoutMs}ms`,
  );

  const startTime = Date.now();
  // 给每个任务加上超时
  const promises = tasks.map(({ config, task }) => {
    return Promise.race([
      spawner.spawn(config, task),
      timeout(timeoutMs, config.name),
    ]);
  });

  const results = await Promise.all(promises);

  const elapsed = Date.now() - startTime;
  const succeeded = results.filter((r) => r.success).length;
  console.log(
    `\n[scheduler] Done. ${succeeded}/${results.length} succeeded in ${elapsed}ms`,
  );

  return results;
}

/**
 * 串行运行,一个接着一个跑,前一个的输出可以传给下一个
 */
export async function runSequential(
  spawner: AgentSpawner,
  tasks: SchedulerTask[],
): Promise<SubAgentResult[]> {
  console.log(`\n[scheduler] Running ${tasks.length} agents sequentially...`);

  const results: SubAgentResult[] = [];

  // 依次执行每个任务
  for (const { config, task } of tasks) {
    const result = await spawner.spawn(config, task);
    results.push(result);

    // 如果某个子 Agent 失败了,后续的可能也没意义了
    if (!result.success) {
      console.log(`[scheduler] ${config.name} failed, stopping pipeline.`);
      break;
    }
  }

  return results;
}

/** 超时 helper */
function timeout(ms: number, name: string): Promise<SubAgentResult> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          name,
          success: false,
          output: "",
          turns: 0,
          durationMs: ms,
          error: `Timeout after ${ms}ms`,
        }),
      ms,
    ),
  );
}


/** 把多个子 agent 的结果聚合在一起,生成摘要 */
export function summarizeResults(results: SubAgentResult[]): string {
  const lines: string[] = ["## Sub-Agent Results"];

  for( const result of results){
    const status = result.success ? " OK" : "FAILED";
    lines.push(`### ${result.name} [${status}] (${result.turns} truns, ${result.durationMs}ms)`);
    if (result.error){
      lines.push(`- Error: ${result.error}`);
    }
    lines.push(result.output);
    lines.push("");
  }

  return lines.join("\n");
}