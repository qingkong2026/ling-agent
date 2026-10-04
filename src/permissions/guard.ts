import { resolve, isAbsolute, relative } from "path";
import type { PermissionConfig, PermissionCheckContext } from "./types";
import { evaluate, extractPrimaryArg } from "./matcher.js";
import { extractPathCandidates, matchProtectedPath } from "./paths.js";

/** 宿主注入的确认通道：返回 true 表示用户同意 */
export type ConfirmFn = (
  toolName: string,
  primaryArg: string,
  reason?: string,
) => Promise<boolean>;

/**
 * 一次权限判定的结果。
 * 拒绝时带上 reason: 它会写进 tool_result 回给模型, 模型才知道
 * "为什么被拒、该换个什么法子", 而不是盲目重试。
 */
export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

/** 把用户的 y/n 输入解析为是否同意(空输入算同意,回车接受默认) */
export function parseConfirmation(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
}

export interface GuardOptions {
  /**
   * 宿主是否提供了交互通道。
   * false 表示非交互场景(CI / -p / SDK): 没人能回答"要不要继续",
   * 而命令是穷举不完的, 所以"需要确认"降级为放行, 只靠 deny 规则兜底。
   * undefined 表示宿主没声明 —— 保持 fail-closed, 一律拒绝。
   */
  interactive?: boolean;
}

/**
 * PermissionGuard - 权限守卫
 *
 * 在工具执行前拦截，根据规则决定：放行 / 确认 / 拒绝。
 * 确认交互由宿主注入(confirmFn)，guard 自己不碰 stdin。
 */
export class PermissionGuard {
  constructor(
    private config: PermissionConfig,
    public confirmFn?: ConfirmFn,
    private opts: GuardOptions = {},
  ) {}

  /**
   * 检查一次工具调用是否被允许
   * allowed=true 放行；allowed=false 被拒绝或用户拒绝, 并带上原因
   */
  async check(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const primaryArg = extractPrimaryArg(toolName, params);
    const ctx: PermissionCheckContext = { toolName, params, primaryArg };

    // 第一关: 文件系统边界检查
    const boundaryResult = this.checkBoundary(ctx);
    if (boundaryResult) {
      console.error(`\n[DENIED] ${boundaryResult}`);
      return { allowed: false, reason: boundaryResult };
    }

    // 第二关: 受保护路径检查(命中则强制走确认)
    const protectedResult = this.checkProtectedPath(ctx);
    if (protectedResult) {
      const reason = `Protected path: ${protectedResult}`;
      const ok = await this.askUser(toolName, primaryArg, reason);
      return ok ? { allowed: true } : { allowed: false, reason };
    }

    // 第三关: 规则评估
    const result = evaluate(this.config.rules, ctx);

    switch (result.action) {
      case "allow":
        return { allowed: true };
      case "deny":
        // 带上命令本身: 光看 reason 分不清是"真危险"还是规则误伤
        console.error(`\n[DENIED] ${result.reason}: ${toolName} ${primaryArg}`);
        return { allowed: false, reason: result.reason };
      case "ask": {
        const ok = await this.askUser(toolName, primaryArg, result.reason);
        return ok ? { allowed: true } : { allowed: false, reason: result.reason };
      }
    }
  }

  /**
   * 文件系统边界检查
   * 返回 null -> 通过,返回字符串 = 拒绝原因
   */
  private checkBoundary(ctx: PermissionCheckContext): string | null {
    const root = this.config.projectRoot;
    if (!root) return null;

    // 只检查文件相关工具
    const filePath =
      typeof ctx.params.file_path === "string"
        ? ctx.params.file_path
        : typeof ctx.params.path === "string"
          ? (ctx.params.path as string)
          : null;
    if (!filePath) return null;

    const absPath = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(root, filePath);

    // 用 relative 判断，避免 /proj 与 /proj-secret 的前缀误判
    const rel = relative(root, absPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return `Path "${filePath}" is outside project root "${root}"`;
    }

    return null;
  }

  /**
   * 受保护路径检查
   */
  private checkProtectedPath(ctx: PermissionCheckContext): string | null {
    const patterns = this.config.protectedPaths;
    if (!patterns?.length) return null;

    const root = this.config.projectRoot ?? process.cwd();
    const candidates = extractPathCandidates(ctx.toolName, ctx.params, root);
    return matchProtectedPath(candidates, patterns);
  }

  private async askUser(
    toolName: string,
    primaryArg: string,
    reason?: string,
  ): Promise<boolean> {
    if (this.confirmFn) return this.confirmFn(toolName, primaryArg, reason);

    // 非交互模式: 没有通道可问。宿主显式声明了 interactive === false,
    // 说明这是刻意的无人值守场景 —— 命令穷举不完, 于是"需要确认"降级为放行。
    // 危险命令仍由 deny 规则和越界检查兜底, 它们都不经过这里。
    if (this.opts.interactive === false) return true;

    // 宿主没声明是否交互(如 SDK 忘了回填通道): 保持安全默认, 拒绝
    console.error(`\n[DENIED] 需要确认但无交互通道: ${toolName} ${primaryArg}`);
    return false;
  }
}
