import OpenAI from "openai";
import type {
  LLMProvider,
  LLMResponse,
  Message,
  StreamChunk,
  ToolDefinition,
  ToolCall,
} from "./types.js";

/** 把统一的工具声明转换成 OpenAI 格式 */
function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system" as const, content: msg.content };
      case "user":
        return { role: "user" as const, content: msg.content };
      case "assistant":
        return {
          role: "assistant" as const,
          content: msg.content,
          tool_calls: msg.toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      case "tool":
        return {
          role: "tool" as const,
          tool_call_id: msg.toolCallId,
          content: msg.content,
        };
    }
  });
}

function fromOpenAIToolCalls(
  toolCalls?: OpenAI.Chat.ChatCompletionMessageToolCall[],
): ToolCall[] {
  if (!toolCalls) return [];
  return toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl || "https://api.openai.com/v1",
    });
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      tools: tools?.length ? toOpenAITools(tools) : undefined,
    });

    const choice = res.choices[0];
    const usage = res.usage;
    return {
      content: choice.message.content,
      toolCalls: fromOpenAIToolCalls(choice.message.tool_calls),
      finishReason:
        choice.finish_reason === "tool_calls"
          ? "tool_calls"
          : choice.finish_reason === "stop"
            ? "stop"
            : choice.finish_reason === "length"
              ? "length"
              : "unknown",
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
          }
        : undefined,
    };
  }

  async *stream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncIterableIterator<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      tools: tools?.length ? toOpenAITools(tools) : undefined,
      stream: true,
    });

    // 记录本轮已开始的工具调用 index, 流结束时补发 tool_call_end
    const startedToolIndices = new Set<number>();

    for await (const event of stream) {
      const delta = event.choices[0]?.delta;
      if (!delta) continue;

      // 文本内容
      if (delta.content) {
        yield { type: "text", content: delta.content };
      }

      // 工具调用
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            // 新的工具调用开始
            startedToolIndices.add(tc.index);
            yield {
              type: "tool_call_start",
              content: "",
              toolCallId: tc.id,
              toolName: tc.function?.name,
              index: tc.index,
            };
          }
          if (tc.function?.arguments) {
            yield {
              type: "tool_call_delta",
              content: tc.function.arguments,
              index: tc.index,
            };
          }
        }
      }

      // 结束信号: 最后一个 chunk 的 delta 是空的, 不会重复 tool_calls,
      // 所以按本轮已开始的 index 补发 tool_call_end
      if (event.choices[0]?.finish_reason) {
        for (const index of startedToolIndices) {
          yield { type: "tool_call_end", content: "", index };
        }
        yield { type: "finish", content: "" };
      }
    }
  }
}
