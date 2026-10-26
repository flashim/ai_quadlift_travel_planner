import { loadEnv } from "@travel/shared";
import { buildBudgetServer } from "./agent";

loadEnv();

const PORT = Number(process.env.AGENT_BUDGET_PORT ?? 8003);

buildBudgetServer()
  .then(async (app) => {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error("[agent-budget] fatal:", err);
    process.exit(1);
  });
