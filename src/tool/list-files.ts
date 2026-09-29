import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { Tool } from "./types.js";

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories in a given path. Shows type (file/dir) and size",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default: .)" },
    },
  },
  async execute(params) {
    const dirpath = (params.path as string) ?? ".";
    const entries = await readdir(dirpath, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(dirpath, entry.name);
      if (entry.isDirectory()) {
        lines.push(`[dir] ${entry.name}`);
      } else {
        const s = await stat(fullPath);
        lines.push(`[file] ${entry.name} (${s.size} bytes)`);
      }
    }
    return lines.join("\n") || "(empty directory)";
  },
};
