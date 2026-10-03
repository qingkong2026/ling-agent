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

/** 把用户的 y/n 输入解析为是否同意(空输入算同意,回车接受默认) */
export function parseConfirmation(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "" || a === "y" || a === "yes";
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
  ) {}

  /**
   * 检查一次工具调用是否被允许
   * 返回 true = 放行，返回 false = 被拒绝或用户拒绝
   */
  async check(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const primaryArg = extractPrimaryArg(toolName, params);
    const ctx: PermissionCheckContext = { toolName, params, primaryArg };

    // 第一关: 文件系统边界检查
    const boundaryResult = this.checkBoundary(ctx);
    if (boundaryResult) {
      console.error(`\n[DENIED] ${boundaryResult}`);
      return false;
    }

    // 第二关: 受保护路径检查(命中则强制走确认)
    const protectedResult = this.checkProtectedPath(ctx);
    if (protectedResult) {
      return this.askUser(toolName, primaryArg, `Protected path: ${protectedResult}`);
    }

    // 第三关: 规则评估
    const result = evaluate(this.config.rules, ctx);

    switch (result.action) {
      case "allow":
        return true;
      case "deny":
        console.error(`\n[DENIED] ${result.reason}`);
        return false;
      case "ask":
        return this.askUser(toolName, primaryArg, result.reason);
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
    // 未注入交互通道(如 SDK 场景)时无法询问,安全起见拒绝
    console.error(`\n[DENIED] 需要确认但无交互通道: ${toolName} ${primaryArg}`);
    return false;
  }
}
