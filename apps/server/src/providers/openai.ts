/**
 * OpenAI Provider Adapter
 *
 * Implements the LLMProvider interface for OpenAI's GPT-5.4 family via the
 * Responses API (`/v1/responses`). Uses native fetch: POST JSON for
 * non-streaming, parse named SSE events for streaming.
 *
 * The Responses API is used (not Chat Completions) because:
 *   - gpt-5.4-pro exposes full multi-turn / web_search only here.
 *   - Chat Completions web_search requires a separate `*-search-api` model
 *     and is incompatible with function tools.
 *   - Single unified shape for all four GPT-5.4 models.
 *
 * Translation summary (OpenRouter → Responses API):
 *   - system/user/assistant messages → `{type: "message", role, content}`
 *   - user image_url parts           → `{type: "input_image", image_url, detail}`
 *   - assistant.tool_calls           → `{type: "function_call", call_id, name, arguments}`
 *   - tool role messages             → `{type: "function_call_output", call_id, output}`
 *   - Function tool defs             → `{type: "function", name, description, parameters}`
 *   - Web search                     → `{type: "web_search"}`
 *   - thinkingEnabled                → `reasoning: { effort: "medium" }`
 *
 * @module providers/openai
 */

import { logger } from "@router402/utils";
import { getConfig } from "../config/index.js";
import type {
  ContentPart,
  FinishReason,
  Message,
  Tool,
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

const openaiLogger = logger.context("OpenAIProvider");
const PROVIDER_NAME = "openai";

// ============================================================================
// Responses API Shapes (subset we use)
// ============================================================================

interface ResponsesInputTextPart {
  type: "input_text";
  text: string;
}

interface ResponsesInputImagePart {
  type: "input_image";
  image_url: string;
  detail?: "auto" | "low" | "high";
}

interface ResponsesOutputTextPart {
  type: "output_text";
  text: string;
}

type ResponsesContentPart =
  | ResponsesInputTextPart
  | ResponsesInputImagePart
  | ResponsesOutputTextPart;

interface ResponsesMessageItem {
  type: "message";
  role: "system" | "user" | "assistant" | "developer";
  content: string | ResponsesContentPart[];
}

interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

interface ResponsesReasoningSummaryPart {
  type: "summary_text";
  text: string;
}

interface ResponsesReasoningItem {
  type: "reasoning";
  summary?: ResponsesReasoningSummaryPart[];
  content?: ResponsesReasoningSummaryPart[];
}

interface ResponsesWebSearchCallItem {
  type: "web_search_call";
  id?: string;
  status?: string;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

type ResponsesOutputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesReasoningItem
  | ResponsesWebSearchCallItem;

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /**
   * reasoning_tokens is INCLUDED in output_tokens per OpenAI billing.
   * Exposed here only so we can report it separately for transparency.
   */
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface ResponsesBody {
  id?: string;
  object?: string;
  status?: string;
  model?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  error?: { message?: string; code?: string; type?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

// ============================================================================
// Translation: OpenRouter → Responses API input
// ============================================================================

function imageDetail(
  d: "auto" | "low" | "high" | undefined
): "auto" | "low" | "high" | undefined {
  if (d === "auto" || d === "low" || d === "high") return d;
  return undefined;
}

function translateUserContent(
  content: string | ContentPart[] | null
): string | ResponsesContentPart[] {
  if (content === null) return "";
  if (typeof content === "string") return content;
  const parts: ResponsesContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text });
    } else if (part.type === "image_url") {
      const detail = imageDetail(part.image_url.detail);
      const item: ResponsesInputImagePart = {
        type: "input_image",
        image_url: part.image_url.url,
      };
      if (detail) item.detail = detail;
      parts.push(item);
    }
  }
  return parts;
}

function toPlainText(content: string | ContentPart[] | null): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function translateMessages(messages: Message[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      items.push({
        type: "message",
        role: "system",
        content: toPlainText(message.content),
      });
      continue;
    }
    if (message.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: translateUserContent(message.content),
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = toPlainText(message.content);
      if (text.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const call of message.tool_calls) {
          items.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) {
        // Without a call_id the Responses API cannot bind the output.
        continue;
      }
      items.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: toPlainText(message.content),
      });
    }
  }
  return items;
}

function translateTools(tools: Tool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

function translateToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  // Responses API: {type: "function", name: "..."} (no inner function wrapper)
  if (choice.type === "function") {
    return { type: "function", name: choice.function.name };
  }
  return choice;
}

// ============================================================================
// Error translation
// ============================================================================

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
  if (status === 502 || status === 503 || status === 504) {
    return new ProviderUnavailableError(PROVIDER_NAME, cause);
  }
  if (status === 400 || status === 422) {
    return new InvalidRequestError(PROVIDER_NAME, message, undefined, cause);
  }
  return new ProviderError(message, status || 500, "api_error", cause);
}

