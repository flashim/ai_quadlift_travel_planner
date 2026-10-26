import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentCardSchema, budgetSectionSchema } from "@travel/shared";
import { buildBudgetServer } from "../src/agent";

type TestApp = Awaited<ReturnType<typeof buildBudgetServer>>;

const dirs: string[] = [];
const apps: TestApp[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "travel-budget-"));
  dirs.push(dir);
  return dir;
}

async function server(dbPath = ":memory:"): Promise<TestApp> {
  const app = await buildBudgetServer({ logger: false, dbPath });
  apps.push(app);
  return app;
}

async function send(app: TestApp, params: unknown) {
  const res = await app.inject({
    method: "POST",
    url: "/",
    payload: { jsonrpc: "2.0", id: 1, method: "message/send", params },
  });
  return JSON.parse(res.body) as {
    result?: { sectionResult: { key: string; status: string; data: unknown } };
    error?: { code: number; message: string; data: { code: string; retryable: boolean } };
  };
}

function parisParams(overrides: Record<string, unknown> = {}) {
  return {
    section: "budget",
    sharedContext: {
      destination: "Paris",
      startDate: "2026-10-05",
      endDate: "2026-10-09",
      travelers: 2,
      interests: [],
    },
    input: {
      query: "5 days in Paris from 2026-10-05 to 2026-10-09",
      travelerCount: 2,
    },
    ...overrides,
  };
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("budget agent contract", () => {
  it("publishes a valid agent card on both well-known paths", async () => {
    const app = await server();
    for (const url of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/a2a+json");
      const card = agentCardSchema.parse(JSON.parse(res.body));
      expect(card.name).toBe("budget");
      expect(card.skills[0]?.id).toBe("budget-estimate");
      expect(card.skills[0]?.tags).toContain("budget");
      expect(card.skills[0]?.tags).toContain("cost");
    }
  });

  it("reports health ok when the catalog is usable", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("starts and reports health degraded when the catalog cannot be opened", async () => {
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "not a directory");
    const app = await server(join(blocker, "costs.db"));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("degraded");

    const body = await send(app, parisParams());
    expect(body.error).toBeDefined();
    expect(body.error!.data.code).toBe("INTERNAL");
    expect(body.error!.data.retryable).toBe(false);
    expect(body.error!.message).toContain("cost catalog unavailable");
  });

  it("prices a dated trip from the matched profile", async () => {
    const app = await server();
    const body = await send(app, parisParams());
    expect(body.error).toBeUndefined();

    const { sectionResult } = body.result!;
    expect(sectionResult.key).toBe("budget");
    expect(sectionResult.status).toBe("completed");

    const data = budgetSectionSchema.parse(sectionResult.data);
    expect(data.location).toBe("paris");
    expect(data.matched).toBe(true);
    expect(data.days).toBe(5);
    expect(data.nights).toBe(4);
    expect(data.travelers).toBe(2);
    expect(data.currency).toBe("EUR");
    expect(data.fx).toBe(0.92);
    // hotel 150 × 4 nights × 2 travelers; the rest × 5 days × 2 travelers
    expect(data.usd).toEqual({ hotel: 1200, food: 600, transport: 200, activities: 400, total: 2400 });
    expect(data.local.total).toBe(2208);
    expect(data.disclaimers.join(" ")).toContain("catalog estimates");
    expect(data.disclaimers.join(" ")).not.toContain("No travel dates");
    expect(data.disclaimers.join(" ")).not.toContain("default profile");
  });

  it("derives the trip length from the original query when no dates were parsed", async () => {
    const app = await server();
    const body = await send(app, {
      section: "budget",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
      input: { query: "five days in Paris", travelerCount: 1 },
    });
    const data = budgetSectionSchema.parse(body.result!.sectionResult.data);
    expect(data.days).toBe(5);
    expect(data.nights).toBe(4);
    expect(data.disclaimers.join(" ")).not.toContain("No travel dates");
  });

  it("prices a default-length trip with an explicit disclaimer when nothing is known", async () => {
    const app = await server();
    const body = await send(app, {
      section: "budget",
      sharedContext: { destination: "Rome", travelers: 1, interests: [] },
    });
    const data = budgetSectionSchema.parse(body.result!.sectionResult.data);
    expect(data.days).toBe(3);
    expect(data.nights).toBe(2);
    expect(data.disclaimers.join(" ")).toContain("No travel dates or stated duration");
  });

  it("matches the containment rung and the default profile", async () => {
    const app = await server();

    const ny = await send(app, {
      section: "budget",
      sharedContext: { destination: "New York City", travelers: 1, interests: [] },
      input: { query: "3 days in New York City", travelerCount: 1 },
    });
    expect(budgetSectionSchema.parse(ny.result!.sectionResult.data)).toMatchObject({
      location: "new york",
      matched: true,
      days: 3,
    });

    const kyoto = await send(app, {
      section: "budget",
      sharedContext: { destination: "Kyoto, Japan", travelers: 1, interests: [] },
      input: { query: "4 days in Kyoto, Japan", travelerCount: 1 },
    });
    const fallback = budgetSectionSchema.parse(kyoto.result!.sectionResult.data);
    expect(fallback.matched).toBe(false);
    expect(fallback.location).toBe("default");
    expect(fallback.disclaimers.join(" ")).toContain('No cost profile for "Kyoto, Japan"');
    expect(fallback.days).toBe(4);
  });

  it("does not modify the catalog while answering", async () => {
    const path = join(tempDir(), "costs.db");
    const app = await server(path);
    await send(app, parisParams());
    const before = readFileSync(path);
    await send(app, parisParams());
    const after = readFileSync(path);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("rejects params without a destination", async () => {
    const app = await server();
    const body = await send(app, {
      section: "budget",
      sharedContext: { travelers: 1, interests: [] },
    });
    expect(body.error).toBeDefined();
    expect(body.error!.data.code).toBe("INVALID_PARAMS");
    expect(body.error!.data.retryable).toBe(false);
    expect(body.error!.message).toContain("sharedContext.destination");
  });

  it("rejects malformed params with INVALID_PARAMS", async () => {
    const app = await server();
    const body = await send(app, { sharedContext: "nope" });
    expect(body.error).toBeDefined();
    expect(body.error!.data.code).toBe("INVALID_PARAMS");
    expect(body.error!.data.retryable).toBe(false);
  });

  it("returns an unknown method error for unsupported RPC methods", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { jsonrpc: "2.0", id: 9, method: "does/not/exist", params: {} },
    });
    expect(JSON.parse(res.body).error.code).toBe(-32601);
  });
});
