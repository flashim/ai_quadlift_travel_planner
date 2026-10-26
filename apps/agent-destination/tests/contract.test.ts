import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelRouter,
  agentCardSchema,
  clearForecastCache,
  type ModelAdapter,
} from "@travel/shared";
import { buildDestinationServer } from "../src/agent";
import { knowledgeChain } from "../src/knowledge/registry";

const searchPayload = { query: { search: [{ title: "Paris", snippet: "capital of France" }] } };
const summaryPayload = {
  type: "standard",
  title: "Paris",
  extract:
    "Paris is the capital and largest city of France. " +
    "It is known for the Eiffel Tower, the Louvre, and its cuisine. " +
    "The city straddles the Seine and has been a major European centre for centuries.",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Paris" } },
};
const extractsPayload = {
  query: {
    pages: {
      "1234": {
        title: "Paris",
        extract:
          "Paris is the capital of France. The Louvre and the Eiffel Tower are its landmarks. " +
          "It is known worldwide for art, fashion, and cuisine.",
      },
    },
  },
};

/** Full two-source stub: Wikivoyage search + extracts, Wikipedia search + summary. */
function stubWikipediaFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("en.wikivoyage.org") && url.includes("prop=extracts")) {
        return new Response(JSON.stringify(extractsPayload), { status: 200 });
      }
      if (url.includes("action=query&list=search")) {
        return new Response(JSON.stringify(searchPayload), { status: 200 });
      }
      if (url.includes("/api/rest_v1/page/summary/")) {
        return new Response(JSON.stringify(summaryPayload), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

/** Only the model ever runs — every knowledge HTTP hop misses. */
function stubNoKnowledge(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ query: { search: [] } }), { status: 200 })),
  );
}

