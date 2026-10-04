// 输出格式化 - text / json / stream

import { WriteContent, OutputFormat, StreamEvent } from "./types.js";

/** text 格式: 直接打印,人类可读 */
function writeText(content: string): void {
  process.stdout.write(content + "\n");
}

/** json 格式,整个结果包成一个 JSON 对象 */
function writeJson(result: WriteContent): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

/** stream 格式, */
export function writeStreamEvent(event: StreamEvent) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

/** 根据 format 选择输出方式 */
export function writeOutput(format: OutputFormat, result: WriteContent): void {
  switch (format) {
    case "text":
      writeText(result.content);
      break;
    case "json":
      writeJson(result);
      break;
    case "stream":
      // stream 模式下,最终结果也以 end 事件输出
      writeStreamEvent({
        type: "end",
        content: result.content,
        model: result.model,
        turns: result.turns,
      });
      break;
  }
}
