import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";

const LING_MD = ".ling.md";
const MAX_BYTE_SIZE = 25 * 1024; // 25kb 上限
const MAX_LINES = 200;

export interface LingMdResult {
  path: string;
  content: string;
}

// 从 cwd 往上找,直到根目录,收集所有 .ling.md
export function loadLingMdFile(cwd: string): LingMdResult[] {

  const results: LingMdResult[] = [];
  const seen = new Set<string>();
  let dir = resolve(cwd);

  while(true){
    const filePath = join(dir, LING_MD);

    if(!seen.has(filePath) && existsSync(filePath)){
      seen.add(filePath);
      const raw = readFileSync(filePath, "utf-8");
      const content = truncate(raw);
      results.push({path: filePath, content});
    }

    const parent = dirname(dir);
    if(parent === dir) break;
    dir = parent;
  }
  // 根目录的在前,项目目录的在后
  return results.reverse();
}


function truncate(content: string): string {
  // 先按行数截断
  const lines = content.split("\n");
  let text = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") + "\n...(truncated)" : content;

  // 再按字节截断
  if(Buffer.byteLength(text, "utf-8") >  MAX_BYTE_SIZE){
    const buf = Buffer.from(text, "utf-8");
    text = buf.subarray(0, MAX_BYTE_SIZE).toString("utf-8") + "\n...(truncated)"; ;
  }

  return text;
}