describe("destination agent contract", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_PROVIDER", "mock");
    vi.stubEnv("MODEL_FALLBACK_CHAIN", "");
    clearForecastCache();
    stubWikipediaFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearForecastCache();
  });

  async function server() {
    return buildDestinationServer({ logger: false });
  }

  it("publishes a valid agent card", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/.well-known/agent.json" });
    expect(res.statusCode).toBe(200);
    const card = agentCardSchema.parse(JSON.parse(res.body));
    expect(card.name).toBe("destination-research");
    expect(card.skills[0]?.tags).toContain("wikivoyage");
    expect(card.skills[0]?.tags).toContain("wikipedia");
    await app.close();
  });

  it("reports health", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(JSON.parse(res.body).status).toBe("ok");
    await app.close();
  });

  it("rejects params without a destination", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { sharedContext: { travelers: 1, interests: [] } },
      },
    });
    expect(JSON.parse(res.body).error.data.code).toBe("INVALID_PARAMS");
    await app.close();
  });

  it("returns a grounded research section with sources", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        params: {
          section: "destination",
          sharedContext: { destination: "Paris", travelers: 2, interests: ["food"] },
          model: { provider: "mock", model: "chosen-x" },
        },
      },
    });
    const body = JSON.parse(res.body);
    expect(body.error).toBeUndefined();
    const { sectionResult } = body.result;
    expect(sectionResult.status).toBe("completed");
    expect(sectionResult.data.coverage).toBe("grounded");
    expect(sectionResult.data.brief.length).toBeGreaterThan(20);
    // Wikivoyage is the primary source of the configured chain (§17.2)
    expect(sectionResult.data.sources[0]).toMatchObject({
      title: "Paris",
      url: "https://en.wikivoyage.org/wiki/Paris",
    });
    const runs = sectionResult.meta.modelRuns as {
      stage: string;
      provider: string;
      model: string;
      status: string;
      estimated: boolean;
      usage?: { total: number };
    }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      stage: "destination",
      provider: "mock",
      model: "chosen-x",
      status: "done",
      estimated: true,
    });
    expect(runs[0]?.usage?.total).toBeGreaterThan(0);
    await app.close();
  });

  it("answers within a tiny section deadline using the raw extract (no distillation)", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "message/send",
        params: {
          section: "destination",
          sharedContext: { destination: "Paris", travelers: 2, interests: [] },
          // 3s: plenty for the (stubbed) Wikipedia hops, never enough for
          // remaining - 1.5s >= 2s of distillation → raw-extract fallback.
          deadlineMs: 3_000,
        },
      },
    });
    const body = JSON.parse(res.body);
    expect(body.error).toBeUndefined();
    const { sectionResult } = body.result;
    expect(sectionResult.status).toBe("completed");
    expect(sectionResult.data.coverage).toBe("grounded");
    expect(sectionResult.data.brief).toContain("Paris is the capital");
    expect(sectionResult.data.sources[0]).toMatchObject({ title: "Paris" });
    expect(sectionResult.meta.modelRuns ?? []).toHaveLength(0);
    expect(sectionResult.data.warnings.join(" ")).toContain("raw reference extract");
    await app.close();
  });

  it("degrades to ungrounded when Wikipedia has no match", async () => {
    stubNoKnowledge();
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        params: {
          section: "destination",
          sharedContext: { destination: "Gotham City", travelers: 1, interests: [] },
        },
      },
    });
    const { sectionResult } = JSON.parse(res.body).result;
    expect(sectionResult.status).toBe("completed");
    expect(sectionResult.data.coverage).toBe("ungrounded");
    expect(sectionResult.data.sources).toHaveLength(0);
    expect(sectionResult.data.warnings.join(" ")).toContain("ungrounded");
    await app.close();
  });

  it("falls through to Wikipedia when Wikivoyage has no article", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("en.wikivoyage.org")) {
          return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
        }
        if (url.includes("action=query&list=search")) {
          return new Response(JSON.stringify(searchPayload), { status: 200 });
        }
        if (url.includes("/api/rest_v1/page/summary/")) {
          return new Response(JSON.stringify(summaryPayload), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 6,
        method: "message/send",
        params: {
          section: "destination",
          sharedContext: { destination: "Paris", travelers: 1, interests: [] },
        },
      },
    });
    const { sectionResult } = JSON.parse(res.body).result;
    expect(sectionResult.data.coverage).toBe("grounded");
    expect(sectionResult.data.sources[0]).toMatchObject({
      url: "https://en.wikipedia.org/wiki/Paris",
    });
    await app.close();
  });

  it("surfaces a warning when the model backend cannot use research tools", async () => {
    // json-schema only: the router degrades the tool request up front (§6.1)
    const plainAdapter: ModelAdapter = {
      name: "plain",
      supports: (cap) => cap === "json-schema",
      complete: async () => ({
        text: JSON.stringify({ brief: "Paris rewards a slow, food-led itinerary.", highlights: ["Louvre"] }),
        provider: "plain",
        model: "plain-model",
        usage: { prompt: 12, completion: 6, total: 18 },
      }),
    };
    const router = new ModelRouter(
      {
        defaultProvider: "plain",
        defaultModel: "plain-model",
        roleOverrides: {},
        fallbackChain: [],
        timeoutMs: 5_000,
      },
      [plainAdapter],
    );
    const app = await buildDestinationServer({ logger: false, router });
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "message/send",
        params: {
          section: "destination",
          sharedContext: { destination: "Paris", travelers: 1, interests: [] },
          model: { provider: "plain", model: "plain-model" },
        },
      },
    });
    const { sectionResult } = JSON.parse(res.body).result;
    expect(sectionResult.status).toBe("completed");
    expect(sectionResult.data.brief.length).toBeGreaterThan(10);
    expect(sectionResult.data.warnings.join(" ")).toContain("research tools");
    await app.close();
  });

  it("grounds the section via a model-requested fetch_extract tool", async () => {
    // Pre-fetch misses (no search hits) — only the tool can find the article.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("action=query&list=search")) {
          return new Response(JSON.stringify({ query: { search: [] } }), { status: 200 });
        }
        if (url.includes("/api/rest_v1/page/summary/")) {
          return new Response(JSON.stringify(summaryPayload), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    let round = 0;
    const toolfulAdapter: ModelAdapter = {
      name: "toolful",
      supports: () => true,
      complete: async () => {
        round += 1;
        if (round === 1) {
          return {
            text: "",
            toolCalls: [
              { id: "c1", name: "fetch_extract", arguments: { title: "Paris", source: "wikipedia" } },
            ],
            provider: "toolful",
            model: "toolful-model",
          };
        }
        return {
          text: JSON.stringify({
            brief: "Paris is the capital of France and a museum city.",
            highlights: ["The Louvre", "Eiffel Tower"],
          }),
          provider: "toolful",
          model: "toolful-model",
        };
      },
    };
    const router = new ModelRouter(
      {
        defaultProvider: "toolful",
        defaultModel: "toolful-model",
        roleOverrides: {},
        fallbackChain: [],
        timeoutMs: 5_000,
      },
      [toolfulAdapter],
    );
    const app = await buildDestinationServer({ logger: false, router });
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        jsonrpc: "2.0",
        id: 8,
        method: "message/send",
        params: {
          section: "destination",
          sharedContext: { destination: "Paris", travelers: 1, interests: [] },
          model: { provider: "toolful", model: "toolful-model" },
        },
      },
    });
    const { sectionResult } = JSON.parse(res.body).result;
    expect(sectionResult.status).toBe("completed");
    // the tool fetched the article → the section is grounded even though the
    // pre-fetch chain found nothing
    expect(sectionResult.data.coverage).toBe("grounded");
    expect(sectionResult.data.sources).toHaveLength(1);
    expect(sectionResult.data.sources[0].url).toBe("https://en.wikipedia.org/wiki/Paris");
    expect(sectionResult.data.brief).toContain("capital of France");
    await app.close();
  });
});

describe("knowledge source registry (§17.2)", () => {
  it("defaults to the wikivoyage → wikipedia order", () => {
    expect(knowledgeChain({} as NodeJS.ProcessEnv).map((p) => p.name)).toEqual([
      "wikivoyage",
      "wikipedia",
    ]);
  });

  it("honours KNOWLEDGE_PROVIDERS order and dedupes", () => {
    expect(
      knowledgeChain({
        KNOWLEDGE_PROVIDERS: "wikipedia, wikivoyage,wikipedia",
      } as NodeJS.ProcessEnv).map((p) => p.name),
    ).toEqual(["wikipedia", "wikivoyage"]);
  });

  it("fails fast on unknown source names", () => {
    expect(() =>
      knowledgeChain({ KNOWLEDGE_PROVIDERS: "wikivoyage,ddb" } as NodeJS.ProcessEnv),
    ).toThrow("Unknown KNOWLEDGE_PROVIDERS entries: ddb");
  });
});
