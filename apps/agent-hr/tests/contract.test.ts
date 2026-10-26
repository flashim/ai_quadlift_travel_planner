import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentCardSchema, hrSectionSchema } from "@travel/shared";
import { buildHrServer } from "../src/agent";

type TestApp = Awaited<ReturnType<typeof buildHrServer>>;

const dirs: string[] = [];
const apps: TestApp[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "travel-hr-"));
  dirs.push(dir);
  return dir;
}

async function server(dbPath = ":memory:"): Promise<TestApp> {
  const app = await buildHrServer({ logger: false, dbPath });
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

function params(employeeId: string, overrides: Record<string, unknown> = {}) {
  return {
    section: "hr",
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
      requestHrValidation: true,
      employeeId,
    },
    ...overrides,
  };
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("hr agent contract", () => {
  it("publishes a valid agent card on both well-known paths", async () => {
    const app = await server();
    for (const url of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/a2a+json");
      const card = agentCardSchema.parse(JSON.parse(res.body));
      expect(card.name).toBe("hr");
      expect(card.skills[0]?.id).toBe("leave-status");
      expect(card.skills[0]?.tags).toContain("leave");
      expect(card.skills[0]?.tags).toContain("vacation");
    }
  });

  it("reports health ok when the employee database is usable", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("starts and reports health degraded when the database cannot be opened", async () => {
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "not a directory");
    const app = await server(join(blocker, "hr.db"));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("degraded");

    const body = await send(app, params("E0001"));
    expect(body.error).toBeDefined();
    expect(body.error!.data.code).toBe("INTERNAL");
    expect(body.error!.data.retryable).toBe(false);
    expect(body.error!.message).toContain("employee database unavailable");
  });

  it("reports a compliant status when the balance covers the trip", async () => {
    const app = await server();
    const body = await send(app, params("E0001"));
    expect(body.error).toBeUndefined();

    const { sectionResult } = body.result!;
    expect(sectionResult.key).toBe("hr");
    expect(sectionResult.status).toBe("completed");

    const data = hrSectionSchema.parse(sectionResult.data);
    expect(data.employeeId).toBe("E0001");
    expect(data.employeeName).toBe("Ada Lovelace");
    expect(data.department).toBe("Engineering");
    expect(data.entitlementDays).toBe(25);
    expect(data.usedDays).toBe(5);
    expect(data.remainingDays).toBe(20);
    expect(data.tripDays).toBe(5);
    expect(data.balanceAfter).toBe(15);
    expect(data.compliant).toBe(true);
    expect(data.verdict).toBe("compliant");
    expect(data.disclaimers.join(" ")).toContain("no leave is requested or booked");
    expect(data.disclaimers.join(" ")).not.toContain("No travel dates");
  });

  it("reports insufficient balance when the trip exceeds what is left", async () => {
    const app = await server();
    const body = await send(app, params("E0002"));
    const data = hrSectionSchema.parse(body.result!.sectionResult.data);
    expect(data.remainingDays).toBe(2);
    expect(data.tripDays).toBe(5);
    expect(data.balanceAfter).toBe(-3);
    expect(data.compliant).toBe(false);
    expect(data.verdict).toBe("insufficient-balance");
  });

  it("falls back to a unique name when no employee id was supplied", async () => {
    const app = await server();
    const body = await send(app, params("", { input: { query: "5 days in Paris", employeeName: "Grace Hopper" } }));
    const data = hrSectionSchema.parse(body.result!.sectionResult.data);
    expect(data.employeeId).toBe("E0002");
    expect(data.employeeName).toBe("Grace Hopper");
  });

  it("derives the trip length from the query when no dates were parsed", async () => {
    const app = await server();
    const body = await send(app, {
      section: "hr",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
      input: { query: "seven days in Paris", travelerCount: 1, employeeId: "E0001" },
    });
    const data = hrSectionSchema.parse(body.result!.sectionResult.data);
    expect(data.tripDays).toBe(7);
    expect(data.balanceAfter).toBe(13);
    expect(data.disclaimers.join(" ")).not.toContain("No travel dates");
  });

  it("flags a default-length trip when nothing indicates the duration", async () => {
    const app = await server();
    const body = await send(app, {
      section: "hr",
      sharedContext: { destination: "Rome", travelers: 1, interests: [] },
      input: { query: "a trip to Rome", travelerCount: 1, employeeId: "E0002" },
    });
    const data = hrSectionSchema.parse(body.result!.sectionResult.data);
    expect(data.tripDays).toBe(3);
    expect(data.disclaimers.join(" ")).toContain("No travel dates or stated duration");
  });

  it("rejects an unknown employee id with a reason that can reach the summary", async () => {
    const app = await server();
    const body = await send(app, params("E9999"));
    expect(body.error).toBeDefined();
    expect(body.error!.data.code).toBe("INVALID_PARAMS");
    expect(body.error!.data.retryable).toBe(false);
    expect(body.error!.message).toContain("No employee record for \"E9999\"");
  });

  it("refuses to guess between two employees with the same name", async () => {
    const app = await server();
    const body = await send(app, {
      section: "hr",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
      input: { query: "5 days", employeeName: "Ada Lovelace" },
    });
    expect(body.error).toBeDefined();
    expect(body.error!.message).toContain("supply an employee id");
  });

  it("requires an employee id or name", async () => {
    const app = await server();
    const body = await send(app, {
      section: "hr",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
      input: { query: "5 days in Paris" },
    });
    expect(body.error).toBeDefined();
    expect(body.error!.data.code).toBe("INVALID_PARAMS");
    expect(body.error!.message).toContain("input.employeeId");
  });

  it("rejects a malformed employee id", async () => {
    const app = await server();
    for (const bad of ["E1", "EMP1", "0001", "e12345"]) {
      const body = await send(app, params(bad));
      expect(body.error).toBeDefined();
      expect(body.error!.data.code).toBe("INVALID_PARAMS");
      // the shared section-call schema is the contract: rejected before the handler
      expect(
        (body.error!.data as { issues?: string[] }).issues?.join(" ") ?? body.error!.message,
      ).toContain("input.employeeId");
    }
  });

  it("accepts a lowercase employee id and normalizes it", async () => {
    const app = await server();
    const body = await send(app, params("e0001"));
    expect(body.error).toBeUndefined();
    expect(hrSectionSchema.parse(body.result!.sectionResult.data).employeeId).toBe("E0001");
  });

  it("does not modify the database while answering", async () => {
    const path = join(tempDir(), "hr.db");
    const app = await server(path);
    await send(app, params("E0001"));
    const before = readFileSync(path);
    await send(app, params("E0002"));
    const after = readFileSync(path);
    expect(Buffer.compare(before, after)).toBe(0);
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
