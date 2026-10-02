import { detectProject, type ProjectInfo } from "./project-detectors.js";
import { loadLingMdFile, type LingMdResult } from "./ling-md.js";
import { memoryStore } from "../session/index.js";

export interface SystemPromptOption {
  cwd: string;
  customRules?: string; // 用户额外追加的规则
}

// 第一层,角色定义
const LAYER_ROLE = `You are ling, a coding assistant built for real projects.
You can read files, run command, seach code, and edit files.
You think step by step, use tools to gather information before answering, and verify your work.`;

// 第二层: 通用规则
const LAYER_RULES = `## Rules
- Always read the relevant file before editing it.
- Never run destructive commands (rm -rf /, git push --force) without explicit use confirmation.
- When you make an error, acknowledge it and try a different approach.
- Keep responses concise - code speaks louder than paragraphs.
- If a task is ambiguous, ask the use to clarify instead of guessing.`;

// 第三层: 从项目实际状态动态生成
function buildProjectLayer(project: ProjectInfo): string {
  const parts: string[] = ["## Project Context"];

  parts.push(`Working directory: ${project.name}`);
  parts.push(`Type: ${project.type} (${project.techStack.join(", ")})`);

  if (project.description) {
    parts.push(`Description: ${project.description}`);
  }

  parts.push("");
  parts.push("### Git Status");
  parts.push("```");
  parts.push(project.gitStatus);
  parts.push("```");

  if (project.recentCommits) {
    parts.push("");
    parts.push("### Recent Commits");
    parts.push("```");
    parts.push(project.recentCommits);
    parts.push("```");
  }

  parts.push("");
  parts.push("### Directory Structure");
  parts.push("```");
  parts.push(project.directoryTree);
  parts.push("```");

  return parts.join("\n");
}

// 第四层: .ling.md 用户指令
function buildLingMdLayer(lingMds: LingMdResult[]): string {
  if (lingMds.length === 0) return "";

  const parts: string[] = ["## Project Instructions (from .ling.md)"];
  for (const md of lingMds) {
    parts.push(`<!-- source: ${md.path} -->`);
    parts.push(md.content);
    parts.push("");
  }
  return parts.join("\n");
}

// 第五层: Memory
async function buildMemoryLayer(): Promise<string> {
  const memoryContext = await memoryStore.loadForContext();
  const parts: string[] = [];
  if (memoryContext) {
    console.log(
      `Loaded ${memoryContext.split("\n").length} lines of memory context.`,
    );
    parts.push("## Memory");
    parts.push(memoryContext);
  }
  return parts.join("\n");
}

// 组装完整 System Prompt
export async function buildSystemPrompt(
  options: SystemPromptOption,
): Promise<string> {
  const project = detectProject(options.cwd);
  const lingMds = loadLingMdFile(options.cwd);

  const memoryLayer = await buildMemoryLayer();

  const sections = [
    LAYER_ROLE,
    LAYER_RULES,
    buildProjectLayer(project),
    buildLingMdLayer(lingMds),
    memoryLayer,
  ];

  if (options.customRules) {
    sections.push(`## Addtional Rules\n${options.customRules}`);
  }

  return sections.filter(Boolean).join("\n\n");
}
