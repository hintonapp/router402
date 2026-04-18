/**
 * Kimi Provider Adapter
 *
 * Implements the LLMProvider interface for Moonshot AI Kimi models via the
 * OpenAI-compatible Chat Completions endpoint at api.moonshot.ai. Uses native
 * fetch (no extra SDK): POST JSON for non-streaming, parse SSE for streaming.
 *
 * Thinking: toggled via `thinking: { type: "enabled" | "disabled" }` on the
 * request body. `kimi-k2.5` respects the toggle; `kimi-k2-thinking` forces
 * thinking on regardless, so we omit the field for that model.
 *
 * Web search: exposed via a builtin tool `$web_search`. The model emits a
 * tool_calls response; the client must echo the arguments back as a tool
 * message, after which the model performs the search server-side and returns
 * the final answer. We run this echo loop internally so callers see a single
 * response / stream.
 *
 * @module providers/kimi
 */

import { logger } from "@router402/utils";
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

const kimiLogger = logger.context("KimiProvider");
const PROVIDER_NAME = "kimi";

const WEB_SEARCH_TOOL_NAME = "$web_search";
const MAX_WEB_SEARCH_ROUNDS = 5;
const THINKING_MODEL_ID = "kimi-k2-thinking";

// ============================================================================
// Moonshot Request / Response Shapes (OpenAI-compatible)
// ============================================================================

interface KimiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: KimiToolCall[];
}

interface KimiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  index?: number;
}

interface KimiStreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface KimiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

interface KimiChoiceMessage {
  role: string;
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: KimiToolCall[];
}

interface KimiChatResponse {
  id?: string;
  choices: Array<{
    index: number;
    message: KimiChoiceMessage;
    finish_reason: string | null;
  }>;
  usage?: KimiUsage;
}

interface KimiStreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: KimiStreamToolCallDelta[];
}

interface KimiStreamChunk {
  id?: string;
  choices?: Array<{
    index: number;
    delta: KimiStreamDelta;
    finish_reason: string | null;
  }>;
  usage?: KimiUsage;
}

// ============================================================================
// Translation Helpers
// ============================================================================

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

