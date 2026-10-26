import type { ModelAdapter, ModelMessage, ToolCall, TokenUsage } from "../types";
import { postJson, requireApiKey } from "./http";

interface AnthropicToolUse {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function usageOf(body: AnthropicResponse): TokenUsage | undefined {
  const u = body.usage;
  if (typeof u?.input_tokens !== "number" || typeof u.output_tokens !== "number") {
    return undefined;
  }
  return {
    prompt: u.input_tokens,
    completion: u.output_tokens,
    total: u.input_tokens + u.output_tokens,
  };
}

/**
 * Wire messages: neutral shape → Anthropic content blocks. Tool results ride in
 * a `user` message as `tool_result` blocks; tool calls are `tool_use` blocks
 * on the assistant turn (§6.1).
 */
function toAnthropicMessages(messages: ModelMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      const prev = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(block); // consecutive results share one user turn
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool_use",
            id: c.id ?? `call_${c.name}`,
            name: c.name,
            input: c.arguments ?? {},
          })),
        ],
      });
      continue;
    }
    const prev = out[out.length - 1] as { role?: string; content?: unknown } | undefined;
    if (prev && prev.role === m.role && typeof prev.content === "string") {
      prev.content = `${prev.content}\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const anthropicAdapter: ModelAdapter = {
  name: "anthropic",
  supports: (cap) => cap === "json-schema" || cap === "tools",
  async complete(req, cfg) {
    const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = toAnthropicMessages(req.messages);
    // Nudge only on tool-free turns — a tool round must stay a tool round.
    if (req.jsonSchema && !req.tools?.length) {
      messages.push({
        role: "user",
        content: "Return only a JSON object that satisfies the requested schema.",
      });
    }
    const tools = req.tools?.length
      ? req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }))
      : undefined;
    const body = await postJson(
      `${base}/v1/messages`,
      {
        model: cfg.model,
        max_tokens: 4096,
        temperature: 0.2,
        ...(system ? { system } : {}),
        messages,
        ...(tools ? { tools } : {}),
      },
      {
        provider: "anthropic",
        signal: req.signal,
        timeoutMs: cfg.timeoutMs,
        headers: {
          "x-api-key": requireApiKey(cfg.apiKey, "anthropic"),
          "anthropic-version": "2023-06-01",
        },
      },
    );
    const content = (body as AnthropicResponse).content ?? [];
    const toolUses = content.filter((b) => b.type === "tool_use") as AnthropicToolUse[];
    if (toolUses.length > 0) {
      const toolCalls: ToolCall[] = toolUses
        .filter((t) => typeof t.name === "string")
        .map((t) => ({
          id: t.id,
          name: t.name as string,
          arguments: t.input ?? {},
        }));
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return {
        text,
        toolCalls,
        provider: "anthropic",
        model: cfg.model,
        usage: usageOf(body as AnthropicResponse),
      };
    }
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (!text) throw new Error("anthropic: empty content");
    return { text, provider: "anthropic", model: cfg.model, usage: usageOf(body as AnthropicResponse) };
  },
};
