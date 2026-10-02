import type { Tool } from "./types.js";

/** 宿主注入的交互通道：把问题交给用户, 拿回回答 */
export type AskFn = (question: string) => Promise<string>;

let askFn: AskFn | undefined;

/**
 * 由宿主注入交互通道。
 * 工具自己不碰 stdin —— REPL 复用自己那一个 readline, SDK 走自己的通道。
 * 另起一个 readline 会和外层抢同一个 process.stdin:
 * 输入被回显两遍, 而且 close 之后外层再也读不到输入。
 */
export function setAskUserFn(fn: AskFn): void {
  askFn = fn;
}

export const askUserTool: Tool = {
  name: "ask_user",
  description: "Ask the user a question and wait for their response. Use when you need clarification or confirmation.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask"},
    },
    required: ["question"],
  },
  async execute(params) {
    const question = params.question as string;

    // 没有交互通道(比如 SDK 入口)时不要把调用卡死, 让模型知道这条路走不通
    if (!askFn) {
      return "Error: ask_user is unavailable - the host did not provide an interactive channel.";
    }

    return askFn(question);
  }
};
