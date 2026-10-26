import type { ModelAdapter, ModelMessage, ToolCall, TokenUsage } from "../types";
import { postJson, requireApiKey } from "./http";

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }[];
    };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

function usageOf(body: GeminiResponse): TokenUsage | undefined {
  const u = body.usageMetadata;
  if (typeof u?.promptTokenCount !== "number" || typeof u.candidatesTokenCount !== "number") {
    return undefined;
  }
  return {
    prompt: u.promptTokenCount,
    completion: u.candidatesTokenCount,
    total: u.totalTokenCount ?? u.promptTokenCount + u.candidatesTokenCount,
  };
}

/**
 * Wire messages: neutral shape → Gemini contents/parts. Tool calls are
 * `functionCall` parts on a model turn; results are `functionResponse` parts
 * on the next user turn (§6.1). `responseSchema`-style keys are stripped from
 * tool parameter schemas — Gemini rejects them.
 */
function toGeminiContents(messages: ModelMessage[]): unknown[] {
  const out: { role: string; parts: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const part = {
        functionResponse: {
          name: m.toolName ?? "tool",
          response: { output: m.content },
        },
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user") {
        prev.parts.push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: unknown[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const c of m.toolCalls ?? []) {
      parts.push({ functionCall: { name: c.name, args: c.arguments ?? {} } });
    }
    if (parts.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      out.push({ role, parts });
    }
  }
  return out;
}

/** Gemini forbids several JSON-Schema keywords — drop them before sending. */
function toGeminiParams(schema: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "$id" || k === "additionalProperties") continue;
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] =
          pv && typeof pv === "object" && !Array.isArray(pv)
            ? toGeminiParams(pv as Record<string, unknown>)
            : pv;
      }
      clean[k] = props;
      continue;
    }
    if ((k === "items" || k === "definitions") && v && typeof v === "object" && !Array.isArray(v)) {
      clean[k] = toGeminiParams(v as Record<string, unknown>);
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

export const geminiAdapter: ModelAdapter = {
  name: "gemini",
  supports: (cap) => cap === "json-schema" || cap === "tools",
  async complete(req, cfg) {
    const base = (cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/+$/,
      "",
    );
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = toGeminiContents(req.messages);
    const key = requireApiKey(cfg.apiKey, "gemini");
    const tools = req.tools?.length
      ? [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: toGeminiParams(t.parameters),
            })),
          },
        ]
      : undefined;
    const body = await postJson(
      `${base}/models/${cfg.model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        ...(system
          ? { systemInstruction: { parts: [{ text: system }] } }
          : {}),
        contents,
        ...(tools ? { tools } : {}),
        generationConfig: {
          temperature: 0.2,
          ...(req.jsonSchema && !tools ? { responseMimeType: "application/json" } : {}),
        },
      },
      { provider: "gemini", signal: req.signal, timeoutMs: cfg.timeoutMs },
    );
    const parts = (body as GeminiResponse).candidates?.[0]?.content?.parts ?? [];
    const functionCalls = parts
      .map((p) => p.functionCall)
      .filter((fc): fc is { name?: string; args?: Record<string, unknown> } => Boolean(fc));
    if (functionCalls.length > 0) {
      const toolCalls: ToolCall[] = functionCalls
        .filter((fc) => typeof fc.name === "string")
        .map((fc) => ({
          name: fc.name as string,
          arguments: fc.args ?? {},
        }));
      const text = parts.map((p) => p.text ?? "").join("");
      return { text, toolCalls, provider: "gemini", model: cfg.model, usage: usageOf(body as GeminiResponse) };
    }
    const text = parts.map((p) => p.text ?? "").join("");
    if (!text) throw new Error("gemini: empty candidates");
    return { text, provider: "gemini", model: cfg.model, usage: usageOf(body as GeminiResponse) };
  },
};
