// 加载 .env 环境
import "dotenv/config";

import OpenAI from "openai";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const client = new OpenAI({
  apiKey: process.env.LING_API_KEY,
  baseURL: process.env.LING_BASE_URL,
});
const MODEL = process.env.LING_MODEL || "deepseek-flash";

type Tool = OpenAI.Chat.ChatCompletionTool;
type Message = OpenAI.Chat.ChatCompletionMessageParam;

const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absoulute or relative file path",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command and return its output",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
        },
        required: ["command"],
      },
    },
  },
];

function executeTool(name: string, args: Record<string, string>): string {
  try {
    if (name === "read_file") {
      return readFileSync(args.file_path, "utf-8");
    }
    if (name === "run_command")
      return execSync(args.command, { encoding: "utf-8", timeout: 30000 });
    return `Unkonw tool: ${name}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function agent(userMessage: string) {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You are Ling, a helpfule coding assistant. Use tools to answer question.",
    },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
    });
    const choice = res.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason != "tool_calls" || !choice.message.tool_calls) {
      console.log(choice.message.content);
      return;
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const result = executeTool(tc.function.name, args);
      console.log(
        `[tool] ${tc.function.name}(${JSON.stringify(args)}) -> ${result}`,
      );
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
}

agent(process.argv[2] || "Read package.json and summarize this project.");
