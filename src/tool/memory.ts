import type { Tool } from "./types.js";
import { memoryStore } from "../session/index.js";

export const memoryTool: Tool = {
  name: "save_memory",
  description:
    "Save a piece of information that should be remembered across sessions. " +
    "Use this for user preferences, project conventions, and feedback corrections.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short title for this memory" },
      description: { type: "string", description: "One-line summary" },
      type: {
        type: "string",
        enum: ["user", "project", "feedback"],
        description: "user=preference, project=convention, feedback=correction",
      },
      content: { type: "string", description: "Full content in Markdown" },
    },
    required: ["name", "description", "type", "content"],
  },
  async execute(params) {
    const fileName = await memoryStore.write({
      name: params.name as string,
      description: params.description as string,
      type: params.type as "user" | "project" | "feedback",
      content: params.content as string ,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return `Memory saved: ${fileName}`;
  },
};
