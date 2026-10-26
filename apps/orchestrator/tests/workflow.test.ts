import type { FastifyInstance } from "fastify";
import {
  createAgentCard,
  createAgentServer,
  type Itinerary,
  type PlanState,
} from "@travel/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildOrchestratorServer } from "../src/server";

/** Dispatch params captured per section, so tests can assert what the orchestrator forwards. */
const capturedParams: Record<string, Record<string, unknown>[]> = {};

function stubSectionAgent(name: string, section: string, data: Record<string, unknown>) {
  capturedParams[section] ??= [];
  return createAgentServer({
    logger: false,
    card: createAgentCard({
      name,
      description: `stub ${section} agent`,
      baseUrl: "http://localhost:0",
      skills: [{ id: section, name: section, description: section, tags: [section], examples: [] }],
    }),
    handlers: {
      "message/send": async (raw) => {
        const params = raw as { section?: string };
        capturedParams[section]!.push(raw as Record<string, unknown>);
        return {
          sectionResult: { key: params.section ?? section, status: "completed", data },
        };
      },
    },
  });
}

async function addressOf(app: FastifyInstance): Promise<string> {
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("server not listening");
  return `http://127.0.0.1:${addr.port}`;
}

async function pollPlan(
  base: string,
  taskId: string,
  until: (p: PlanState) => boolean,
  timeoutMs = 8_000,
): Promise<PlanState> {
  const deadline = Date.now() + timeoutMs;
  let last: PlanState | null = null;
  while (Date.now() < deadline) {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "poll",
        method: "orchestrator/plan:get",
        params: { taskId },
      }),
    });
    const body = (await res.json()) as { result?: { plan: PlanState } };
    if (body.result?.plan) {
      last = body.result.plan;
      if (until(last)) return last;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`plan did not reach expected state; last=${JSON.stringify(last?.status)}`);
}

