import { internalError, AppErrorCode, RpcError } from "../a2a/errors";
import type {
  ModelAdapter,
  ModelChoice,
  ModelMessage,
  ModelRequest,
  ModelResult,
  ModelRole,
  ResolvedModelConfig,
  TokenUsage,
} from "./types";
import { ModelOutputInvalidError } from "./types";
import { mockAdapter } from "./adapters/mock";
import { ollamaAdapter } from "./adapters/ollama";
import { openaiAdapter } from "./adapters/openai";
import { groqAdapter } from "./adapters/groq";
import { anthropicAdapter } from "./adapters/anthropic";
import { geminiAdapter } from "./adapters/gemini";

export interface ModelEnvConfig {
  defaultProvider: string;
  defaultModel: string;
  roleOverrides: Partial<Record<ModelRole, { provider: string; model: string }>>;
  fallbackChain: string[];
  /** Per-call deadline in ms — a slow provider must fail fast into the chain. */
  timeoutMs: number;
  /** Preferred Groq model (GROQ_MODEL) — catalog default + fallback identity. */
  groqModel?: string;
  /** Max tool-execution rounds per model call before a forced final answer (§6.1). */
  toolRounds?: number;
}

export function readModelEnv(env: NodeJS.ProcessEnv = process.env): ModelEnvConfig {
  const roleOverrides: ModelEnvConfig["roleOverrides"] = {};
  for (const role of ["intent", "research", "synthesis"] as const) {
    const provider = env[`MODEL_${role.toUpperCase()}_PROVIDER`];
    if (provider) {
      roleOverrides[role] = {
        provider,
        model: env[`MODEL_${role.toUpperCase()}_MODEL`] ?? env.MODEL_MODEL ?? "default",
      };
    }
  }
  return {
    defaultProvider: env.MODEL_PROVIDER ?? "ollama",
    defaultModel: env.MODEL_MODEL ?? "llama3.1:8b",
    roleOverrides,
    fallbackChain: (env.MODEL_FALLBACK_CHAIN ?? "ollama,mock")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: Number(env.MODEL_TIMEOUT_MS ?? 60_000),
    groqModel: env.GROQ_MODEL?.trim() || undefined,
    toolRounds: Math.max(1, Number(env.MODEL_TOOL_ROUNDS ?? 3)),
  };
}

