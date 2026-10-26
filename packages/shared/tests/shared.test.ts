import { resolve } from "node:path";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { loadRegistry, baseUrlEnvVar, sectionProviders } from "../src/registry";
import { rpcCall } from "../src/a2a/client";
import { MemoryPlanRepository } from "../src/persistence/repository";
import {
  ModelRouter,
  readModelEnv,
  extractJson,
  providerConfig,
  candidateBudgetMs,
  isRejectedToolCall,
  type ModelEnvConfig,
} from "../src/model/resolve";
import { RpcError, RpcCode, AppErrorCode } from "../src/a2a/errors";
import { groqAdapter } from "../src/model/adapters/groq";
import { mockAdapter } from "../src/model/adapters/mock";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResult,
  ToolCall,
  ToolDefinition,
} from "../src/model/types";
import { researchResultSchema, hrSectionSchema } from "../src/schemas/section";
import { modelCatalog } from "../src/model/catalog";
import { buildIntentRequest, buildSynthesisRequest } from "../src/model/prompts";
import { durationDays, durationFromDates, durationFromQuery, resolveDuration } from "../src/duration";
import { createAgentServer } from "../src/a2a/server";
import { createAgentCard } from "../src/schemas/agent-card";
import { planEventTypeSchema, planInputSchema, planStateSchema, modelRunSchema } from "../src/schemas/plan";