describe("orchestrator workflow (registry dispatch + synthesis)", () => {
  let destinationApp: FastifyInstance;
  let weatherApp: FastifyInstance;
  let budgetApp: FastifyInstance;
  let hrApp: FastifyInstance;
  let orchApp: FastifyInstance;
  let orchUrl: string;

  beforeAll(async () => {
    vi.stubEnv("MODEL_PROVIDER", "mock");
    vi.stubEnv("MODEL_FALLBACK_CHAIN", "");
    vi.stubEnv("PLAN_STORE", "memory");

    destinationApp = await stubSectionAgent("destination-research", "destination", {
      coverage: "grounded",
      brief: "Paris is the capital of France, famous for the Eiffel Tower and the Louvre.",
      highlights: ["Eiffel Tower", "Louvre Museum", "Seine riverbanks"],
      sources: [
        {
          title: "Paris",
          url: "https://en.wikipedia.org/wiki/Paris",
          retrievedAt: new Date().toISOString(),
        },
      ],
      warnings: [],
    });
    weatherApp = await stubSectionAgent("weather", "weather", {
      location: "Paris",
      coverage: "forecast",
      asOf: new Date().toISOString(),
      days: [
        { date: "2026-10-05", minC: 10, maxC: 18, condition: "Cloudy" },
        { date: "2026-10-06", minC: 11, maxC: 19, condition: "Sunny" },
      ],
      disclaimers: [],
    });
    budgetApp = await stubSectionAgent("budget", "budget", {
      location: "paris",
      matched: true,
      days: 5,
      nights: 4,
      travelers: 2,
      currency: "EUR",
      fx: 0.92,
      rates: { hotel: 150, food: 60, transport: 20, activities: 40 },
      usd: { hotel: 1200, food: 600, transport: 200, activities: 400, total: 2400 },
      local: { hotel: 1104, food: 552, transport: 184, activities: 368, total: 2208 },
      disclaimers: [],
    });
    hrApp = await stubSectionAgent("hr", "hr", {
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
    await destinationApp.listen({ port: 0, host: "127.0.0.1" });
    await weatherApp.listen({ port: 0, host: "127.0.0.1" });
    await budgetApp.listen({ port: 0, host: "127.0.0.1" });
    await hrApp.listen({ port: 0, host: "127.0.0.1" });

    vi.stubEnv("AGENT_DESTINATION_RESEARCH_BASE_URL", await addressOf(destinationApp));
    vi.stubEnv("AGENT_WEATHER_BASE_URL", await addressOf(weatherApp));
    vi.stubEnv("AGENT_BUDGET_BASE_URL", await addressOf(budgetApp));
    vi.stubEnv("AGENT_HR_BASE_URL", await addressOf(hrApp));

    orchApp = await buildOrchestratorServer({ logger: false });
    await orchApp.listen({ port: 0, host: "127.0.0.1" });
    orchUrl = await addressOf(orchApp);
  }, 20_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.allSettled([
      orchApp?.close(),
      destinationApp?.close(),
      weatherApp?.close(),
      budgetApp?.close(),
      hrApp?.close(),
    ]);
  });

  it("composes a 5-day itinerary from registry agents", async () => {
    const createRes = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "c1",
        method: "message/send",
        params: {
          input: {
            query: "Plan five days in Paris from 2026-10-05 to 2026-10-09",
            travelerCount: 2,
          },
        },
      }),
    });
    const created = (await createRes.json()) as { result: { taskId: string; status: string } };
    expect(created.result.status).toBe("created");

    const plan = await pollPlan(orchUrl, created.result.taskId, (p) =>
      ["completed", "failed", "cancelled"].includes(p.status),
    );
    expect(plan.status).toBe("completed");
    expect(plan.sharedContext?.destination).toBe("Paris");

    const dest = plan.sections.destination as { status: string; data: { coverage: string } };
    const weather = plan.sections.weather as { status: string; data: { location: string } };
    const synthesis = plan.sections.synthesis as { status: string; data: Itinerary };
    expect(dest.status).toBe("completed");
    expect(weather.data.location).toBe("Paris");
    expect(synthesis.status).toBe("completed");
    expect(synthesis.data.days).toHaveLength(5);
    expect(synthesis.data.days[0]?.date).toBe("2026-10-05");
    expect(synthesis.data.summary).toContain("Paris");
    expect(synthesis.data.sources[0]?.url).toContain("wikipedia.org");

    const budget = plan.sections.budget as {
      status: string;
      data: { days: number; nights: number; usd: { total: number } };
    };
    expect(budget.status).toBe("completed");
    expect(budget.data.days).toBe(5);
    expect(budget.data.nights).toBe(4);
    expect(budget.data.usd.total).toBe(2400);

    // the original request rides along with the parsed context (§17.4)
    const budgetParams = capturedParams.budget?.at(-1);
    expect(budgetParams?.input).toMatchObject({ query: expect.stringContaining("Paris") });
    expect(budgetParams?.sharedContext).toMatchObject({ destination: "Paris", travelers: 2 });

    const stages = plan.modelRuns.map((r) => r.stage);
    expect(stages).toContain("intent");
    expect(stages).toContain("synthesis");
    const intentRun = plan.modelRuns.find((r) => r.stage === "intent");
    expect(intentRun?.status).toBe("done");
    expect(intentRun?.usage?.total).toBeGreaterThan(0);
  });

  it("forwards each section's registry timeout as its deadline budget", async () => {
    const createRes = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "c4",
        method: "message/send",
        params: { input: { query: "Two days in Lisbon from 2026-11-01 to 2026-11-02" } },
      }),
    });
    const { result } = (await createRes.json()) as { result: { taskId: string } };
    await pollPlan(orchUrl, result.taskId, (p) =>
      ["completed", "failed", "cancelled"].includes(p.status),
    );

    const dest = capturedParams.destination ?? [];
    const weather = capturedParams.weather ?? [];
    const budget = capturedParams.budget ?? [];
    expect(dest.length).toBeGreaterThan(0);
    expect(weather.length).toBeGreaterThan(0);
    expect(budget.length).toBeGreaterThan(0);
    // config/agents.json: destination 25s, weather 10s, budget 10s — agents must answer within them
    expect(dest.at(-1)?.deadlineMs).toBe(25_000);
    expect(weather.at(-1)?.deadlineMs).toBe(10_000);
    expect(budget.at(-1)?.deadlineMs).toBe(10_000);
  });

  it("dispatches the HR section only when the plan opted in (§17.5)", async () => {
    const before = capturedParams.hr?.length ?? 0;
    const createRes = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "hr-on",
        method: "message/send",
        params: {
          input: {
            query: "Five days in Paris from 2026-10-05 to 2026-10-09",
            travelerCount: 2,
            requestHrValidation: true,
            employeeId: "E0001",
            employeeName: "Ada Lovelace",
          },
        },
      }),
    });
    const { result } = (await createRes.json()) as { result: { taskId: string } };
    const plan = await pollPlan(orchUrl, result.taskId, (p) =>
      ["completed", "failed", "cancelled"].includes(p.status),
    );

    expect(plan.status).toBe("completed");
    const hr = plan.sections.hr as { status: string; data: { employeeId: string; verdict: string } };
    expect(hr.status).toBe("completed");
    expect(hr.data).toMatchObject({ employeeId: "E0001", verdict: "compliant" });

    // the HR call is a normal section dispatch: shared context + the original input
    expect(capturedParams.hr!.length).toBeGreaterThan(before);
    const hrParams = capturedParams.hr!.at(-1)!;
    expect(hrParams.sharedContext).toMatchObject({ destination: "Paris", travelers: 2 });
    expect(hrParams.input).toMatchObject({
      requestHrValidation: true,
      employeeId: "E0001",
      query: expect.stringContaining("Paris"),
    });
    expect(hrParams.deadlineMs).toBe(10_000);

    // and the verdict reaches the itinerary summary
    const synthesis = plan.sections.synthesis as { status: string; data: Itinerary };
    expect(synthesis.status).toBe("completed");
    expect(synthesis.data.summary).toContain("Leave status for Ada Lovelace");
    expect(synthesis.data.assumptions).toContain(
      "Leave status is an HR advisory against the stored balance; no leave is booked.",
    );
  });

  it("never calls HR for a plan that did not connect the portal", async () => {
    const before = capturedParams.hr?.length ?? 0;
    const createRes = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "hr-off",
        method: "message/send",
        params: { input: { query: "Two days in Seville from 2026-11-01 to 2026-11-02" } },
      }),
    });
    const { result } = (await createRes.json()) as { result: { taskId: string } };
    const plan = await pollPlan(orchUrl, result.taskId, (p) =>
      ["completed", "failed", "cancelled"].includes(p.status),
    );

    expect(plan.status).toBe("completed");
    expect(plan.sections.hr).toBeUndefined();
    expect(plan.input.requestHrValidation).toBeUndefined();
    expect(capturedParams.hr?.length ?? 0).toBe(before);

    const synthesis = plan.sections.synthesis as { data: Itinerary };
    expect(synthesis.data.summary).not.toContain("Leave status");
  });

  it("keeps the plan alive when HR fails and states the reason in the summary", async () => {
    vi.stubEnv("AGENT_HR_BASE_URL", "http://127.0.0.1:9");
    let isolated: FastifyInstance | undefined;
    try {
      isolated = await buildOrchestratorServer({ logger: false });
      await isolated.listen({ port: 0, host: "127.0.0.1" });
      const url = await addressOf(isolated);

      const createRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "hr-dead",
          method: "message/send",
          params: {
            input: {
              query: "Four days in Lisbon from 2026-11-01 to 2026-11-04",
              requestHrValidation: true,
              employeeId: "E0002",
            },
          },
        }),
      });
      const { result } = (await createRes.json()) as { result: { taskId: string } };
      const plan = await pollPlan(url, result.taskId, (p) =>
        ["completed", "failed", "cancelled"].includes(p.status),
      );

      // warnOnFailure: the section fails, the plan does not
      expect(plan.status).toBe("completed");
      expect((plan.sections.destination as { status: string }).status).toBe("completed");
      expect((plan.sections.synthesis as { status: string }).status).toBe("completed");

      const hr = plan.sections.hr as { status: string; error?: { code: string } };
      expect(hr.status).toBe("failed");
      expect(hr.error?.code).toBe("AGENT_UNREACHABLE");

      const reason = plan.errors.find((e) => e.message.includes('Section "hr" unavailable'));
      expect(reason).toBeDefined();
      expect(reason?.section).toBe("hr");

      const synthesis = plan.sections.synthesis as { data: Itinerary };
      expect(synthesis.data.warnings).toContain(reason!.message);
      expect(synthesis.data.summary).toContain("Leave status check unavailable");
    } finally {
      await isolated?.close();
      vi.stubEnv("AGENT_HR_BASE_URL", await addressOf(hrApp));
    }
  });

  it("completes the plan when an optional section's agent is unreachable", async () => {
    // Point only the budget entry at a dead port and build a fresh orchestrator, so
    // the shared one above keeps its healthy stubs.
    vi.stubEnv("AGENT_BUDGET_BASE_URL", "http://127.0.0.1:9");
    let isolated: FastifyInstance | undefined;
    try {
      isolated = await buildOrchestratorServer({ logger: false });
      await isolated.listen({ port: 0, host: "127.0.0.1" });
      const url = await addressOf(isolated);

      const createRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "unreachable",
          method: "message/send",
          params: {
            input: { query: "Four days in Lisbon from 2026-11-01 to 2026-11-04" },
          },
        }),
      });
      const { result } = (await createRes.json()) as { result: { taskId: string } };
      const plan = await pollPlan(url, result.taskId, (p) =>
        ["completed", "failed", "cancelled"].includes(p.status),
      );

      // budget is `required: false` — everything else still completes
      expect(plan.status).toBe("completed");
      expect((plan.sections.destination as { status: string }).status).toBe("completed");
      expect((plan.sections.weather as { status: string }).status).toBe("completed");
      expect((plan.sections.synthesis as { status: string }).status).toBe("completed");

      const budget = plan.sections.budget as { status: string; error?: { code: string } };
      expect(budget.status).toBe("failed");
      expect(budget.error?.code).toBe("AGENT_UNREACHABLE");
    } finally {
      await isolated?.close();
      vi.stubEnv("AGENT_BUDGET_BASE_URL", await addressOf(budgetApp));
    }
  });

  it("applies the per-plan model choice to every model stage", async () => {
    const createRes = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "c3",
        method: "message/send",
        params: {
          input: {
            query: "Three days in Osaka from 2026-12-01 to 2026-12-03",
            model: { provider: "mock", model: "chosen-x" },
          },
        },
      }),
    });
    const { result } = (await createRes.json()) as { result: { taskId: string } };
    const plan = await pollPlan(orchUrl, result.taskId, (p) =>
      ["completed", "failed", "cancelled"].includes(p.status),
    );
    expect(plan.status).toBe("completed");
    expect(plan.input.model).toEqual({ provider: "mock", model: "chosen-x" });
    expect(plan.modelRuns.map((r) => r.stage)).toEqual(expect.arrayContaining(["intent", "synthesis"]));
    expect(plan.modelRuns.every((r) => r.model === "chosen-x")).toBe(true);
  });

  it("streams replayed SSE events including plan.completed", async () => {
    const createRes = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "c2",
        method: "message/send",
        params: { input: { query: "Three days in Tokyo from 2026-11-12 to 2026-11-14" } },
      }),
    });
    const { result } = (await createRes.json()) as { result: { taskId: string } };
    await pollPlan(orchUrl, result.taskId, (p) => p.status === "completed");

    const controller = new AbortController();
    const res = await fetch(`${orchUrl}/plans/${result.taskId}/events?since=0`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: plan.completed")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    controller.abort();

    expect(text).toContain("event: plan.created");
    expect(text).toContain("event: intent.parsed");
    expect(text).toContain("event: section.completed");
    expect(text).toContain("event: model.usage");
    expect(text).toContain("event: plan.completed");
  });

  it("returns PLAN_NOT_FOUND for unknown plans", async () => {
    const res = await fetch(orchUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "x",
        method: "orchestrator/plan:get",
        params: { taskId: "does-not-exist" },
      }),
    });
    const body = (await res.json()) as { error?: { data?: { code?: string } } };
    expect(body.error?.data?.code).toBe("PLAN_NOT_FOUND");
  });
});
