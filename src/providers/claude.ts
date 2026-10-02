import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMResponse,
  Message,
  StreamChunk,
  ToolDefinition,
  ToolCall,
} from "./types.js";

/** 把统一的工具声明转成 Claude 格式 */
function toClaudeTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

/** 解析工具调用参数; 非法 JSON 时退回空对象, 避免污染历史后每轮都 parse 失败 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function splitSystemAndMessages(messages: Message[]): {
  system: string | undefined;
  claudeMessages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const claudeMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // Claude 只支持一个 system, 多个拼接起来
        system = system ? `${system}\n\n${msg.content}` : msg.content;
        break;

      case "user":
        claudeMessages.push({ role: "user", content: msg.content });
        break;

      case "assistant":
        // Claude 的 assistant 消息, content 是数组
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        // tool_use 直接嵌在 content 数组里
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: parseToolArguments(tc.arguments),
            });
          }
        }
        claudeMessages.push({ role: "assistant", content: content });
        break;

      case "tool":
        // tool_result 也放在 user 消息的 content 数组里
        claudeMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: msg.content,
            },
          ],
        });
        break;
    }
  }

  return { system, claudeMessages };
}

/** 从 Claude 响应提取 ToolCall */
function extractToolCalls(content: Anthropic.ContentBlock[]): ToolCall[] {
    return content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
    }));
}

/** 从 Claude 响应提取文本 */
function extractText(content: Anthropic.ContentBlock[]): string | null {
  const texts = content
    .filter( (block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text);

  return texts.length > 0 ? texts.join("") : null;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string){
    this.model = model;
    this.client = new Anthropic({apiKey});
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse> {
    const { system, claudeMessages} = splitSystemAndMessages(messages);

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: claudeMessages,
      tools: tools?.length ? toClaudeTools(tools) : undefined,
    })

    const usage = res.usage;
    
     return {
      content: extractText(res.content),
      toolCalls: extractToolCalls(res.content),
      finishReason: res.stop_reason === "tool_use" ? "tool_calls"
        : res.stop_reason === "end_turn" ? "stop"
        : res.stop_reason === "max_tokens" ? "length"
        : "unknown",
      usage: usage ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens} : undefined, 
     }
  }

  async *stream(messages: Message[], tools?: ToolDefinition[]): AsyncIterableIterator<StreamChunk> {
    const { system, claudeMessages } = splitSystemAndMessages(messages);

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: claudeMessages,
      tools: tools?.length ? toClaudeTools(tools) : undefined,
    });

    // Claude 的增量片段只带 block index, 不带工具调用 id,
    // 统一层的 index 语义是"第几个工具调用", 所以维护 block index -> 工具调用序号
    const toolCallIndexByBlock = new Map<number, number>();
    let toolCallCount = 0;

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          // tool_use 块: 开始时就带 id 和 name
          if (block.type === "tool_use") {
            const index = toolCallCount++;
            toolCallIndexByBlock.set(event.index, index);
            yield {
              type: "tool_call_start",
              content: "",
              toolCallId: block.id,
              toolName: block.name,
              index,
            };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            yield { type: "text", content: delta.text };
          } else if (delta.type === "input_json_delta") {
            // 工具参数是 JSON 片段, 对应 tool_call_delta
            yield {
              type: "tool_call_delta",
              content: delta.partial_json,
              index: toolCallIndexByBlock.get(event.index) ?? 0,
            };
          }
          break;
        }

        case "content_block_stop": {
          // 工具调用块收尾
          if (toolCallIndexByBlock.has(event.index)) {
            yield {
              type: "tool_call_end",
              content: "",
              index: toolCallIndexByBlock.get(event.index)!,
            };
          }
          break;
        }

        case "message_stop": {
          yield { type: "finish", content: "" };
          break;
        }
      }
    }
  }
}