import {
  fetchAgentCard,
  fetchHealth,
  loadEnv,
  loadRegistry,
} from "@travel/shared";

loadEnv();

interface Row {
  agent: string;
  port: string;
  card: string;
  health: string;
  skills: string;
}

async function check(name: string, baseUrl: string): Promise<Row> {
  const port = new URL(baseUrl).port || "443";
  try {
    const card = await fetchAgentCard(baseUrl, { timeoutMs: 4_000 });
    const health = await fetchHealth(baseUrl, { timeoutMs: 4_000 });
    return {
      agent: name,
      port,
      card: `${card.name}@${card.version}`,
      health: health.status,
      skills: String(card.skills.length),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { agent: name, port, card: "—", health: `FAIL: ${message}`, skills: "—" };
  }
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  const registry = loadRegistry();
  for (const agent of registry.agents.filter((a) => a.enabled)) {
    rows.push(await check(agent.name, agent.baseUrl));
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:8000";
  rows.push(await check("orchestrator", orchestratorUrl));

  const pad = (s: string, n: number) => s.padEnd(n).slice(0, Math.max(n, s.length));
  console.log(
    `${pad("AGENT", 22)} ${pad("PORT", 6)} ${pad("CARD", 30)} ${pad("HEALTH", 40)} SKILLS`,
  );
  console.log("-".repeat(110));
  let failed = false;
  for (const row of rows) {
    // anything that is not exactly "ok" (an error or a degraded self-report) is a failure
    if (row.health !== "ok") failed = true;
    console.log(
      `${pad(row.agent, 22)} ${pad(row.port, 6)} ${pad(row.card, 30)} ${pad(row.health, 40)} ${row.skills}`,
    );
  }
  console.log("-".repeat(110));
  console.log(failed ? "doctor: FAIL" : "doctor: all agents healthy");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("doctor: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
