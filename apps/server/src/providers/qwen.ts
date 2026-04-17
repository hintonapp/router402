/**
 * Qwen Provider Adapter
 *
 * Implements the LLMProvider interface for Alibaba Cloud Qwen models via the
 * OpenAI-compatible Chat Completions endpoint on DashScope. Uses native fetch
 * (no extra SDK): POST JSON for non-streaming, parse SSE for streaming.
 *
 * @module providers/qwen
 */

import { getConfig } from "../config/index.js";
import type {
  ContentPart,
  FinishReason,
  Message,
  ToolCall,
  ToolChoice,
} from "../types/chat.js";
import type {
  ChatChunk,
  ChatParams,
  ChatResponse,
  LLMProvider,
} from "./base.js";
import {
  AuthenticationError,
  InvalidRequestError,
  ProviderError,
  ProviderUnavailableError,
  RateLimitError,
} from "./base.js";

const PROVIDER_NAME = "qwen";

// ============================================================================
// DashScope Request / Response Shapes (OpenAI-compatible)
// ============================================================================

interface QwenMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: QwenToolCall[];
}

interface QwenToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  index?: number;
}

interface QwenStreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface QwenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

interface QwenChoiceMessage {
  role: string;
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: QwenToolCall[];
}

interface QwenChatResponse {
  id?: string;
  choices: Array<{
    index: number;
    message: QwenChoiceMessage;
    finish_reason: string | null;
  }>;
  usage?: QwenUsage;
}

interface QwenStreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: QwenStreamToolCallDelta[];
}

interface QwenStreamChunk {
  id?: string;
  choices?: Array<{
    index: number;
    delta: QwenStreamDelta;
    finish_reason: string | null;
  }>;
  usage?: QwenUsage;
}

// ============================================================================
// Translation Helpers
// ============================================================================

/**
 * Flatten OpenRouter content (string or content parts) into plain text.
 * Non-text parts are dropped (the registered Qwen models here are text-only).
 */
function flattenContent(content: string | ContentPart[] | null): string | null {
  if (content === null) return null;
  if (typeof content === "string") return content;
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
  return text.length > 0 ? text : null;
}

function translateMessages(messages: Message[]): QwenMessage[] {
  return messages.map((message): QwenMessage => {
    const base: QwenMessage = {
      role: message.role,
      content: flattenContent(message.content),
    };
    if (message.name) base.name = message.name;
    if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
    if (message.tool_calls && message.tool_calls.length > 0) {
      base.tool_calls = message.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }
    // Tool role messages must have string content (not null) per OpenAI spec.
    if (message.role === "tool" && base.content === null) {
      base.content = "";
    }
    return base;
  });
}

function translateToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  return choice;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

// ============================================================================
// Error Translation
// ============================================================================

function translateHttpError(
  status: number,
  bodyText: string,
  cause?: Error
): ProviderError {
  const message = extractErrorMessage(bodyText) ?? bodyText;

  if (status === 401 || status === 403) {
    return new AuthenticationError(PROVIDER_NAME, cause);
  }
  if (status === 429) {
    return new RateLimitError(PROVIDER_NAME, undefined, cause);
  }
  if (status === 503 || status === 502 || status === 504) {
    return new ProviderUnavailableError(PROVIDER_NAME, cause);
  }
  if (status === 400 || status === 422) {
    return new InvalidRequestError(PROVIDER_NAME, message, undefined, cause);
  }
  return new ProviderError(message, status || 500, "api_error", cause);
}

function extractErrorMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.message) {
      return parsed.error.message;
    }
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.message) return parsed.message;
  } catch {
    // fall through
  }
  return null;
}

function translateThrown(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error) {
    return new ProviderError(error.message, 500, "api_error", error);
  }
  return new ProviderError("An unexpected error occurred", 500, "api_error");
}

// ============================================================================
// Qwen Provider Implementation
// ============================================================================

