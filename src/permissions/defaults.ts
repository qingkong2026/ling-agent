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
    pattern: "rm -rf /",
    action: "deny",
    reason: "Refusing to rm -rf root",
  },
  {
    tool: "bash",
    pattern: "rm -rf ~",
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
    pattern: "chmod -R 777 /",
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

  // ALLOW: 文件读写 + 安全的只读/开发命令
  //
  // 文件工具按「当前目录内直接放行」处理：
  //   - 越界(项目根之外)由 guard 的边界检查挡下，这里管不到
  //   - .env/.git 等敏感路径由 protectedPaths 强制确认
  // 所以文件工具无需逐条枚举 pattern，统一 allow 即可(见 guard.ts)。
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
  { tool: "bash", pattern: "git status", action: "allow" },
  { tool: "bash", pattern: "git log", action: "allow" },
  { tool: "bash", pattern: "git diff", action: "allow" },
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
  ".claude/**",
  ".vscode/**",
  "node_modules/**",
  "**/*.key",
  "**/*.pem",
  "**/credentials*",
  "**/secret*",
];
