import type { ModelAdapter, ModelMessage, ToolCall, TokenUsage } from "../types";
import { postJson } from "./http";

interface OllamaToolCall {
  id?: string;
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  prompt_eval_count?: number;
  eval_count?: number;
}

function usageOf(body: OllamaChatResponse): TokenUsage | undefined {
  if (typeof body.prompt_eval_count !== "number" || typeof body.eval_count !== "number") {
    return undefined;
  }
  return {
    prompt: body.prompt_eval_count,
    completion: body.eval_count,
    total: body.prompt_eval_count + body.eval_count,
  };
}

/** Wire messages: neutral shape → Ollama /api/chat (verified live: object arguments). */
function toOllamaMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_name: m.toolName ?? "" };
    }
    if (m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          ...(c.id !== undefined ? { id: c.id } : {}),
          function: { name: c.name, arguments: c.arguments ?? {} },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Ollama tool_calls → neutral ToolCall (arguments arrive as an object). */
function parseToolCalls(calls: OllamaToolCall[] | undefined): ToolCall[] | undefined {
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
        if (obj && typeof obj === "object" && !Array.isArray(obj)) args = obj as Record<string, unknown>;
      } catch {
        // malformed arguments — executor validates and reports back
      }
    } else if (raw && typeof raw === "object") {
      args = raw as Record<string, unknown>;
    }
    parsed.push({ ...(c.id !== undefined ? { id: c.id } : {}), name, arguments: args });
  }
  return parsed.length > 0 ? parsed : undefined;
}

export const ollamaAdapter: ModelAdapter = {
  name: "ollama",
  supports: (cap) => cap === "json-schema" || cap === "tools",
  async complete(req, cfg) {
    const base = (cfg.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    const json = req.jsonSchema !== undefined;
    const tools = req.tools?.length
      ? req.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;
    const body = await postJson(
      `${base}/api/chat`,
      {
        model: cfg.model,
        messages: toOllamaMessages(req.messages),
        stream: false,
        ...(json && !tools ? { format: "json" } : {}),
        ...(tools ? { tools } : {}),
        options: { temperature: 0.2 },
      },
      { provider: "ollama", signal: req.signal, timeoutMs: cfg.timeoutMs },
    );
    const message = (body as OllamaChatResponse).message;
    const toolCalls = parseToolCalls(message?.tool_calls);
    const content = message?.content;
    if (toolCalls) {
      return {
        text: typeof content === "string" ? content : "",
        toolCalls,
        provider: "ollama",
        model: cfg.model,
        usage: usageOf(body as OllamaChatResponse),
      };
    }
    if (typeof content !== "string") {
      throw new Error("ollama: missing message.content in response");
    }
    return { text: content, provider: "ollama", model: cfg.model, usage: usageOf(body as OllamaChatResponse) };
  },
};