export class QwenProvider implements LLMProvider {
  readonly name = PROVIDER_NAME;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    const config = getConfig();
    this.apiKey = apiKey ?? config.DASHSCOPE_API_KEY;
    this.baseUrl = (baseUrl ?? config.DASHSCOPE_BASE_URL).replace(/\/+$/, "");
    if (!this.apiKey) {
      throw new AuthenticationError(PROVIDER_NAME);
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    try {
      const body = this.buildRequestBody(params, false);
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw translateHttpError(response.status, text);
      }

      const data = (await response.json()) as QwenChatResponse;
      return this.formatResponse(data);
    } catch (error) {
      throw translateThrown(error);
    }
  }

  async *chatStream(params: ChatParams): AsyncGenerator<ChatChunk> {
    let response: Response;
    try {
      const body = this.buildRequestBody(params, true);
      response = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw translateThrown(error);
    }

    if (!response.ok) {
      const text = await response.text();
      throw translateHttpError(response.status, text);
    }

    if (!response.body) {
      throw new ProviderError(
        "Qwen streaming response had no body",
        500,
        "api_error"
      );
    }

    const toolCallsInProgress = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let lastFinishReason: FinishReason | undefined;
    let finalUsage: QwenUsage | undefined;

    try {
      for await (const event of parseSse(response.body)) {
        if (event === "[DONE]") break;
        let chunk: QwenStreamChunk;
        try {
          chunk = JSON.parse(event) as QwenStreamChunk;
        } catch {
          continue;
        }

        if (chunk.usage) {
          finalUsage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};

        if (delta.reasoning_content) {
          yield { reasoning: delta.reasoning_content };
        }

        if (delta.content) {
          yield { content: delta.content };
        }

        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsInProgress.get(tc.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            toolCallsInProgress.set(tc.index, existing);
          }
        }

        if (choice.finish_reason) {
          lastFinishReason = mapFinishReason(choice.finish_reason);
        }
      }

      if (toolCallsInProgress.size > 0) {
        const toolCalls: ToolCall[] = Array.from(toolCallsInProgress.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: tc.arguments || "{}",
            },
          }));
        yield { toolCalls };
      }

      yield {
        finishReason: lastFinishReason ?? "stop",
        usage: {
          promptTokens: finalUsage?.prompt_tokens ?? 0,
          completionTokens: finalUsage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      throw translateThrown(error);
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildRequestBody(
    params: ChatParams,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: translateMessages(params.messages),
    };

    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.topK !== undefined) body.top_k = params.topK;
    if (params.stop && params.stop.length > 0) body.stop = params.stop;

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools;
      const toolChoice = translateToolChoice(params.toolChoice);
      if (toolChoice !== undefined) body.tool_choice = toolChoice;
    }

    if (params.responseFormat) {
      body.response_format = params.responseFormat;
    }

    // DashScope accepts `enable_thinking` directly on the JSON body.
    if (params.thinkingEnabled !== undefined) {
      body.enable_thinking = params.thinkingEnabled;
    }

    // Web search: qwen3-max, qwen3.5-plus, qwen3.5-flash only accept the
    // "agent" strategy (non-thinking mode for qwen3-max) — the default "turbo"
    // is not supported on these models, so enable_search alone is a no-op.
    // search_strategy must live inside the search_options object.
    if (params.webSearchEnabled) {
      body.enable_search = true;
      body.search_options = { search_strategy: "agent" };
    }

    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    return body;
  }

  private formatResponse(data: QwenChatResponse): ChatResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new ProviderError(
        "Qwen response contained no choices",
        500,
        "api_error"
      );
    }

    const message = choice.message;
    const toolCalls =
      message.tool_calls && message.tool_calls.length > 0
        ? message.tool_calls.map(
            (tc): ToolCall => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })
          )
        : undefined;

    return {
      content: message.content ?? null,
      reasoning: message.reasoning_content ?? undefined,
      toolCalls,
      finishReason: mapFinishReason(choice.finish_reason),
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}

// ============================================================================
// SSE Parser
// ============================================================================

/**
 * Parse a Server-Sent Events stream and yield raw `data:` payloads as strings.
 * Handles multi-line buffers and CRLF line endings.
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const payload = extractSseData(rawEvent);
        if (payload !== null) yield payload;
        sep = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const payload = extractSseData(buffer);
      if (payload !== null) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractSseData(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
