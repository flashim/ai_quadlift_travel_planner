import type { z } from "zod";

export const MODEL_ROLES = ["intent", "research", "synthesis"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelCapability = "json-schema" | "tools";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant turn proposing one or more tool calls (§6.1 tool loop). */
  toolCalls?: ToolCall[];
  /** Tool-result turn: which call this message answers. */
  toolCallId?: string;
  toolName?: string;
}

/** A tool the model may call during a request — the agent executes it (§6.1). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for arguments — the wire format every provider accepts. */
  parameters: Record<string, unknown>;
}

/** One invocation requested by the model. Arguments are pre-parsed objects. */
export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface JsonSchemaField<T> {
  name: string;
  schema: z.ZodType<T>;
}

/** Per-plan runtime model choice (UI header → PlanInput.model, §6.1). */
export interface ModelChoice {
  provider: string;
  model: string;
}

export interface ModelRequest {
  role: ModelRole;
  messages: ModelMessage[];
  jsonSchema?: JsonSchemaField<unknown>;
  signal?: AbortSignal;
  /** Runtime override chosen for one plan — wins over role/default config. */
  override?: ModelChoice;
  /** Absolute section budget in ms (agent registry timeoutMs, §9) — the router slices it across fallback candidates (§6.1). */
  deadlineMs?: number;
  /** Tools the model may call; requires `executeTool` (the caller owns execution, §6.1). */
  tools?: ToolDefinition[];
  /**
   * Executes one tool call on behalf of the model. The caller (agent) owns
   * SSRF/budget/validation guarantees — the router only orchestrates rounds.
   */
  executeTool?: (call: ToolCall) => Promise<string>;
}

export interface ResolvedModelConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Per-call deadline in ms (MODEL_TIMEOUT_MS, default 60 000). */
  timeoutMs?: number;
}

/** Token accounting for one model call (prompt/in + completion/out). */
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ModelResult {
  text: string;
  provider: string;
  model: string;
  /** Reported by the backend when available; the mock adapter estimates it. */
  usage?: TokenUsage;
  /** Present when the model answered with tool calls instead of final text. */
  toolCalls?: ToolCall[];
}

export interface ModelAdapter {
  readonly name: string;
  supports(capability: ModelCapability): boolean;
  complete(req: ModelRequest, cfg: ResolvedModelConfig): Promise<ModelResult>;
}

export class ModelOutputInvalidError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = "ModelOutputInvalidError";
  }
}
