// CLI 参数解析 - 用 Node.js 内置的 parseArgs

import { parseArgs } from "node:util";

export interface CliOptions {
  // 非交互模式
  print?: string;

  // 输出格式
  format: "text" | "json" | "stream";
  schema?: string;  // JSON Schema 文件路径

  // 模型配置: 只反映用户显式传了什么。
  // 默认值不在这里给 —— 交给 resolveConfig 的优先级链
  // (命令行 > 环境变量 > .ling.json > 默认值) 统一兜底
  provider?: string;
  model?: string;
  maxTurns: number;

  // 会话管理
  continue: boolean;
  resume?: string;
  name?: string;
  listSessions: boolean;

  // 其他
  help: boolean;
  version: boolean;
}

/** 解析命令行参数。args 为不含 node 与脚本路径的参数列表 */
export function parseCli(args: string[]): CliOptions {
  const { values } = parseArgs({
    args,
    options: {
      // 非交互
      print: {type: "string", short: "p"},

      // 输出
      format: { type: "string", short: "f", default: "text"},
      schema: { type: "string"},

      // 模型
      provider: { type: "string"},
      model: {type: "string", short: "m"},
      "max-turns": { type: "string", default: "20"},

      // 会话
      continue: { type: "boolean", short: "c", default: false},
      resume: { type: "string", short: "r"},
      name: { type: "string", short: "n"},
      "list-sessions": { type: "boolean", short: "l", default: false},

      // 元信息
      help: {type: "boolean", short: "h", default: false},
      version: {type: "boolean", short: "v", default: false},
    },
    strict: true,
  });

  // strict 只拦得住未知 flag, 拦不住非法值。这两项不校验的话会静默跑飞:
  // max-turns 解析成 NaN 时循环一次都不进, 未知 format 时 switch 没有分支
  const maxTurns = parseInt(values["max-turns"] as string, 10);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(
      `--max-turns must be a positive integer, got "${values["max-turns"]}"`,
    );
  }

  const format = values.format as string;
  if (format !== "text" && format !== "json" && format !== "stream") {
    throw new Error(`--format must be one of text|json|stream, got "${format}"`);
  }

  return {
    print: values.print as string | undefined,
    format,
    schema: values.schema as string | undefined,
    provider: values.provider as string | undefined,
    model: values.model as string | undefined,
    maxTurns,
    continue: values.continue as boolean,
    resume: values.resume as string | undefined,
    name: values.name as string | undefined,
    listSessions: values["list-sessions"] as boolean,
    help:  values.help as boolean,
    version: values.version as boolean,
  };

}

/** 从 stdin 读取管道输入 */
export async function readStdin(): Promise<string | null> {
  // 1.如果从 stdin 是 TTY(终端),说明没有管道输入
  if ( process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await ( const chunk of process.stdin){
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf-8").trim();
  return text || null;
}