function translateThrown(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error) {
    return new ProviderError(error.message, 500, "api_error", error);
  }
  return new ProviderError("An unexpected error occurred", 500, "api_error");
}

// ============================================================================
// Non-streaming output parsing
// ============================================================================

function extractAssistantText(output: ResponsesOutputItem[]): string | null {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type === "message" && item.role === "assistant") {
      if (typeof item.content === "string") {
        chunks.push(item.content);
      } else {
        for (const part of item.content) {
          if (part.type === "output_text") chunks.push(part.text);
        }
      }
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join("");
}

function extractReasoning(output: ResponsesOutputItem[]): string | null {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type === "reasoning") {
      const summary = item.summary ?? item.content ?? [];
      for (const part of summary) {
        if (part.type === "summary_text") chunks.push(part.text);
      }
    }
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n");
}

function countWebSearchCalls(output: ResponsesOutputItem[]): number {
  let count = 0;
  for (const item of output) {
    if (item.type === "web_search_call") count += 1;
  }
  return count;
}

function extractToolCalls(output: ResponsesOutputItem[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (item.type === "function_call") {
      calls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    }
  }
  return calls;
}

function mapFinishReason(
  status: string | undefined,
  incomplete: string | undefined,
  hasToolCalls: boolean
): FinishReason {
  if (hasToolCalls) return "tool_calls";
  if (incomplete === "max_output_tokens") return "length";
  if (incomplete === "content_filter") return "content_filter";
  if (status === "incomplete") return "length";
  return "stop";
}

// ============================================================================
// Streaming event parsing
// ============================================================================

interface SseEvent {
  event: string | null;
  data: string;
}