function translateMessages(messages: Message[]): KimiMessage[] {
  return messages.map((message): KimiMessage => {
    const base: KimiMessage = {
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

function allWebSearchCalls(calls: KimiToolCall[]): boolean {
  if (calls.length === 0) return false;
  return calls.every((tc) => tc.function.name === WEB_SEARCH_TOOL_NAME);
}

/**
 * Build the `content` for a tool response message echoing a $web_search call.
 * Per Moonshot docs, we must JSON.parse the model's arguments, then JSON.stringify
 * the result back — this is the pattern the official SDK examples use. Returning
 * the raw argument string usually works, but round-tripping through parse+stringify
 * matches the documented contract exactly and tolerates any whitespace/ordering
 * differences Moonshot's validator might enforce.
 */
function toolResultContent(rawArguments: string): string {
  try {
    const parsed: unknown = JSON.parse(rawArguments || "{}");
    return JSON.stringify(parsed);
  } catch {
    return rawArguments || "{}";
  }
}

// ============================================================================
// Kimi Provider Implementation
// ============================================================================

export class KimiProvider implements LLMProvider {
  readonly name = PROVIDER_NAME;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    const config = getConfig();
    this.apiKey = apiKey ?? config.MOONSHOT_API_KEY;
    this.baseUrl = (baseUrl ?? config.MOONSHOT_BASE_URL).replace(/\/+$/, "");
    if (!this.apiKey) {
      throw new AuthenticationError(PROVIDER_NAME);
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    try {
      const messages = translateMessages(params.messages);
      let promptTokens = 0;
      let completionTokens = 0;

      for (let round = 0; round < MAX_WEB_SEARCH_ROUNDS; round++) {
        const body = this.buildRequestBody(params, messages, false);
        kimiLogger.debug("Moonshot request", {
          model: body.model,
          thinking: body.thinking,
          round,
          hasWebSearch: params.webSearchEnabled === true,
        });

        const response = await fetch(this.endpoint(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          kimiLogger.error("Moonshot returned non-OK", {
            status: response.status,
            body: text.slice(0, 500),
          });
          throw translateHttpError(response.status, text);
        }

        const data = (await response.json()) as KimiChatResponse;
        const choice = data.choices?.[0];
        if (!choice) {
          throw new ProviderError(
            "Kimi response contained no choices",
            500,
            "api_error"
          );
        }

        promptTokens += data.usage?.prompt_tokens ?? 0;
        completionTokens += data.usage?.completion_tokens ?? 0;

        const message = choice.message;
        const toolCalls = message.tool_calls ?? [];

        if (
          choice.finish_reason === "tool_calls" &&
          allWebSearchCalls(toolCalls) &&
          params.webSearchEnabled
        ) {
          kimiLogger.debug("Moonshot $web_search echo", {
            round,
            toolCallCount: toolCalls.length,
            toolCallNames: toolCalls.map((c) => c.function.name),
          });
          messages.push({
            role: "assistant",
            content: message.content ?? null,
            tool_calls: toolCalls,
          });
          for (const call of toolCalls) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: toolResultContent(call.function.arguments),
            });
          }
          continue;
        }

        const mappedToolCalls =
          toolCalls.length > 0
            ? toolCalls.map(
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
          toolCalls: mappedToolCalls,
          finishReason: mapFinishReason(choice.finish_reason),
          usage: {
            promptTokens,
            completionTokens,
          },
        };
      }

      throw new ProviderError(
        `Kimi web search exceeded ${MAX_WEB_SEARCH_ROUNDS} rounds without resolution`,
        500,
        "api_error"
      );
    } catch (error) {
      throw translateThrown(error);
    }
  }

  async *chatStream(params: ChatParams): AsyncGenerator<ChatChunk> {
    try {
      const messages = translateMessages(params.messages);
      let promptTokensTotal = 0;
      let completionTokensTotal = 0;
      let finalFinishReason: FinishReason = "stop";

      for (let round = 0; round < MAX_WEB_SEARCH_ROUNDS; round++) {
        const body = this.buildRequestBody(params, messages, true);
        kimiLogger.debug("Moonshot stream request", {
          model: body.model,
          thinking: body.thinking,
          round,
          hasWebSearch: params.webSearchEnabled === true,
        });

        const response = await fetch(this.endpoint(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          kimiLogger.error("Moonshot returned non-OK", {
            status: response.status,
            body: text.slice(0, 500),
          });
          throw translateHttpError(response.status, text);
        }

        if (!response.body) {
          throw new ProviderError(
            "Kimi streaming response had no body",
            500,
            "api_error"
          );
        }

        const toolCallsInProgress = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        let roundFinishReason: FinishReason | undefined;
        let roundUsage: KimiUsage | undefined;
        const bufferedToolCallChunks: ToolCall[] = [];

        let eventCount = 0;
        for await (const event of parseSse(response.body)) {
          eventCount += 1;
          if (event === "[DONE]") break;
          let chunk: KimiStreamChunk & {
            error?: { code?: string; message?: string; type?: string };
          };
          try {
            chunk = JSON.parse(event) as typeof chunk;
          } catch (parseErr) {
            kimiLogger.warn("Moonshot SSE JSON parse failed", {
              event: event.slice(0, 200),
              error:
                parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            continue;
          }

          if (chunk.error) {
            const errMsg =
              chunk.error.message ?? chunk.error.code ?? "Kimi stream error";
            throw new ProviderError(
              errMsg,
              500,
              chunk.error.type ?? "api_error"
            );
          }

          if (chunk.usage) {
            roundUsage = chunk.usage;
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
            roundFinishReason = mapFinishReason(choice.finish_reason);
          }
        }

        promptTokensTotal += roundUsage?.prompt_tokens ?? 0;
        completionTokensTotal += roundUsage?.completion_tokens ?? 0;

        const collectedToolCalls: KimiToolCall[] = Array.from(
          toolCallsInProgress.entries()
        )
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: tc.arguments || "{}",
            },
          }));

        kimiLogger.debug("Moonshot stream round complete", {
          model: body.model,
          round,
          eventCount,
          finishReason: roundFinishReason,
          promptTokens: roundUsage?.prompt_tokens,
          completionTokens: roundUsage?.completion_tokens,
          toolCallCount: collectedToolCalls.length,
        });

        const isSearchRound =
          roundFinishReason === "tool_calls" &&
          params.webSearchEnabled === true &&
          allWebSearchCalls(collectedToolCalls);

        if (isSearchRound) {
          kimiLogger.debug("Moonshot $web_search echo (stream)", {
            round,
            toolCallCount: collectedToolCalls.length,
            toolCallNames: collectedToolCalls.map((c) => c.function.name),
          });
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: collectedToolCalls,
          });
          for (const call of collectedToolCalls) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: toolResultContent(call.function.arguments),
            });
          }
          // bufferedToolCallChunks stays empty; we swallow the $web_search calls
          void bufferedToolCallChunks;
          continue;
        }

        if (collectedToolCalls.length > 0) {
          const passthrough: ToolCall[] = collectedToolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
          yield { toolCalls: passthrough };
        }

        finalFinishReason = roundFinishReason ?? "stop";
        break;
      }

      yield {
        finishReason: finalFinishReason,
        usage: {
          promptTokens: promptTokensTotal,
          completionTokens: completionTokensTotal,
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
    messages: KimiMessage[],
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages,
    };

    if (params.temperature !== undefined) body.temperature = params.temperature;
    // Web search pulls long pages into prompt_tokens and needs headroom for a
    // grounded answer. Moonshot's own examples set max_tokens=32768 — match
    // that when the caller didn't specify a ceiling.
    if (params.maxTokens !== undefined) {
      body.max_tokens = params.maxTokens;
    } else if (params.webSearchEnabled) {
      body.max_tokens = 32768;
    }
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.stop && params.stop.length > 0) body.stop = params.stop;

    // Build tools array: user tools + optional $web_search builtin.
    const tools: unknown[] = [];
    if (params.tools && params.tools.length > 0) {
      tools.push(...params.tools);
    }
    if (params.webSearchEnabled) {
      tools.push({
        type: "builtin_function",
        function: { name: WEB_SEARCH_TOOL_NAME },
      });
    }
    if (tools.length > 0) {
      body.tools = tools;
      const toolChoice = translateToolChoice(params.toolChoice);
      if (toolChoice !== undefined) body.tool_choice = toolChoice;
    }

    if (params.responseFormat) {
      body.response_format = params.responseFormat;
    }

    // Thinking is model-specific:
    //   kimi-k2.5            → supports both enabled/disabled (default: enabled)
    //   kimi-k2-thinking     → always on; omit to avoid rejection
    // Web search requires thinking disabled per Moonshot docs, so when web
    // search is enabled we force-disable thinking on models that accept it.
    if (params.model !== THINKING_MODEL_ID) {
      if (params.webSearchEnabled) {
        body.thinking = { type: "disabled" };
      } else if (params.thinkingEnabled !== undefined) {
        body.thinking = {
          type: params.thinkingEnabled ? "enabled" : "disabled",
        };
      }
    }

    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    return body;
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
