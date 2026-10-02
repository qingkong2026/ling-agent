import { isAbsolute, relative, resolve } from "path";
import { minimatch } from "minimatch";

/** bash 命令的粗略分词边界：空白 + shell 元字符 */
const SHELL_DELIMITERS = /[\s|;&<>()`"'=]+/;

/**
 * 把原始路径规范化为「项目相对形式」。
 *
 * protectedPaths 里的 pattern 是相对风格（.env* / .git/**），
 * 而工具多传绝对路径，直接整串匹配会全部落空，所以统一归一化。
 * 项目外的路径保持绝对形式，避免被误认为项目内文件。
 */
function normalizePath(raw: string, projectRoot: string): string {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
  const rel = relative(projectRoot, abs);

  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel;
}

/**
 * 从 bash 命令里粗略抽取"像路径"的 token。
 * 启发式：按 shell 元字符切分，保留含 / 或以 . 开头、且不像选项的部分。
 * 不做完整 shell 解析，只求覆盖 cat .env / > .env 这类常见写法。
 */
function extractBashPathTokens(command: string): string[] {
  return command
    .split(SHELL_DELIMITERS)
    .filter((token) => token !== "" && !token.startsWith("-"))
    .filter((token) => token.includes("/") || token.startsWith("."));
}

/**
 * 提取一次工具调用可能涉及的路径，并统一规范化。
 * 目前只覆盖 bash 与文件类工具。
 */
export function extractPathCandidates(
  toolName: string,
  params: Record<string, unknown>,
  projectRoot: string,
): string[] {
  const raws: string[] = [];

  if (toolName === "bash" && typeof params.command === "string") {
    raws.push(...extractBashPathTokens(params.command));
  } else {
    if (typeof params.file_path === "string") raws.push(params.file_path);
    if (typeof params.path === "string") raws.push(params.path);
  }

  return [...new Set(raws.map((raw) => normalizePath(raw, projectRoot)))];
}

/** 返回第一个命中的保护模式，未命中返回 null */
export function matchProtectedPath(
  candidates: string[],
  patterns: string[],
): string | null {
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      if (minimatch(candidate, pattern, { dot: true })) return pattern;
    }
  }
  return null;
}