async function* parseNamedSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  function parseBlock(raw: string): SseEvent | null {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.startsWith("event:")) {
        event = trimmed.slice(6).trimStart();
      } else if (trimmed.startsWith("data:")) {
        dataLines.push(trimmed.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join("\n") };
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseBlock(raw);
        if (evt !== null) yield evt;
        sep = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const evt = parseBlock(buffer);
      if (evt !== null) yield evt;
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// Provider implementation
// ============================================================================

export class OpenAIProvider implements LLMProvider {
  readonly name = PROVIDER_NAME;
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    const config = getConfig();
    this.apiKey = apiKey ?? config.OPENAI_API_KEY;
    this.baseUrl = (baseUrl ?? config.OPENAI_BASE_URL).replace(/\/+$/, "");
    if (!this.apiKey) {
      throw new AuthenticationError(PROVIDER_NAME);
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    try {
      const body = this.buildRequestBody(params, false);
      openaiLogger.debug("OpenAI request", {
        model: body.model,
        thinking: params.thinkingEnabled === true,
        webSearch: params.webSearchEnabled === true,
      });

      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        openaiLogger.error("OpenAI returned non-OK", {
          status: response.status,
          body: text.slice(0, 500),
        });
        throw translateHttpError(response.status, text);
      }

      const data = (await response.json()) as ResponsesBody;
      if (data.error) {
        throw new ProviderError(
          data.error.message ?? "OpenAI response error",
          500,
          data.error.type ?? "api_error"
        );
      }

      const output = data.output ?? [];
      const toolCalls = extractToolCalls(output);
      const content = extractAssistantText(output);
      const reasoning = extractReasoning(output);
      const webSearchCount = countWebSearchCalls(output);
      const reasoningTokens =
        data.usage?.output_tokens_details?.reasoning_tokens ?? 0;

      return {
        content,
        reasoning: reasoning ?? undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: mapFinishReason(
          data.status,
          data.incomplete_details?.reason ?? undefined,
          toolCalls.length > 0
        ),
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
          webSearchCount: webSearchCount > 0 ? webSearchCount : undefined,
        },
      };
    } catch (error) {
      throw translateThrown(error);
    }
  }

  async *chatStream(params: ChatParams): AsyncGenerator<ChatChunk> {
    try {
      const body = this.buildRequestBody(params, true);
      openaiLogger.debug("OpenAI stream request", {
        model: body.model,
        thinking: params.thinkingEnabled === true,
        webSearch: params.webSearchEnabled === true,
      });

      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        openaiLogger.error("OpenAI returned non-OK", {
          status: response.status,
          body: text.slice(0, 500),
        });
        throw translateHttpError(response.status, text);
      }

      if (!response.body) {
        throw new ProviderError(
          "OpenAI streaming response had no body",
          500,
          "api_error"
        );
      }

      // Track in-progress function_call items by their output item id so
      // argument deltas can be accumulated and flushed on completion.
      const pendingCalls = new Map<
        string,
        { callId: string; name: string; arguments: string }
      >();
      let promptTokens = 0;
      let completionTokens = 0;
      let reasoningTokens = 0;
      let webSearchCount = 0;
      let finishReason: FinishReason | undefined;
      let sawToolCalls = false;
      let eventCount = 0;

      for await (const evt of parseNamedSse(response.body)) {
        eventCount += 1;
        const name = evt.event ?? "";
        if (evt.data === "[DONE]") break;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(evt.data) as Record<string, unknown>;
        } catch (err) {
          openaiLogger.warn("OpenAI SSE JSON parse failed", {
            event: name,
            data: evt.data.slice(0, 200),
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        if (name === "response.output_text.delta") {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          if (delta) yield { content: delta };
          continue;
        }

        if (
          name === "response.reasoning_summary_text.delta" ||
          name === "response.reasoning.delta"
        ) {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          if (delta) yield { reasoning: delta };
          continue;
        }

        if (name === "response.output_item.added") {
          const item = payload.item as
            | { id?: string; type?: string; call_id?: string; name?: string }
            | undefined;
          if (item?.type === "function_call") {
            sawToolCalls = true;
            const itemId = item.id ?? item.call_id ?? "";
            pendingCalls.set(itemId, {
              callId: item.call_id ?? itemId,
              name: item.name ?? "",
              arguments: "",
            });
          } else if (item?.type === "web_search_call") {
            webSearchCount += 1;
          }
          continue;
        }

        if (name === "response.function_call_arguments.delta") {
          const itemId =
            typeof payload.item_id === "string" ? payload.item_id : "";
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          const existing = pendingCalls.get(itemId);
          if (existing && delta) {
            existing.arguments += delta;
          }
          continue;
        }

        if (
          name === "response.function_call_arguments.done" ||
          name === "response.output_item.done"
        ) {
          // When item.done fires for a function_call, emit the accumulated call.
          const item = payload.item as
            | {
                id?: string;
                type?: string;
                call_id?: string;
                name?: string;
                arguments?: string;
              }
            | undefined;
          const itemId =
            (typeof payload.item_id === "string" ? payload.item_id : null) ??
            item?.id ??
            "";

          const pending = pendingCalls.get(itemId);
          if (pending) {
            const args =
              (item?.arguments && item.arguments.length > 0
                ? item.arguments
                : pending.arguments) || "{}";
            pendingCalls.delete(itemId);
            yield {
              toolCalls: [
                {
                  id: pending.callId,
                  type: "function",
                  function: { name: pending.name, arguments: args },
                },
              ],
            };
          }
          continue;
        }

        if (name === "response.completed") {
          const resp = payload.response as
            | {
                status?: string;
                usage?: ResponsesUsage;
                incomplete_details?: { reason?: string };
              }
            | undefined;
          promptTokens += resp?.usage?.input_tokens ?? 0;
          completionTokens += resp?.usage?.output_tokens ?? 0;
          reasoningTokens +=
            resp?.usage?.output_tokens_details?.reasoning_tokens ?? 0;
          finishReason = mapFinishReason(
            resp?.status,
            resp?.incomplete_details?.reason ?? undefined,
            sawToolCalls
          );
          continue;
        }

        if (name === "response.error" || name === "error") {
          const err = (payload.error ?? payload) as {
            message?: string;
            code?: string;
            type?: string;
          };
          throw new ProviderError(
            err.message ?? "OpenAI stream error",
            500,
            err.type ?? "api_error"
          );
        }
      }

      openaiLogger.debug("OpenAI stream complete", {
        eventCount,
        finishReason,
        promptTokens,
        completionTokens,
        reasoningTokens,
        webSearchCount,
      });

      yield {
        finishReason: finishReason ?? "stop",
        usage: {
          promptTokens,
          completionTokens,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
          webSearchCount: webSearchCount > 0 ? webSearchCount : undefined,
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
    return `${this.baseUrl}/responses`;
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
    const input = translateMessages(params.messages);
    const body: Record<string, unknown> = {
      model: params.model,
      input,
    };

    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.maxTokens !== undefined) {
      body.max_output_tokens = params.maxTokens;
    }

    const tools: unknown[] = [];
    const fnTools = translateTools(params.tools);
    if (fnTools) tools.push(...fnTools);
    if (params.webSearchEnabled) {
      tools.push({ type: "web_search" });
    }
    if (tools.length > 0) {
      body.tools = tools;
      const toolChoice = translateToolChoice(params.toolChoice);
      if (toolChoice !== undefined) body.tool_choice = toolChoice;
    }

    if (params.thinkingEnabled) {
      body.reasoning = { effort: "medium", summary: "auto" };
    }

    if (params.responseFormat?.type === "json_object") {
      // Responses API nests format under `text.format`.
      body.text = { format: { type: "json_object" } };
    }

    if (stream) body.stream = true;

    return body;
  }
}
