import * as readline from "readline/promises";
import type { Tool } from "./types.js";

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
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    try {
      return await rl.question(`\n🤖 Agent asks: ${question}\n>`);
    } finally {
      rl.close();
    }
  }
}