describe("agent registry", () => {
  it("loads config/agents.json and applies env baseUrl overrides", () => {
    process.env[baseUrlEnvVar("weather")] = "http://agent-weather:8002/";
    try {
      const registry = loadRegistry("./config/agents.json");
      expect(registry.agents.map((a) => a.name)).toContain("weather");
      const weather = registry.agents.find((a) => a.name === "weather")!;
      expect(weather.baseUrl).toBe("http://agent-weather:8002");
      expect(weather.sections).toEqual(["weather"]);
    } finally {
      delete process.env[baseUrlEnvVar("weather")];
    }
  });

  it("maps sections to provider agents", () => {
    const registry = loadRegistry("./config/agents.json");
    const providers = sectionProviders(registry);
    expect(providers.get("destination")?.name).toBe("destination-research");
    expect(providers.get("weather")?.name).toBe("weather");
  });

  it("resolves a relative registry path from a nested cwd (repo-root walk-up)", () => {
    const nested = resolve(process.cwd(), "apps", "orchestrator");
    vi.stubEnv("AGENTS_REGISTRY_PATH", "./config/agents.json");
    const spy = vi.spyOn(process, "cwd").mockReturnValue(nested);
    try {
      const registry = loadRegistry();
      expect(registry.agents.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("memory plan repository", () => {
  it("stores plans and replays events after sinceId", async () => {
    const repo = new MemoryPlanRepository();
    const now = new Date().toISOString();
    await repo.create({
      planId: "p1",
      status: "created",
      input: planInputSchema.parse({ query: "5 days in Paris" }),
      sections: {},
      errors: [],
      modelRuns: [],
      createdAt: now,
      updatedAt: now,
    });
    await repo.appendEvent({ planId: "p1", type: "plan.created", data: {}, ts: now });
    await repo.appendEvent({ planId: "p1", type: "intent.parsed", data: {}, ts: now });
    const all = await repo.listEvents("p1");
    expect(all.map((e) => e.id)).toEqual([1, 2]);
    const since = await repo.listEvents("p1", 1);
    expect(since).toHaveLength(1);
    expect(since[0]!.type).toBe("intent.parsed");
  });

  it("merges concurrent functional section writes without lost updates", async () => {
    const repo = new MemoryPlanRepository();
    const now = new Date().toISOString();
    await repo.create({
      planId: "p2",
      status: "running",
      input: planInputSchema.parse({ query: "5 days in Paris" }),
      sections: {},
      errors: [],
      modelRuns: [],
      createdAt: now,
      updatedAt: now,
    });
    const write = (key: string) =>
      repo.update("p2", (plan) => ({
        sections: {
          ...plan.sections,
          [key]: { key, status: "completed" as const, data: { ok: true } },
        },
      }));
    await Promise.all([write("destination"), write("weather")]);
    const plan = await repo.get("p2");
    expect(Object.keys(plan!.sections).sort()).toEqual(["destination", "weather"]);
  });
});

describe("signal composition", () => {
  it("rpcCall keeps its own deadline when a caller signal is provided", async () => {
    const server = createServer(() => {
      /* accept the request but never respond */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const neverAborted = new AbortController();
    try {
      const started = Date.now();
      await expect(
        rpcCall(`http://127.0.0.1:${port}`, "message/send", {}, {
          timeoutMs: 80,
          signal: neverAborted.signal,
        }),
      ).rejects.toThrow("Agent timed out after 80ms");
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 5_000);
});

describe("model router", () => {
  it("falls back to the mock adapter and validates structured output", async () => {
    const env = readModelEnv({
      MODEL_PROVIDER: "ollama",
      MODEL_FALLBACK_CHAIN: "mock",
      MODEL_MODEL: "test-model",
    });
    const router = new ModelRouter(env);
    const req = buildIntentRequest(
      planInputSchema.parse({
        query: "Plan five days in Paris from 2026-10-05 to 2026-10-09",
        travelerCount: 2,
      }),
    );
    const result = await router.complete(req);
    expect(result.provider).toBe("mock");
    expect(result.value).toMatchObject({ destination: "Paris", startDate: "2026-10-05" });
    expect(result.usage?.total).toBeGreaterThan(0);
    expect(result.usage?.total).toBe((result.usage?.prompt ?? 0) + (result.usage?.completion ?? 0));
    // describe() reports the configured first candidate (before fallback) for "working with X" frames
    expect(router.describe("intent")).toEqual({ provider: "ollama", model: "test-model" });
  });

  it("extracts JSON from fenced model output", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

/** Scripted adapter: one reply per call, recording what it was asked. */
function scriptedAdapter(
  name: string,
  replies: Partial<ModelResult>[],
  opts: { tools?: boolean; jsonSchema?: boolean } = {},
): { adapter: ModelAdapter; rounds: ModelRequest[] } {
  const rounds: ModelRequest[] = [];
  let round = 0;
  return {
    rounds,
    adapter: {
      name,
      supports: (cap) =>
        cap === "json-schema" ? (opts.jsonSchema ?? true) : (opts.tools ?? true),
      complete: async (req) => {
        rounds.push(req);
        const reply = replies[Math.min(round, replies.length - 1)] ?? { text: "{}" };
        round += 1;
        return {
          text: "",
          provider: name,
          model: `${name}-model`,
          ...reply,
        };
      },
    },
  };
}

describe("model tool loop (§6.1)", () => {
  const researchReq = (tools: ToolDefinition[], executeTool: (call: ToolCall) => Promise<string>) => ({
    role: "research" as const,
    messages: [{ role: "user" as const, content: "DESTINATION: Paris\nEXTRACT:\nreference" }],
    tools,
    executeTool,
  });
  const tools: ToolDefinition[] = [
    {
      name: "search_articles",
      description: "search",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ];

  it("executes tool calls and feeds results back until the model answers", async () => {
    const { adapter, rounds } = scriptedAdapter("toolful", [
      { text: "", toolCalls: [{ id: "c1", name: "search_articles", arguments: { query: "Paris" } }] },
      { text: '{"brief":"Paris","highlights":["Eiffel Tower"]}' },
    ]);
    const router = new ModelRouter(
      { defaultProvider: "toolful", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [adapter],
    );
    const seen: ToolCall[] = [];
    const result = await router.complete<{ brief: string }>({
      ...researchReq(tools, async (call) => {
        seen.push(call);
        return "Paris is the capital of France.";
      }),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });

    expect(seen).toEqual([{ id: "c1", name: "search_articles", arguments: { query: "Paris" } }]);
    expect(result.value).toMatchObject({ brief: "Paris" });
    // round 2 must carry the assistant tool-call turn plus the tool result
    expect(rounds).toHaveLength(2);
    expect(rounds[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(rounds[1]?.messages[2]).toMatchObject({
      role: "tool",
      content: "Paris is the capital of France.",
      toolCallId: "c1",
      toolName: "search_articles",
    });
    // tools stay offered on later rounds so the model can chain several lookups;
    // they are only stripped at the round cap (and on the repair retry).
    expect(rounds[1]?.tools).toEqual(tools);
  });

  it("never executes a hallucinated tool name — it reports the error back", async () => {
    const { adapter, rounds } = scriptedAdapter("toolful", [
      { text: "", toolCalls: [{ id: "c1", name: "drop_database", arguments: {} }] },
      { text: '{"brief":"Paris","highlights":[]}' },
    ]);
    const router = new ModelRouter(
      { defaultProvider: "toolful", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [adapter],
    );
    const executeTool = vi.fn(async () => "unused");
    await router.complete({
      ...researchReq(tools, executeTool),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(rounds[1]?.messages[2]).toMatchObject({
      role: "tool",
      content: expect.stringContaining('TOOL_ERROR: unknown tool "drop_database"'),
    });
  });

  it("turns a failing tool into feedback instead of a failed model call", async () => {
    const { adapter, rounds } = scriptedAdapter("toolful", [
      { text: "", toolCalls: [{ id: "c1", name: "search_articles", arguments: {} }] },
      { text: '{"brief":"Paris","highlights":[]}' },
    ]);
    const router = new ModelRouter(
      { defaultProvider: "toolful", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [adapter],
    );
    const result = await router.complete({
      ...researchReq(tools, async () => {
        throw new Error("upstream exploded");
      }),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });
    expect(result.value).toMatchObject({ brief: "Paris" });
    expect(rounds[1]?.messages[2]).toMatchObject({
      content: "TOOL_ERROR: upstream exploded",
    });
  });

  it("turns a backend-rejected tool call into feedback instead of failing the candidate", async () => {
    // Groq validates tool names server-side and answers HTTP 400 before we ever
    // see the call — §6.1 must still report it back, not burn the candidate.
    const rejecting: ModelAdapter = {
      name: "toolful",
      supports: () => true,
      complete: async (req) => {
        if (req.tools?.length) {
          throw new RpcError(RpcCode.InternalError, "groq: HTTP 400 tool call validation failed: attempted to call tool 'JSON'", {
            code: AppErrorCode.ModelUnavailable,
            retryable: false,
            provider: "groq",
            status: 400,
          });
        }
        return { text: '{"brief":"Paris","highlights":[]}', provider: "toolful", model: "m" };
      },
    };
    const router = new ModelRouter(
      { defaultProvider: "toolful", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [rejecting],
    );
    const executeTool = vi.fn(async () => "unused");
    const result = await router.complete({
      ...researchReq(tools, executeTool),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });

    expect(result.value).toMatchObject({ brief: "Paris" });
    expect(executeTool).not.toHaveBeenCalled();
    expect(isRejectedToolCall(
      new RpcError(RpcCode.InternalError, "groq: HTTP 400 attempted to call tool 'JSON'", { status: 400 }),
    )).toBe(true);
    expect(isRejectedToolCall(new Error("groq: HTTP 400 attempted to call tool 'JSON'"))).toBe(false);
    expect(isRejectedToolCall(
      new RpcError(RpcCode.InternalError, "groq: HTTP 400 model not found", { status: 400 }),
    )).toBe(false);
  });

  it("strips tools at the round cap and completes via the tool-free retry", async () => {
    const { adapter, rounds } = scriptedAdapter("toolful", [
      { text: "", toolCalls: [{ id: "c1", name: "search_articles", arguments: {} }] },
      { text: "", toolCalls: [{ id: "c2", name: "search_articles", arguments: {} }] },
      { text: "", toolCalls: [{ id: "c3", name: "search_articles", arguments: {} }] },
      { text: '{"brief":"Paris","highlights":[]}' },
    ]);
    const router = new ModelRouter(
      {
        defaultProvider: "toolful",
        defaultModel: "m",
        roleOverrides: {},
        fallbackChain: [],
        timeoutMs: 5_000,
        toolRounds: 2,
      },
      [adapter],
    );
    const executeTool = vi.fn(async () => "ctx");
    const result = await router.complete({
      ...researchReq(tools, executeTool),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });

    // 2 rounds inside the loop + the cap-forced tool-free call + the graceful
    // plain retry from complete() — never an unbounded tool ping-pong.
    expect(rounds).toHaveLength(4);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(rounds[2]?.tools).toBeUndefined(); // in-loop cap strip
    expect(rounds[3]?.tools).toBeUndefined(); // plain retry
    expect(result.toolsDegraded).toBe(true);
    expect(result.value).toMatchObject({ brief: "Paris" });
  });

  it("aggregates usage across tool rounds", async () => {
    const { adapter } = scriptedAdapter("toolful", [
      {
        text: "",
        toolCalls: [{ id: "c1", name: "search_articles", arguments: {} }],
        usage: { prompt: 10, completion: 2, total: 12 },
      },
      { text: '{"brief":"Paris","highlights":[]}', usage: { prompt: 20, completion: 5, total: 25 } },
    ]);
    const router = new ModelRouter(
      { defaultProvider: "toolful", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [adapter],
    );
    const result = await router.complete({
      ...researchReq(tools, async () => "ctx"),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });
    expect(result.usage).toEqual({ prompt: 30, completion: 7, total: 37 });
  });

  it("rejects tools without an executeTool handler (programming error)", async () => {
    const router = new ModelRouter(
      { defaultProvider: "mock", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [mockAdapter],
    );
    await expect(router.complete({ role: "research", messages: [], tools })).rejects.toMatchObject({
      data: { code: "INVALID_PARAMS" },
    });
  });

  it("degrades to a plain request when no chain candidate supports tools", async () => {
    const { adapter, rounds } = scriptedAdapter("plain", [{ text: '{"brief":"Paris","highlights":[]}' }], {
      tools: false,
    });
    const router = new ModelRouter(
      { defaultProvider: "plain", defaultModel: "m", roleOverrides: {}, fallbackChain: [], timeoutMs: 5_000 },
      [adapter],
    );
    const executeTool = vi.fn(async () => "unused");
    const result = await router.complete({
      ...researchReq(tools, executeTool),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });
    expect(result.toolsDegraded).toBe(true);
    expect(result.value).toMatchObject({ brief: "Paris" });
    expect(executeTool).not.toHaveBeenCalled();
    expect(rounds[0]?.tools).toBeUndefined();
    expect(rounds[0]?.executeTool).toBeUndefined();
  });

  it("retries once without tools when a capable backend fails, keeping the error as the last resort", async () => {
    const failing: ModelAdapter = {
      name: "toolful",
      supports: () => true,
      complete: async () => {
        throw new Error("backend down");
      },
    };
    const { adapter: plain, rounds } = scriptedAdapter(
      "plain",
      [{ text: '{"brief":"Paris","highlights":[]}' }],
      { tools: false },
    );
    const router = new ModelRouter(
      {
        defaultProvider: "toolful",
        defaultModel: "m",
        roleOverrides: {},
        fallbackChain: ["plain"],
        timeoutMs: 5_000,
      },
      [failing, plain],
    );
    const result = await router.complete({
      ...researchReq(tools, async () => "x"),
      jsonSchema: { name: "research", schema: researchResultSchema },
    });
    // capable backend failed with tools → plain retry succeeded → degraded flag
    expect(result.provider).toBe("plain");
    expect(result.toolsDegraded).toBe(true);
    expect(rounds[0]?.tools).toBeUndefined();
  });
});

describe("model deadline budget (§6.1)", () => {
  it("splits what is left of the deadline into fair per-candidate slices", () => {
    expect(candidateBudgetMs(10_000, 3, 60_000)).toBe(3_334);
    expect(candidateBudgetMs(600, 2, 60_000)).toBe(300);
    expect(candidateBudgetMs(1_000, 1, 60_000)).toBe(1_000);
    // the per-call cap still applies to a generous remainder
    expect(candidateBudgetMs(5_000, 1, 1_000)).toBe(1_000);
    // below the 250ms floor the budget counts as exhausted
    expect(candidateBudgetMs(200, 1, 60_000)).toBeUndefined();
    expect(candidateBudgetMs(500, 4, 60_000)).toBeUndefined();
  });

  it("a hanging first candidate is cut at its slice and cannot starve the chain", async () => {
    const env: ModelEnvConfig = {
      defaultProvider: "slow",
      defaultModel: "slow-model",
      roleOverrides: {},
      fallbackChain: ["mock"],
      timeoutMs: 60_000,
    };
    const seen: { timeoutMs?: number; aborted: boolean }[] = [];
    const slowAdapter: ModelAdapter = {
      name: "slow",
      supports: () => true,
      complete: (req, cfg) => {
        const record = { timeoutMs: cfg.timeoutMs, aborted: false };
        seen.push(record);
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("slow candidate ignored its slice")), 2_500);
          req.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            record.aborted = true;
            reject(new Error("slice expired"));
          });
        });
      },
    };
    const router = new ModelRouter(env, [slowAdapter, mockAdapter]);

    const startedAt = Date.now();
    const result = await router.complete({
      role: "research",
      messages: [{ role: "user", content: "research Paris" }],
      deadlineMs: 600,
    });

    expect(result.provider).toBe("mock");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.timeoutMs).toBeGreaterThanOrEqual(250);
    expect(seen[0]!.timeoutMs).toBeLessThanOrEqual(300);
    expect(seen[0]!.aborted).toBe(true);
  }, 10_000);

  it("refuses to start a candidate once the budget is exhausted", async () => {
    let calls = 0;
    const env: ModelEnvConfig = {
      defaultProvider: "never",
      defaultModel: "never-model",
      roleOverrides: {},
      fallbackChain: ["mock"],
      timeoutMs: 60_000,
    };
    const neverAdapter: ModelAdapter = {
      name: "never",
      supports: () => true,
      complete: async () => {
        calls += 1;
        return { text: "{}", provider: "never", model: "never-model" };
      },
    };
    const router = new ModelRouter(env, [neverAdapter, mockAdapter]);

    const err = await router
      .complete({
        role: "research",
        messages: [{ role: "user", content: "research Paris" }],
        deadlineMs: 100,
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ appCode: "MODEL_UNAVAILABLE", retryable: true });
    expect(String((err as Error).message)).toContain("budget exhausted");
    expect(calls).toBe(0);
  });
});

describe("openai-compatible adapter (tools + structured output)", () => {
  const cfg = { provider: "groq", model: "m", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" };
  const tools: ToolDefinition[] = [
    { name: "search_articles", description: "search", parameters: { type: "object", properties: { query: { type: "string" } } } },
  ];
  const jsonSchema = { name: "research", schema: researchResultSchema };

  const stubFetch = () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "search_articles", arguments: '{"query":"Paris"}' } }] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("omits response_format when tools are present (Groq rejects the combination)", async () => {
    const fetchMock = stubFetch();
    try {
      await groqAdapter.complete(
        { role: "research", messages: [{ role: "user", content: "hi" }], jsonSchema, tools, executeTool: async () => "x" },
        cfg,
      );
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body));
      expect(body.response_format).toBeUndefined();
      expect(body.tools).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still forces JSON on tool-free rounds", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"brief":"Paris","highlights":[]}' } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await groqAdapter.complete(
        { role: "research", messages: [{ role: "user", content: "hi" }], jsonSchema },
        cfg,
      );
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body));
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.tools).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("groq provider", () => {
  it("configures the Groq endpoint from GROQ_* env", () => {
    const cfg = providerConfig("groq", "openai/gpt-oss-20b", {
      GROQ_API_KEY: "gsk_test",
    });
    expect(cfg).toMatchObject({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "gsk_test",
    });
  });

  it("calls the OpenAI-compatible endpoint with the key and parses usage", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await groqAdapter.complete(
        { role: "synthesis", messages: [{ role: "user", content: "hi" }] },
        {
          provider: "groq",
          model: "openai/gpt-oss-20b",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: "gsk_x",
        },
      );
      const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
      expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer gsk_x");
      expect(JSON.parse(String(init.body)).model).toBe("openai/gpt-oss-20b");
      expect(res).toMatchObject({
        provider: "groq",
        model: "openai/gpt-oss-20b",
        usage: { prompt: 3, completion: 4, total: 7 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applies a per-plan override first and falls back to models each provider can serve", async () => {
    const env = readModelEnv({
      MODEL_PROVIDER: "ollama",
      MODEL_MODEL: "qwen3:8b",
      MODEL_FALLBACK_CHAIN: "ollama,mock",
    });
    const calls: { url: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      throw new Error("backend down");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const router = new ModelRouter(env);
      const override = { provider: "groq", model: "openai/gpt-oss-20b" };
      expect(router.describe("synthesis", override)).toEqual(override);

      const result = await router.complete({
        role: "synthesis",
        messages: [{ role: "user", content: "hi" }],
        override,
      });
      expect(result.provider).toBe("mock");
      expect(calls[0]?.url).toContain("api.groq.com/openai/v1/chat/completions");
      expect(calls[1]?.url).toContain("11434/api/chat");
      // the ollama fallback serves its own model, not the Groq id
      expect(calls[1]?.body).toMatchObject({ model: "qwen3:8b" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mock keeps its identity unless a plan explicitly chooses a model", async () => {
    const env: ModelEnvConfig = {
      defaultProvider: "mock",
      defaultModel: "whatever",
      roleOverrides: {},
      fallbackChain: [],
      timeoutMs: 1_000,
    };
    const router = new ModelRouter(env);
    const plain = await router.complete({
      role: "intent",
      messages: [{ role: "user", content: "Plan 3 days in Rome" }],
    });
    expect(plain).toMatchObject({ provider: "mock", model: "mock" });

    const override = { provider: "mock", model: "chosen-x" };
    const chosen = await router.complete({
      role: "intent",
      messages: [{ role: "user", content: "Plan 3 days in Rome" }],
      override,
    });
    expect(chosen).toMatchObject({ provider: "mock", model: "chosen-x" });
    expect(router.describe("intent", override)).toEqual(override);
  });
});

describe("model catalog", () => {
  const env = (over: Partial<ModelEnvConfig> = {}): ModelEnvConfig => ({
    defaultProvider: "ollama",
    defaultModel: "qwen3:8b",
    roleOverrides: {},
    fallbackChain: ["ollama", "mock"],
    timeoutMs: 1_000,
    ...over,
  });

  it("lists live Groq and Ollama models with configured defaults first", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("api.groq.com")) {
        return Response.json({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "openai/gpt-oss-20b" }] });
      }
      if (u.endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "llama3.1:8b" }, { name: "qwen3:8b" }] });
      }
      throw new Error(`unexpected probe: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const cat = await modelCatalog(
        env({ groqModel: "openai/gpt-oss-20b" }),
        { GROQ_API_KEY: "gsk_x", OLLAMA_BASE_URL: "http://localhost:11434" } as NodeJS.ProcessEnv,
      );
      const groq = cat.groups.find((g) => g.provider === "groq");
      expect(groq?.models[0]).toBe("openai/gpt-oss-20b");
      expect(groq?.models).toContain("llama-3.3-70b-versatile");
      const ollama = cat.groups.find((g) => g.provider === "ollama");
      expect(ollama?.models[0]).toBe("qwen3:8b");
      expect(ollama?.models).toContain("llama3.1:8b");
      expect(cat.groups.find((g) => g.provider === "mock")?.models).toEqual(["mock"]);
      expect(cat.configured).toEqual({ provider: "ollama", model: "qwen3:8b" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("degrades to configured defaults when the probes fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    try {
      const cat = await modelCatalog(
        env(),
        { GROQ_API_KEY: "gsk_x", GROQ_MODEL: "openai/gpt-oss-20b" } as NodeJS.ProcessEnv,
      );
      expect(cat.groups.find((g) => g.provider === "groq")?.models).toEqual(["openai/gpt-oss-20b"]);
      expect(cat.groups.find((g) => g.provider === "ollama")?.models).toEqual(["qwen3:8b"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits cloud groups without an API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    try {
      const cat = await modelCatalog(env(), {} as NodeJS.ProcessEnv);
      // no GROQ_API_KEY → no groq group; offline ollama degrades to the configured default
      expect(cat.groups.map((g) => g.provider)).toEqual(["ollama", "mock"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("model run tracking", () => {
  it("parses plans with modelRuns and accepts the model.usage event type", () => {
    const now = new Date().toISOString();
    const plan = planStateSchema.parse({
      planId: "p-model",
      status: "running",
      input: planInputSchema.parse({ query: "3 days in Rome" }),
      modelRuns: [
        {
          stage: "intent",
          provider: "ollama",
          model: "qwen3:8b",
          status: "done",
          usage: { prompt: 120, completion: 40, total: 160 },
          ts: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    expect(plan.modelRuns[0]?.usage?.total).toBe(160);
    expect(planEventTypeSchema.options).toContain("model.usage");
    const run = modelRunSchema.parse({
      stage: "synthesis",
      provider: "mock",
      model: "mock",
      status: "running",
      ts: now,
    });
    expect(run.estimated).toBe(false);
  });

  it("accepts a per-plan runtime model choice in plan input", () => {
    const input = planInputSchema.parse({
      query: "3 days in Rome",
      model: { provider: "groq", model: "openai/gpt-oss-20b" },
    });
    expect(input.model).toEqual({ provider: "groq", model: "openai/gpt-oss-20b" });
    expect(planInputSchema.parse({ query: "3 days in Rome" }).model).toBeUndefined();
    expect(
      planInputSchema.safeParse({ query: "x", model: { provider: "", model: "m" } }).success,
    ).toBe(false);
  });
});

describe("trip length (§17.1 day grid / §17.4 budget)", () => {
  const ctx = (startDate: string, endDate: string) => ({
    destination: "Paris",
    startDate,
    endDate,
    travelers: 1,
    interests: [],
  });

  it("prefers the parsed dates over the original request and the query text", () => {
    expect(
      durationDays(
        { query: "7 days in Paris", startDate: "2026-10-05", endDate: "2026-10-13" },
        ctx("2026-10-05", "2026-10-09"),
      ),
    ).toBe(5);
  });

  it("falls back to the original input dates, then to a duration stated in the query", () => {
    expect(durationDays({ query: "7 days in Paris", startDate: "2026-10-05", endDate: "2026-10-09" })).toBe(5);
    expect(durationDays({ query: "7 days in Paris" })).toBe(7);
    expect(durationDays({ query: "five days in Paris" })).toBe(5);
    expect(durationDays({ query: "a long weekend in Paris" })).toBe(3);
  });

  it("reports where the number came from so callers can warn on the default", () => {
    expect(resolveDuration({ query: "5 days in Paris" })).toEqual({ days: 5, source: "query" });
    expect(resolveDuration({ query: "x" }, ctx("2026-10-05", "2026-10-07"))).toEqual({
      days: 3,
      source: "parsed-dates",
    });
    expect(resolveDuration({ query: "a trip to Paris" })).toEqual({ days: 3, source: "default" });
  });

  it("ignores impossible date ranges and out-of-range durations", () => {
    expect(durationFromDates("2026-10-09", "2026-10-05")).toBeUndefined();
    expect(durationFromDates(undefined, "2026-10-09")).toBeUndefined();
    expect(durationFromQuery("99 days in Paris")).toBeUndefined();
    expect(durationFromQuery("no numbers here")).toBeUndefined();
  });
});

describe("HR input contract (§17.5)", () => {
  it("keeps the HR fields optional so plans that never connect are unchanged", () => {
    const plain = planInputSchema.parse({ query: "5 days in Paris" });
    expect(plain.requestHrValidation).toBeUndefined();
    expect(plain.employeeId).toBeUndefined();
    expect(plain.employeeName).toBeUndefined();
  });

  it("requires an employee id once the HR portal is connected", () => {
    const missing = planInputSchema.safeParse({
      query: "5 days in Paris",
      requestHrValidation: true,
    });
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain("employeeId");

    const ok = planInputSchema.parse({
      query: "5 days in Paris",
      requestHrValidation: true,
      employeeId: "E0001",
      employeeName: "Ada Lovelace",
    });
    expect(ok.employeeId).toBe("E0001");
  });

  it("accepts the canonical employee id in any case and rejects look-alikes", () => {
    expect(planInputSchema.safeParse({ query: "x", employeeId: "E0001" }).success).toBe(true);
    expect(planInputSchema.safeParse({ query: "x", employeeId: "e0001" }).success).toBe(true);
    expect(planInputSchema.safeParse({ query: "x", employeeId: "E1" }).success).toBe(false);
    expect(planInputSchema.safeParse({ query: "x", employeeId: "EMP0001" }).success).toBe(false);
    expect(planInputSchema.safeParse({ query: "x", employeeId: "0001" }).success).toBe(false);
    expect(planInputSchema.safeParse({ query: "x", employeeName: "  " }).success).toBe(false);
  });

  it("round-trips an HR section through its schema", () => {
    const section = hrSectionSchema.parse({
      employeeId: "E0001",
      employeeName: "Ada Lovelace",
      department: "Engineering",
      entitlementDays: 25,
      usedDays: 5,
      remainingDays: 20,
      tripDays: 5,
      balanceAfter: 15,
      compliant: true,
      verdict: "compliant",
      disclaimers: ["Advisory only — no leave is requested or booked."],
    });
    expect(hrSectionSchema.parse(section)).toEqual(section);
    expect(section.balanceAfter).toBe(section.remainingDays - section.tripDays);
    expect(hrSectionSchema.safeParse({ ...section, verdict: "unsure" }).success).toBe(false);
    expect(hrSectionSchema.safeParse({ ...section, compliant: "yes" }).success).toBe(false);
  });

  it("treats the HR registry flags as optional extensions of every other agent", () => {
    const registry = loadRegistry("./config/agents.json");
    const hr = registry.agents.find((a) => a.name === "hr");
    expect(hr).toBeDefined();
    expect(hr!.requiresField).toBe("requestHrValidation");
    expect(hr!.warnOnFailure).toBe(true);
    expect(hr!.enabled).toBe(true);
    expect(hr!.sections).toEqual(["hr"]);

    for (const agent of registry.agents.filter((a) => a.name !== "hr")) {
      expect(agent.requiresField).toBeUndefined();
      expect(agent.warnOnFailure).toBe(false);
    }
  });
});

describe("plan input date contract (§13)", () => {
  it("accepts a normal range", () => {
    expect(
      planInputSchema.safeParse({
        query: "5 days in Paris",
        startDate: "2026-12-05",
        endDate: "2026-12-09",
      }).success,
    ).toBe(true);
  });

  it("rejects an end date before the start date", () => {
    const bad = planInputSchema.safeParse({
      query: "5 days in Paris",
      startDate: "2026-12-10",
      endDate: "2026-12-01",
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("endDate must not be before startDate");
  });

  it("rejects a trip longer than the day grid can build", () => {
    const bad = planInputSchema.safeParse({
      query: "long trip",
      startDate: "2026-12-01",
      endDate: "2027-01-20",
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("may not exceed");
  });

  it("accepts dates on only one side and leaves them to the duration fallback", () => {
    expect(
      planInputSchema.safeParse({ query: "x", startDate: "2026-12-01" }).success,
    ).toBe(true);
    expect(
      planInputSchema.safeParse({ query: "x", endDate: "2026-12-05" }).success,
    ).toBe(true);
  });
});

describe("prompt parsing markers", () => {
  function count(text: string, marker: string): number {
    return text.split(marker).length - 1;
  }

  it("keeps every marker unique in the intent request (the mock slices on them)", () => {
    const text = buildIntentRequest({ query: "5 days in Paris", travelerCount: 1 }).messages
      .map((m) => m.content)
      .join("\n");
    for (const marker of ["TRAVEL_REQUEST:", "START_DATE:", "END_DATE:", "TRAVELERS:", "PREFERENCES:"]) {
      expect(count(text, marker), marker).toBe(1);
    }
  });

  it("keeps every marker unique in the synthesis request", () => {
    const text = buildSynthesisRequest(
      { destination: "Paris", travelers: 1, interests: [] },
      5,
      {},
    )
      .messages.map((m) => m.content)
      .join("\n");
    for (const marker of ["SHARED_CONTEXT:", "DURATION_DAYS:", "SECTION_DATA:"]) {
      expect(count(text, marker), marker).toBe(1);
    }
  });
});

describe("agent server health (§9)", () => {
  const card = createAgentCard({
    name: "probe",
    description: "health probe",
    baseUrl: "http://localhost:0",
    skills: [{ id: "probe", name: "Probe", description: "probe", tags: [], examples: [] }],
  });

  it("defaults to ok", async () => {
    const app = await createAgentServer({ card, handlers: {}, logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
    await app.close();
  });

  it("reports degraded when the agent supplies a health hook", async () => {
    const app = await createAgentServer({
      card,
      handlers: {},
      logger: false,
      health: () => ({ status: "degraded" }),
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "degraded", version: card.version });
    await app.close();
  });
});
