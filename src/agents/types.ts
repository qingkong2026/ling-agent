// src/agents/types.ts 子 Agent 的类型定义

import type { ToolDefinition } from "../providers/index.js";

/** 子 Agent 配置 */
export interface SubAgentConfig {
  /** 子 Agent 名称，用于日志和结果追踪 */
  name: string;
  /** System prompt，定义角色和行为边界 */
  role: string;
  /** 允许使用的工具子集（工具名列表） */
  tools: string[];
  /** 可以用不同模型（便宜的任务用便宜的模型） */
  model?: string;
  /** 最大对话轮次，防止子 Agent 跑飞 */
  maxTurns?: number;
}

/** 子 Agent 执行结果 */
export interface SubAgentResult {
  /** 子 Agent 名称 */
  name: string;
  /** 是否成功完成 */
  success: boolean;
  /** 最终输出文本 */
  output: string;
  /** 消耗的对话轮次 */
  turns: number;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 失败时的错误信息 */
  error?: string;
}