export function providerConfig(
  provider: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelConfig {
  switch (provider) {
    case "ollama":
      return { provider, model, baseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434" };
    case "groq":
      return {
        provider,
        model,
        baseUrl: env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
        apiKey: env.GROQ_API_KEY,
      };
    case "openai":
      return {
        provider,
        model,
        baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: env.OPENAI_API_KEY,
      };
    case "anthropic":
      return {
        provider,
        model,
        baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
        apiKey: env.ANTHROPIC_API_KEY,
      };
    case "gemini":
      return {
        provider,
        model,
        baseUrl: env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
        apiKey: env.GEMINI_API_KEY,
      };
    default:
      return { provider, model };
  }
}

export interface CompleteResult<T = unknown> {
  text: string;
  provider: string;
  model: string;
  value?: T;
  /** Combined token usage across the attempt(s) that produced this result. */
  usage?: TokenUsage;
  /** Tools were requested but no chain candidate could call them — the plain
   *  request was used instead; the caller SHOULD surface this to the user (§6.1). */
  toolsDegraded?: boolean;
}

/**
 * Role-routed model router (§6.1): role override → default provider →
 * fallback chain. Structured outputs are validated against the caller's Zod
 * schema with exactly one repair retry before moving to the next backend.
 */
export class ModelRouter {
  private adapters = new Map<string, ModelAdapter>();

  constructor(
    private readonly env: ModelEnvConfig = readModelEnv(),
    adapters: ModelAdapter[] = [mockAdapter, ollamaAdapter, openaiAdapter, groqAdapter, anthropicAdapter, geminiAdapter],
  ) {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  private candidates(role: ModelRole, override?: ModelChoice): ResolvedModelConfig[] {
    const roleOverride = this.env.roleOverrides[role];
    const chosen: ModelChoice =
      override ?? roleOverride ?? { provider: this.env.defaultProvider, model: this.env.defaultModel };
    // The mock backend has no real model identity; only a per-plan choice may name it.
    const first: ResolvedModelConfig =
      chosen.provider === "mock" && !override ? { provider: "mock", model: "mock" } : { ...chosen };
    const chain = [
      first,
      ...this.env.fallbackChain.map((p) => ({ provider: p, model: this.fallbackModelFor(p, first) })),
    ];
    const seen = new Set<string>();
    return chain.filter((c) => {
      if (seen.has(c.provider)) return false;
      seen.add(c.provider);
      return true;
    });
  }

  /**
   * A fallback provider gets a model it can actually serve: its own configured
   * default when we know one, otherwise the selected model.
   */
  private fallbackModelFor(provider: string, first: ResolvedModelConfig): string {
    if (provider === first.provider) return first.model;
    if (provider === "mock") return "mock";
    if (provider === "groq" && this.env.groqModel) return this.env.groqModel;
    if (provider === this.env.defaultProvider) return this.env.defaultModel;
    return first.model;
  }

  /** First candidate for a role — used to announce "working with X" before a call. */
  describe(role: ModelRole, override?: ModelChoice): { provider: string; model: string } {
    const first = this.candidates(role, override)[0];
    return { provider: first?.provider ?? this.env.defaultProvider, model: first?.model ?? this.env.defaultModel };
  }

  async complete<T = unknown>(req: ModelRequest): Promise<CompleteResult<T>> {
    if (req.tools?.length && !req.executeTool) {
      // Programming error: the router never executes tools itself — the caller owns SSRF/budget.
      throw internalError(
        AppErrorCode.InvalidParams,
        "ModelRequest.tools requires an executeTool handler",
        false,
        { role: req.role },
      );
    }
    const wantTools = Boolean(req.tools?.length);
    let toolsDegraded = false;
    let current: ModelRequest = req;
    if (wantTools && !this.anyToolCandidate(req)) {
      // No chain candidate can call tools — degrade to the plain request (§6.1).
      toolsDegraded = true;
      current = { ...req, tools: undefined, executeTool: undefined };
    }
    try {
      const result = await this.runChain<T>(current);
      return toolsDegraded ? { ...result, toolsDegraded } : result;
    } catch (err) {
      if (!wantTools || toolsDegraded) throw err;
      // A capable backend still failed with tools — one graceful plain retry,
      // then surface the original failure (never a hard error for tool issues).
      try {
        const result = await this.runChain<T>({ ...req, tools: undefined, executeTool: undefined });
        return { ...result, toolsDegraded: true };
      } catch {
        throw err;
      }
    }
  }

  /** Does any chain candidate advertise the "tools" capability? */
  private anyToolCandidate(req: ModelRequest): boolean {
    return this.candidates(req.role, req.override).some((c) => {
      const adapter = this.adapters.get(c.provider);
      return adapter?.supports("tools") ?? false;
    });
  }

  /** Fallback-chain walk for one request (§6.1) — candidates sliced by deadline. */
  private async runChain<T>(req: ModelRequest): Promise<CompleteResult<T>> {
    const configs = this.candidates(req.role, req.override);
    const deadline = req.deadlineMs === undefined ? undefined : Date.now() + req.deadlineMs;
    let lastError: unknown;
    let budgetError: unknown;

    const exhausted = (provider: string): RpcError =>
      internalError(
        AppErrorCode.ModelUnavailable,
        `Model budget exhausted for role "${req.role}" — ${Math.max(0, deadline! - Date.now())}ms of the section deadline left`,
        true,
        { role: req.role, provider },
      );

    let index = 0;
    for (const cfg of configs) {
      index += 1;
      let slice: number | undefined;
      if (deadline !== undefined) {
        slice = candidateBudgetMs(deadline - Date.now(), configs.length - index + 1, this.env.timeoutMs);
        if (slice === undefined) {
          // Not enough of the section budget left to start a call — stop here so
          // one slow candidate can never starve the rest of the chain (§6.1).
          budgetError = exhausted(cfg.provider);
          break;
        }
      }
      const adapter = this.adapters.get(cfg.provider);
      if (!adapter) {
        lastError = internalError(
          AppErrorCode.ModelUnavailable,
          `No adapter registered for provider "${cfg.provider}"`,
          false,
          { provider: cfg.provider },
        );
        continue;
      }
      if (req.jsonSchema && !adapter.supports("json-schema")) continue;
      if (req.tools?.length && !adapter.supports("tools")) continue;

      const resolved: ResolvedModelConfig = {
        ...providerConfig(cfg.provider, cfg.model),
        timeoutMs: slice ?? this.env.timeoutMs,
      };
      const callReq = slice === undefined ? req : withTimeout(req, slice);
      const sliceEnd = slice === undefined ? undefined : Date.now() + slice;

      try {
        const result = await this.callWithTools<T>(callReq, resolved, adapter, sliceEnd, exhausted);
        if (!req.jsonSchema) return result;

        const parsed = tryParse(req, result.text);
        if (parsed) return { ...result, value: parsed as T };

        // one schema-repair retry (§6.1), re-slicing whatever the deadline still allows
        const issues = validateIssues(req, result.text);
        let repairReq = callReq;
        let repairCfg = resolved;
        if (deadline !== undefined) {
          const budget = candidateBudgetMs(deadline - Date.now(), 1, this.env.timeoutMs);
          if (budget === undefined) {
            budgetError = exhausted(cfg.provider);
            break;
          }
          repairCfg = { ...resolved, timeoutMs: budget };
          repairReq = withTimeout(req, budget);
        }
        const repaired = await adapter.complete(
          {
            ...repairReq,
            // Repair is a formatting fix, not a research round — no tools (§6.1).
            tools: undefined,
            executeTool: undefined,
            messages: [
              ...req.messages,
              { role: "assistant", content: result.text },
              {
                role: "user",
                content: `The JSON you returned is invalid:\n${issues.join("\n")}\nReturn corrected JSON only.`,
              },
            ],
          },
          repairCfg,
        );
        const reparsed = tryParse(req, repaired.text);
        if (reparsed) {
          return {
            ...repaired,
            value: reparsed as T,
            usage: addUsage(result.usage, repaired.usage),
          };
        }

        lastError = internalError(
          AppErrorCode.ModelOutputInvalid,
          `Model output failed schema validation for role "${req.role}"`,
          false,
          { provider: cfg.provider, issues: validateIssues(req, repaired.text) },
        );
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    const finalError = lastError ?? budgetError;
    if (finalError instanceof RpcError) throw finalError;
    if (finalError instanceof ModelOutputInvalidError) {
      throw internalError(AppErrorCode.ModelOutputInvalid, finalError.message, false);
    }
    throw finalError ?? internalError(
      AppErrorCode.ModelUnavailable,
      `No model backend available for role "${req.role}"`,
      true,
      { role: req.role, tried: configs.map((c) => c.provider) },
    );
  }

  /**
   * One candidate's §6.1 tool loop: the model may answer with tool calls
   * instead of text; each round executes them via the caller's `executeTool`
   * and feeds the results back until it produces final text — or the round cap
   * forces a tool-free answer. Rounds share the candidate's deadline slice
   * with fair re-slicing, so a chatty model can never starve the chain.
   */
  private async callWithTools<T>(
    baseReq: ModelRequest,
    baseCfg: ResolvedModelConfig,
    adapter: ModelAdapter,
    sliceEnd: number | undefined,
    exhausted: (provider: string) => RpcError,
  ): Promise<CompleteResult<T>> {
    const tools = baseReq.tools;
    const maxRounds = tools?.length ? (this.env.toolRounds ?? 3) : 0;
    let messages = baseReq.messages;
    let usage: TokenUsage | undefined;
    let rounds = 0;

    for (;;) {
      const offerTools = Boolean(tools?.length) && rounds < maxRounds;
      // Fair share of the remaining slice for this round (mirrors candidate slicing).
      let cfg = baseCfg;
      if (sliceEnd !== undefined) {
        const roundsLeft = (maxRounds - rounds) + 1;
        const budget = candidateBudgetMs(sliceEnd - Date.now(), offerTools ? roundsLeft : 1, this.env.timeoutMs);
        if (budget === undefined) {
          throw exhausted(baseCfg.provider);
        }
        cfg = { ...baseCfg, timeoutMs: Math.min(baseCfg.timeoutMs ?? this.env.timeoutMs, budget) };
      }
      const roundReq: ModelRequest = {
        ...baseReq,
        messages,
        ...(offerTools ? { tools: tools! } : { tools: undefined, executeTool: undefined }),
      };

      let result: ModelResult;
      try {
        result = await adapter.complete(roundReq, cfg);
      } catch (err) {
        // Some backends (Groq) validate tool names server-side and reject the
        // whole call with HTTP 400 when the model invents one. That is exactly
        // the hallucinated-tool case §6.1 turns into feedback — never a failed
        // candidate — so report it back and let the model answer.
        if (offerTools && isRejectedToolCall(err)) {
          rounds += 1;
          messages = [
            ...messages,
            {
              role: "user",
              content:
                `TOOL_ERROR: the backend rejected that tool call — ` +
                `only these tools may be called: ${tools!.map((t) => t.name).join(", ")}. ` +
                `Reply with a valid tool call or with your final answer.`,
            },
          ];
          continue;
        }
        throw err;
      }
      usage = addUsage(usage, result.usage);

      if (!result.toolCalls?.length) {
        return { ...result, usage };
      }
      if (!offerTools) {
        // Round cap reached — the model insisted on another call. Accept any
        // text it also produced; without text the schema path rejects it.
        if (result.text.trim()) return { ...result, usage };
        throw internalError(
          AppErrorCode.ModelOutputInvalid,
          `Model kept requesting tools past the ${maxRounds}-round cap for role "${baseReq.role}"`,
          false,
          { provider: baseCfg.provider },
        );
      }

      rounds += 1;
      const executed: ModelMessage[] = [
        { role: "assistant", content: result.text, toolCalls: result.toolCalls },
      ];
      for (const call of result.toolCalls) {
        let output: string;
        if (!tools!.some((t) => t.name === call.name)) {
          // Never execute a hallucinated tool name — report it back instead.
          output = `TOOL_ERROR: unknown tool "${call.name}" (available: ${tools!.map((t) => t.name).join(", ")})`;
        } else {
          try {
            output = await baseReq.executeTool!(call);
          } catch (err) {
            // A failing tool degrades to feedback, not to a failed model call.
            output = `TOOL_ERROR: ${err instanceof Error ? err.message : "tool execution failed"}`;
          }
        }
        executed.push({
          role: "tool",
          content: output,
          ...(call.id !== undefined ? { toolCallId: call.id } : {}),
          toolName: call.name,
        });
      }
      messages = [...messages, ...executed];
    }
  }
}

/**
 * Smallest deadline share worth starting a call with — below this the budget is
 * treated as exhausted rather than attempted (§6.1 deadline slicing).
 */
const MIN_BUDGET_MS = 250;

/**
 * Did the backend reject a tool call the *model* asked for (Groq validates tool
 * names server-side and answers HTTP 400 before we ever see the call)? Those are
 * the hallucinated-tool case §6.1 reports back as `TOOL_ERROR` feedback; every
 * other 400 (bad model id, request shape, …) must still fail the candidate.
 */
const TOOL_REJECTION = /tool call validation failed|attempted to call tool|not in request\.tools|tool_use_failed|invalid (?:tool|function) call/i;

export function isRejectedToolCall(err: unknown): boolean {
  return (
    err instanceof RpcError &&
    err.data?.status === 400 &&
    TOOL_REJECTION.test(err.message)
  );
}

/**
 * One upcoming call's slice of the remaining absolute deadline: its fair share
 * of what is left, never more than the per-call cap. Returns `undefined` when
 * the share would be too small to attempt (§6.1 deadline slicing).
 */
export function candidateBudgetMs(remainingMs: number, shares: number, capMs: number): number | undefined {
  const budget = Math.min(capMs, remainingMs, Math.ceil(remainingMs / Math.max(1, shares)));
  return budget < MIN_BUDGET_MS ? undefined : budget;
}

/** A copy of `req` whose signal also fires after `timeoutMs` (composed, never displaced). */
function withTimeout(req: ModelRequest, timeoutMs: number): ModelRequest {
  return {
    ...req,
    signal: req.signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), req.signal])
      : AbortSignal.timeout(timeoutMs),
  };
}

function tryParse(req: ModelRequest, text: string): unknown | undefined {
  if (!req.jsonSchema) return text;
  const result = req.jsonSchema.schema.safeParse(extractJson(text));
  return result.success ? result.data : undefined;
}

function addUsage(...usages: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const present = usages.filter((u): u is TokenUsage => u !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce(
    (acc, u) => ({ prompt: acc.prompt + u.prompt, completion: acc.completion + u.completion, total: acc.total + u.total }),
    { prompt: 0, completion: 0, total: 0 },
  );
}

function validateIssues(req: ModelRequest, text: string): string[] {
  if (!req.jsonSchema) return [];
  const result = req.jsonSchema.schema.safeParse(extractJson(text));
  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
