import type { PermissionRule } from "./types.js";

/**
 * 默认权限规则
 *
 * 分工：
 *   - DENY  : 只放危险 bash 命令，deny 永远最高优先
 *   - 文件工具: 统一 allow，安全性交给 guard 的两道前置关卡
 *               (越界 deny + 敏感路径 ask)，规则层保持极简
 *   - 其余命令: 白名单 allow，未命中由 evaluate 兜底为 ask
 *
 * bash 的 pattern 是「子串匹配」(命令串包含该子串即命中)，文件类工具的
 * pattern 是 glob——命令不是路径，子串更简单可预期。
 */
export const defaultRules: PermissionRule[] = [
  // DENY: 绝对禁止的危险操作(按子串匹配)

  {
    tool: "bash",
    pattern: "rm -rf / ",
    action: "deny",
    reason: "Refusing to rm -rf root",
  },
  {
    tool: "bash",
    pattern: "rm -rf /*",
    action: "deny",
    reason: "Refusing to rm -rf root",
  },
  {
    tool: "bash",
    pattern: "rm -rf ~ ",
    action: "deny",
    reason: "Refusing to rm -rf home",
  },
  {
    tool: "bash",
    pattern: "rm -rf ~/*",
    action: "deny",
    reason: "Refusing to rm -rf home",
  },
  {
    tool: "bash",
    pattern: "mkfs",
    action: "deny",
    reason: "mkfs is too dangerous for an agent",
  },
  {
    tool: "bash",
    pattern: "> /dev/sd",
    action: "deny",
    reason: "Direct disk write blocked",
  },
  {
    tool: "bash",
    pattern: "chmod -R 777 / ",
    action: "deny",
    reason: "Mass permission change blocked",
  },
  {
    tool: "bash",
    pattern: "| bash",
    action: "deny",
    reason: "Piping remote script to shell blocked",
  },
  {
    tool: "bash",
    pattern: "| sh",
    action: "deny",
    reason: "Piping remote script to shell blocked",
  },
  {
    tool: "bash",
    pattern: "|& bash",
    action: "deny",
    reason: "Piping remote script to shell blocked",
  },
  {
    tool: "bash",
    pattern: "|& sh",
    action: "deny",
    reason: "Piping remote script to shell blocked",
  },

  // ALLOW: 文件读写 + 安全的只读/开发命令

  { tool: "agent", action: "allow" },
  { tool: "read_file", action: "allow" },
  { tool: "write_file", action: "allow" },
  { tool: "edit_file", action: "allow" },
  { tool: "grep", action: "allow" },
  { tool: "glob", action: "allow" },
  { tool: "list_files", action: "allow" },
  { tool: "bash", pattern: "ls ", action: "allow" },
  { tool: "bash", pattern: "cat ", action: "allow" },
  { tool: "bash", pattern: "head ", action: "allow" },
  { tool: "bash", pattern: "tail ", action: "allow" },
  { tool: "bash", pattern: "wc ", action: "allow" },
  { tool: "bash", pattern: "grep ", action: "allow" },
  { tool: "bash", pattern: "echo ", action: "allow" },
  { tool: "bash", pattern: "pwd ", action: "allow" },
  { tool: "bash", pattern: "cd ", action: "allow" },
  { tool: "bash", pattern: "which ", action: "allow" },
  { tool: "bash", pattern: "diff ", action: "allow" },
  { tool: "bash", pattern: "stat ", action: "allow" },
  { tool: "bash", pattern: "du ", action: "allow" },
  // 刻意不放 `find `: find 的 -exec / -delete 是执行和删除原语,
  // 一旦放行就等于从规则层整个漏出去(CC 有沙箱兜底, ling 没有)
  { tool: "bash", pattern: "git status", action: "allow" },
  { tool: "bash", pattern: "git log", action: "allow" },
  { tool: "bash", pattern: "git diff", action: "allow" },
  // 这几个子命令无论带什么参数都是只读的，可以放心 allow。
  // 但 `git branch` / `git remote` / `git tag` 不在其列 —— 它们不带参数时
  // 是列出，带参数就是改仓库(-d/-D/-m/-f)，而子串匹配分不出这两种，
  // 所以宁可不放。要放就得先加一串 deny 把它们按在最前面。
  { tool: "bash", pattern: "git show", action: "allow" },
  { tool: "bash", pattern: "git blame", action: "allow" },
  { tool: "bash", pattern: "git rev-parse", action: "allow" },
  { tool: "bash", pattern: "git ls-files", action: "allow" },
  { tool: "bash", pattern: "git describe", action: "allow" },
  { tool: "bash", pattern: "npm run ", action: "allow" },
  { tool: "bash", pattern: "npm test", action: "allow" },
  { tool: "bash", pattern: "npx tsc", action: "allow" },

  // 未命中任何规则的调用由 evaluate 兜底为 ask(安全第一)。
  // 注意:不要在这里放无 pattern 的 bash ask 规则——它会匹配所有 bash 调用,
  // 导致上面的 allow 规则永远不可达。
];

/**
 * 默认受保护路径——即使有 allow 规则也要确认 */
export const defaultProtectedPaths = [
  ".git/**",
  "**/.env*",
  // 凭证文件按「名字」保护, 不按目录: .ling/ 下还有 mcp.json / hooks.json 等
  // 工具配置, 那些是应该让 agent 自己读的, 整目录保护会连带挡住它们。
  // 按名字匹配还有个好处 —— 文件挪到项目外也照样命中(实测 **/*.ling.json 能匹配绝对路径)
  "**/*.ling.json",
  ".claude/**",
  ".vscode/**",
  "node_modules/**",
  "**/*.key",
  "**/*.pem",
  "**/credentials*",
  "**/secret*",
];
