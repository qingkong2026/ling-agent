import { ToolRegistry } from "./types.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { grepTool } from "./grep.js";
import { globTool } from "./glob.js";
import { bashTool } from "./bash.js";
import { listFilesTool } from "./list-files.js";
import { createAskUserTool, AskChannel } from "./ask-user.js";
import { memoryTool } from "./memory.js"

export function createToolRegistry(opts: { host?: AskChannel } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(grepTool);
  registry.register(globTool);
  registry.register(bashTool);
  registry.register(listFilesTool);
  registry.register(createAskUserTool(opts.host ?? {}));
  registry.register(memoryTool);
  return registry;
}

export { ToolRegistry } from "./types.js";
export type { AskFn, AskChannel } from "./ask-user.js";
export  type { Tool, ToolExecContext } from "./types.js";
