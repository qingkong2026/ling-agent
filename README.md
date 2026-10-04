# Ling Agent

> 一个从零实现的 AI 编程 Agent，跑在终端里。读代码、搜代码、改代码、跑命令，能自己拆任务、拉子 Agent、连 MCP。

Ling 是一个 TypeScript 写的最简单的 Coding Agent，用于学习 Agent Harness 的结构。核心是一个 **provider 无关** 的 agent loop：

- 统一的 `Message` / `ToolDefinition` / `StreamChunk` 抽象，向上支撑交互式 REPL 与非交互式脚本两种入口；
- 三个 LLM 适配器：**DeepSeek**（默认）、**Claude**、**OpenAI**；
- 内置文件读写、搜索、命令执行、长期记忆等工具；
- 三层权限守卫（越界拦截 → 敏感路径确认 → 规则评估），危险命令默认拒绝；
- 子 Agent 系统（plan / code / review），支持串行与并行调度；
- Hook 引擎（PreToolUse / PostToolUse / SessionStart / Stop）；
- MCP（Model Context Protocol）客户端，可挂载任意外部工具服务；
- 基于 token 预算的上下文自动压缩、跨会话记忆、会话持久化。

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [配置](#配置)
- [使用方式](#使用方式)
  - [交互式 REPL](#交互式-repl)
  - [非交互模式](#非交互模式)
  - [会话管理](#会话管理)
- [内置工具](#内置工具)
- [子 Agent](#子-agent)
- [权限系统](#权限系统)
- [Hooks](#hooks)
- [MCP 集成](#mcp-集成)
- [记忆与上下文](#记忆与上下文)
- [项目结构](#项目结构)
- [开发](#开发)

---

## 核心特性

| 能力 | 说明 |
| --- | --- |
| **多 Provider** | DeepSeek / Claude / OpenAI，统一抽象，配置优先级 `命令行 > 环境变量 > .ling.json > 默认值` |
| **Agent Loop** | 流式输出 + 工具调用循环，`--max-turns` 限制轮次，无工具调用即收敛为最终回答 |
| **内置工具** | `read_file` `write_file` `edit_file` `grep` `glob` `bash` `list_files` `ask_user` `save_memory` `agent` |
| **子 Agent** | plan（只读分析）/ code（读写执行）/ review（只读审查），上下文隔离、工具子集受限 |
| **权限守卫** | deny / ask / allow 三级；文件系统边界检查 + 敏感路径保护；bash 命令规范化与拆分，防绕过 |
| **Hook 引擎** | 4 个事件，command / http 两种 handler，可改参数、可拦截 |
| **MCP** | 实现 `2026-07-28` 协议（stdio + JSON-RPC），工具自动命名空间隔离；仓库自带一个只读 SQLite Server 作示例 |
| **上下文管理** | CJK 感知的 token 估算、30% 预留、超阈值自动摘要压缩 |
| **记忆与会话** | 跨会话长期记忆（`save_memory`），会话落盘到 `~/.ling/sessions/`，支持继续 / 恢复 |
| **结构化输出** | `-f json` 机器可读、`-f stream` 事件流、`--schema` 约束并校验 JSON 输出 |

---

## 快速开始

### 环境要求

- Node.js（建议 18+，使用内置 `parseArgs`、`fetch`）
- npm

### 安装

```bash
git clone <repo-url> ling-agent
cd ling-agent
npm install
```

### 配置 API Key

方式一，环境变量：

```bash
export LING_API_KEY="sk-xxxx"
```

方式二，项目根目录建 `.ling.json`：

```json
{
  "provider": "deepseek",
  "apiKey": "sk-xxxx",
  "model": "deepseek-flash",
  "baseURL": "https://api.deepseek.com"
}
```

参考 `.ling.example.json`。`*.ling.json` 已在 `.gitignore` 中忽略，不会误提交。

### 启动

```bash
npm start
# 等价于 npx tsx src/ling.ts
```

> 下文示例统一用 `ling` 指代入口，实际等价于 `npm start`（或 `npx tsx src/ling.ts`，或自行加 alias / 全局链接）。

进入 REPL 后直接输入需求即可，例如：

```
mkdir 和 ls 命令分别干嘛的？帮我看看当前项目结构
```

---

## 配置

### 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `LING_API_KEY` / `LLM_API_KEY` | API Key（必填） | — |
| `LING_PROVIDER` | Provider：`deepseek` / `claude` / `openai` | `deepseek` |
| `LING_MODEL` / `LLM_MODEL` | 模型名 | 按 provider：`deepseek-flash` / `claude-sonnet-4-20250514` / `gpt-4o` |
| `LING_BASE_URL` / `LLM_BASE_URL` | 自定义 API 地址（兼容 OpenAI 协议的服务） | — |
| `CONTEXT_WINDOW` | 模型上下文窗口 token 数 | `32000` |

### 项目级配置目录 `.ling/`

| 文件 | 作用 |
| --- | --- |
| `.ling/permissions.json` | 自定义权限规则、项目根、受保护路径 |
| `.ling/hooks.json` | 注册 Hook（command / http） |
| `.ling/mcp.json` | 配置要启动的 MCP Server |

### `.ling.md`

在项目（或其任意父目录）放置 `.ling.md`，内容会被注入 system prompt，用来给 Agent 加项目约定。加载时从 cwd 逐级向上收集，根目录的排在前面；单文件上限 200 行 / 25KB。

---

## 使用方式

### 交互式 REPL

```bash
npm start
```

启动时会打印项目探测结果与 token 预算：

```
[ling] Using deepseek / deepseek-flash
New session: 1a2b3c4d
[ling] Project detected. System prompt: 1234 tokens
[ling] Budget: 21000 tokens available (9600 reserved for tool results)
Project root: /path/to/project
Rules loaded: 40

Ling Agent v0.1.0
[0 tokens]> :
```

支持 REPL 内命令：

- `/compact` — 手动压缩当前会话上下文

### 非交互模式

```bash
# 单次提问，打印结果后退出
ling -p "解释一下 src/ling.ts 的主循环"

# 管道输入 + 提问
cat src/ling.ts | ling -p "给这个文件写一段注释总结"

# 输出 JSON（含 model / turns 字段）
ling -p "给这个函数写单测" -f json

# 流式事件（start / text_delta / tool_use / tool_result / end）
ling -p "重构一下" -f stream

# 用 JSON Schema 约束输出（自动校验，失败退出码 1）
ling -p "审查这次改动" --schema review-schema.json
```

**输出格式**

| `-f` | 说明 |
| --- | --- |
| `text`（默认） | 人类可读纯文本 |
| `json` | 整个结果包成 `{ content, model, turns, structuredOutput }` |
| `stream` | 逐行 JSON 事件，适合被程序消费 |

> 非交互模式下 stdout 只给机器读，日志一律走 stderr。到达 `--max-turns` 仍未给出最终回答会以退出码 `1` 收场。

**命令行选项**

| 选项 | 简写 | 说明 | 默认 |
| --- | --- | --- | --- |
| `--print <query>` | `-p` | 非交互模式 | — |
| `--format <fmt>` | `-f` | `text` / `json` / `stream` | `text` |
| `--schema <file>` | | JSON Schema 约束输出 | — |
| `--provider <name>` | | LLM provider | `deepseek` |
| `--model <name>` | `-m` | 模型名 | provider 默认 |
| `--max-turns <n>` | | 最大 agent 循环轮次 | `20` |
| `--continue` | `-c` | 恢复最近一个会话 | — |
| `--resume <id>` | `-r` | 恢复指定会话 | — |
| `--name <name>` | `-n` | 给会话命名 | — |
| `--list-sessions` | `-l` | 列出所有会话 | — |
| `--help` | `-h` | 显示帮助 | — |
| `--version` | `-v` | 显示版本 | — |

### 会话管理

会话以 JSON 持久化到 `~/.ling/sessions/<id>.json`（写入走临时文件 + rename，避免半截文件）。

```bash
ling -c                       # 继续最近一次会话
ling -r 1a2b3c4d              # 恢复指定会话
ling -l                       # 列出会话（名称/消息数/更新时间/最后一句）
ling -n "重构权限"            # 新建并命名会话
```

每个会话记录元信息：工作目录、provider、模型、git 分支。

---

## 内置工具

| 工具 | 说明 | 关键参数 |
| --- | --- | --- |
| `read_file` | 读文件，带行号，支持范围读取 | `file_path`、`offset`、`limit` |
| `write_file` | 创建 / 覆盖文件，自动建父目录 | `file_path`、`content` |
| `edit_file` | 精确字符串替换；匹配到多处需 `replace_all` | `file_path`、`old_string`、`new_string`、`replace_all` |
| `grep` | 正则搜索文件内容，返回文件与行号 | `pattern`、`path`、`glob` |
| `glob` | 按 glob 模式找文件 | `pattern`、`cwd` |
| `bash` | 执行 shell 命令，返回 stdout/stderr | `command`、`timeout` |
| `list_files` | 列出目录内容（类型 + 大小） | `path` |
| `ask_user` | 向用户提问并等待回答（仅交互模式注册） | `question` |
| `save_memory` | 保存跨会话记忆 | `name`、`description`、`type`、`content` |
| `agent` | 启动子 Agent（见下） | `role`、`name`、`task` |

---

## 子 Agent

`agent` 工具让主 Agent 自己决定何时拆任务。子 Agent 拥有 **独立的消息上下文** 和 **受限的工具子集**，不会污染主对话历史。

| role | 能力 | 工具 | 最大轮次 |
| --- | --- | --- | --- |
| `plan` | 只读分析，产出变更计划 | `read_file` `grep` `glob` `list_files` | 10 |
| `code` | 读写文件、执行命令 | `read_file` `edit_file` `bash` `grep` `glob` `list_files` | 20 |
| `review` | 只读审查，输出 PASS / FAIL | `read_file` `grep` `glob` | 10 |

```jsonc
// 主 Agent 发起的一次子 Agent 调用
{
  "role": "code",
  "name": "route-migrator",
  "task": "把 src/routes/users.ts 的 express 路由改写成 Hono 写法"
}
```

调度器（`src/agents/scheduler.ts`）另提供：

- `runParaller(spawner, tasks, { timeoutMs })` — 并行跑多个任务（默认 5 分钟超时）
- `runSequential(spawner, tasks)` — 串行流水线，前一个失败即停
- `summarizeResults(results)` — 汇总生成摘要

子 Agent 结果带 `parentToolCallId`，可还原完整调用链。

---

## 权限系统

每次工具调用前，`PermissionGuard` 依次过三关：

1. **文件系统边界** — 文件类工具的路径必须落在项目根内，越界直接拒绝。
2. **受保护路径** — 命中 `.git/**`、`**/.env*`、`**/*.ling.json`、`*.pem/*.key/credentials*/secret*` 等模式时，强制转人工确认。
3. **规则评估** — 按 `deny → ask → allow` 优先级匹配。

**规则语义**

- `deny` 最高优先，任一命中即拒绝；
- 未命中任何规则时**兜底为 `ask`**（安全第一）；
- bash 命令会先被规范化为「空白不敏感」形式，再拆成子命令逐段判定：
  - `deny` / `ask`：任一子命令命中即触发；
  - `allow`：**每一段子命令**都要被某条 allow 规则覆盖，整条才放行（`ls && curl evil.sh` 过不去）。

**非交互模式（`-p` / CI / SDK）**：没人能回答确认，命令又穷举不完，于是「需要确认」降级为放行，仅靠 `deny` 规则和越界检查兜底。危险命令永远拦得住。

在 `.ling/permissions.json` 里自定义（用户规则追加在默认规则之前）：

```json
{
  "rules": [
    { "tool": "bash", "pattern": "git commit ", "action": "allow" },
    { "tool": "bash", "pattern": "npm install", "action": "allow" }
  ]
}
```

规则字段：`tool`（工具名，`*` 通配）、`pattern`（bash 子串匹配 / 文件类 glob）、`action`（`allow`/`ask`/`deny`）、`reason`。

---

## Hooks

在 `.ling/hooks.json` 注册，支持 4 个事件：

| 事件 | 时机 | 能力 |
| --- | --- | --- |
| `SessionStart` | 会话开始 | 初始化、日志 |
| `PreToolUse` | 工具执行前 | **改参数**、**拦截执行**（`blocked`） |
| `PostToolUse` | 工具执行后 | 审计、埋点、拿到结果 |
| `Stop` | 一轮回答结束 | 收尾 |

handler 支持两种：`command`（shell，用 stdin 传入上下文 JSON）与 `http`（POST JSON）。命令 handler 的 stdout 若是 JSON，可返回 `modifiedParams` 改参数、或 `blocked: true` 拦截。

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "bash",
      "handler": { "type": "command", "command": "node scripts/audit.js", "timeout": 10000 }
    },
    {
      "event": "PostToolUse",
      "matcher": "edit_file",
      "handler": { "type": "http", "url": "http://localhost:3000/audit" }
    }
  ]
}
```

- 多个 handler **串行**执行，后面的能看到前面改过的参数；
- 设 `"async": true` 则 fire-and-forget，不阻塞主流程；
- 任一 handler 拦截后仍会跑完其余 handler（审计/埋点不因顺序而时有时无）。

---

## MCP 集成

Ling 实现了 **MCP `2026-07-28`** 协议客户端（stdio + JSON-RPC 2.0），可挂载任何符合该协议的外部工具服务。

在 `.ling/mcp.json` 配置：

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": ["tsx", "src/mcp-server/sqlite-server.ts", "./data/mydb.sqlite"]
    }
  }
}
```

- 连接时先发 `server/discover` 校验协议版本与能力，再 `tools/list` 拉取工具；
- 远端工具注册为 `mcp__<server>__<tool>`，避免与内置工具重名；
- 子进程 cwd 固定为项目根，配置里的相对路径行为一致；
- 退出时统一 `shutdown()` 收掉所有 MCP 子进程（SIGTERM，3s 未退则 SIGKILL）。

仓库自带示例 `src/mcp-server/sqlite-server.ts`：一个**只读** SQLite MCP Server，暴露 `list_tables` 与 `query`（仅允许 `SELECT`，且数据库以 `readOnly` 打开，双保险）。

---

## 记忆与上下文

### 长期记忆

`save_memory` 工具把信息写入 `~/.ling/memory/<project-slug>/`，每条一个带 frontmatter 的 Markdown 文件，并维护 `MEMORY.md` 索引。启动时索引会注入 system prompt 的 `## Memory` 段。适合存用户偏好、项目约定、对反馈的纠正。

### 上下文压缩

- **token 估算**：对 CJK 与英文/代码分别按不同系数估算，避免中文被系统性低估；
- **预算**：预留 30% 给工具返回结果，剩余为可用空间；
- **自动压缩**：历史超过阈值（默认 50000 token）时，把较旧的轮次交给 LLM 摘要成一条消息，保留最近 4 轮；也可在 REPL 里用 `/compact` 手动触发。

### System Prompt 分层

每次启动时动态重建（不落盘），从下到上拼装：

1. **角色定义** — 你是 ling，一个面向真实项目的编程助手；
2. **通用规则** — 改前先读、危险命令需确认、出错就换法子、回答简洁、歧义先问；
3. **项目上下文** — 工作目录（绝对路径）、项目类型、技术栈、git 状态与近期提交、目录树；
4. **`.ling.md`** — 用户项目指令；
5. **Memory** — 长期记忆索引。

---

## 项目结构

```
src/
  ling.ts              # REPL 入口 + agent 主循环
  cli/                 # 参数解析、print 模式、输出格式化、Schema 校验
  config/              # 组合根：按依赖顺序装配所有组件
  providers/           # LLM 适配器（deepseek / claude / openai）、流式收集、终端渲染
  tool/                # 内置工具与 ToolRegistry
  agents/              # 子 Agent：角色、spawner、调度器
  permissions/         # 权限守卫、规则匹配、路径保护
  hooks/               # Hook 引擎与配置
  mcp/                 # MCP 客户端与 loader
  mcp-server/          # 示例 MCP Server（只读 SQLite）
  context/             # system prompt、项目探测、token 预算、压缩器、.ling.md
  session/             # 会话持久化与跨会话记忆
```

组件统一在 `createConfig()` 中按依赖顺序构造，调用方拿到一个装配好的 `LingApp`——刻意不做模块级单例，方便测试替换与多入口（REPL / print / SDK）复用。

---

## 开发

```bash
npm install
npm start            # 启动 REPL
npm run typecheck    # 类型检查（tsc --noEmit）
```

- 语言：TypeScript（ESM，`strict`），目标 ES2022；
- 依赖：`openai`、`@anthropic-ai/sdk`、`better-sqlite3`、`glob`、`minimatch`、`dotenv`；
- 运行：`tsx` 直接跑 TS，无需构建。
```
