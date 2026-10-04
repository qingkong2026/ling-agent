// src/hooks/engine.ts — HookEngine：注册、匹配、触发、执行

import { spawn } from "child_process";
import type {
  HookContext,
  HookResult,
  HookRule,
  HooksConfig,
  CommandHandler,
  HttpHandler,
} from "./types.js";

export class HookEngine {
  private rules: HookRule[] = [];

  /** 从配置加载所有规则 */
  load(config: HooksConfig): void {
    this.rules = config.hooks;
    console.error(`[hooks] Loaded ${this.rules.length} hooks`);
  }

  /** 手动注册一条规则 */
  register(rule: HookRule): void {
    this.rules.push(rule);
  }

  /**
   * 触发某个事件,返回所有 handler 的结果
   * 串行执行: 后面的 handler 能看到前面 handler 改过的参数
   * 对于 PreToolUse：任一 handler 返回 blocked=true 即拦截, 但仍会跑完所有 handler
   */
  async trigger(ctx: HookContext): Promise<HookResult[]> {
    const matched = this.match(ctx);
    if (matched.length === 0) return [];

    const results: HookResult[] = [];
    // 默认沿用原始 ctx(同一个引用,不复制); 只有前面的 handler 确实改了参数才重建
    let current = ctx;

    for (const rule of matched) {
      if (rule.async) {
        // 异步: fire-and-forget
        this.execute(rule, current).catch((err) => {
          console.error(`[hooks] Async handler error:`, err.message);
        });
        results.push({ ok: true, output: "(async, no wait)" });
      } else {
        // 同步,等结果
        const result = await this.execute(rule, current);
        results.push(result);

        // 被拦截也继续跑完后续 handler:
        // 拦截结论本身与顺序无关, 但不该让审计/埋点这类副作用随配置顺序时有时无
        if (result.modifiedParams && current.toolCall) {
          current = {
            ...current,
            toolCall: {
              ...current.toolCall,
              params: { ...current.toolCall.params, ...result.modifiedParams },
            },
          };
        }
      }
    }

    return results;
  }

  /**
   * 按事件类型 + matcher 正则匹配规则
   * @param ctx
   */
  private match(ctx: HookContext): HookRule[] {
    return this.rules.filter((rule) => {
      // 事件类型必须匹配
      if (rule.event !== ctx.event) return false;

      // 如果有 matcher 正则,只对 PreToolUse / PostToolUse 生效
      if (rule.matcher) {
        if (!ctx.toolCall) return false;
        try {
          return new RegExp(rule.matcher).test(ctx.toolCall.tool);
        } catch {
          // matcher 写错只当不匹配,不能把整个 turn 带崩
          console.warn(`[hooks] Invalid matcher: ${rule.matcher}`);
          return false;
        }
      }

      return true;
    });
  }

  /**
   * 分发到具体的 handler 执行
   * @param rule
   * @param ctx
   */
  private async execute(rule: HookRule, ctx: HookContext): Promise<HookResult> {
    try {
      switch (rule.handler.type) {
        case "command":
          return await this.executeCommand(rule.handler, ctx);
        case "http":
          return await this.executeHttp(rule.handler, ctx);
        default:
          return { ok: false, error: "Unknown handler type" };
      }
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 执行 shell 命令，把 HookContext 通过 stdin 传入
   * @param handler
   * @param ctx
   */
  private executeCommand(
    handler: CommandHandler,
    ctx: HookContext,
  ): Promise<HookResult> {
    return new Promise((resolve) => {
      const timeout = handler.timeout ?? 10_000;
      const child = spawn("sh", ["-c", handler.command], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // 把上下文 JSON 写入 stdin
      // handler 可能不读 stdin 就退出, 这时写入会 EPIPE;
      // 不接住会变成未捕获的 stream error, 直接崩掉整个进程
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify(ctx));
      child.stdin.end();

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ ok: false, error: `Command timed out after ${timeout}ms` });
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);

        if (code === 0) {
          // 尝试解析 stdout 为 JSON，提取 modifiedParams / blocked
          const result: HookResult = { ok: true, output: stdout.trim()};
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.modifiedParams) {
              result.modifiedParams = parsed.modifiedParams;
            }
            if (parsed.blocked) {
              result.blocked = true;
              result.blockReason = parsed.blockReason ?? "Blocked by hook";
            }
          } catch {
            // stdout 不是 JSON，没关系
          }
          resolve(result);
        } else {
          resolve({
            ok: false,
            error: stderr.trim() || `Exit code ${code}`,
          });
        }
      });
    });
  }

  /**
   * POST JSON 到 URL
   * @param handler
   * @param ctx
   */
  private async executeHttp(
    handler: HttpHandler,
    ctx: HookContext,
  ): Promise<HookResult> {
    const timeout = handler.timeout ?? 5_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(handler.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...handler.headers,
        },
        body: JSON.stringify(ctx),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const body = await resp.text();

      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${body}` };
      }

      return { ok: true, output: body };
    } catch (err: any) {
      clearTimeout(timer);
      return { ok: false, error: err.message };
    }
  }
}
