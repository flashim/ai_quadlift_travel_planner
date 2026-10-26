import type { ModelAdapter, ModelMessage, ToolCall, TokenUsage } from "../types";
import { postJson, requireApiKey } from "./http";

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function usageOf(body: OpenAIChatResponse): TokenUsage | undefined {
  const u = body.usage;
  if (typeof u?.prompt_tokens !== "number" || typeof u?.completion_tokens !== "number") {
    return undefined;
  }
  return {
    prompt: u.prompt_tokens,
    completion: u.completion_tokens,
    total: u.total_tokens ?? u.prompt_tokens + u.completion_tokens,
  };
}

/** Wire-format messages: our neutral shape → OpenAI chat (tool loop, §6.1). */
function toOpenAIMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id ?? `call_${c.name}`,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** OpenAI chat tool_calls → neutral ToolCall (arguments arrive as a JSON string). */
function parseToolCalls(calls: OpenAIToolCall[] | undefined): ToolCall[] | undefined {
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  const parsed: ToolCall[] = [];
  for (const c of calls) {
    const name = c.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const raw = c.function?.arguments;
    if (typeof raw === "string" && raw.trim()) {
      try {
        const obj: unknown = JSON.parse(raw);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          args = obj as Record<string, unknown>;
        }
      } catch {
        // malformed arguments — the tool executor validates and reports back
      }
    } else if (raw && typeof raw === "object") {
      args = raw as Record<string, unknown>;
    }
    parsed.push({ ...(c.id !== undefined ? { id: c.id } : {}), name, arguments: args });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * OpenAI and any OpenAI-compatible endpoint (Azure OpenAI, vLLM, LM Studio,
 * llama.cpp server, Groq, OpenRouter, Mistral, DeepSeek) via `baseUrl`.
 * `name` becomes both the registry key and the provider reported in results.
 */
export function openaiCompatibleAdapter(name: string, defaultBaseUrl: string): ModelAdapter {
  return {
    name,
    supports: (cap) => cap === "json-schema" || cap === "tools",
    async complete(req, cfg) {
      const base = (cfg.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");
      const json = req.jsonSchema !== undefined;
      const tools = req.tools?.length
        ? req.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;
      const body = await postJson(
        `${base}/chat/completions`,
        {
          model: cfg.model,
          messages: toOpenAIMessages(req.messages),
          temperature: 0.2,
          // Some endpoints (Groq) reject `response_format` combined with tools
          // (HTTP 400 "json mode cannot be combined with tool/function calling"),
          // so JSON is only forced on plain rounds — the router still validates
          // tool-round output against the schema and repairs it (§6.1).
          ...(json && !tools ? { response_format: { type: "json_object" } } : {}),
          ...(tools ? { tools } : {}),
        },
        {
          provider: name,
          signal: req.signal,
          timeoutMs: cfg.timeoutMs,
          headers: cfg.apiKey ? { authorization: `Bearer ${requireApiKey(cfg.apiKey, name)}` } : {},
        },
      );
      const message = (body as OpenAIChatResponse).choices?.[0]?.message;
      const toolCalls = parseToolCalls(message?.tool_calls);
      const content = message?.content;
      if (toolCalls) {
        return {
          text: typeof content === "string" ? content : "",
          toolCalls,
          provider: name,
          model: cfg.model,
          usage: usageOf(body as OpenAIChatResponse),
        };
      }
      if (typeof content !== "string") {
        throw new Error(`${name}: missing choices[0].message.content`);
      }
      return { text: content, provider: name, model: cfg.model, usage: usageOf(body as OpenAIChatResponse) };
    },
  };
}

export const openaiAdapter: ModelAdapter = openaiCompatibleAdapter(
  "openai",
  "https://api.openai.com/v1",
);
