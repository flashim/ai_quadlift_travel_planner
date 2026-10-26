import { loadEnv } from "@travel/shared";
import { resolveCostDbPath, seedCostDb } from "./db";

loadEnv();

/** `npm run db:seed` — create and populate `costs.db` without starting the agent. */
const path = resolveCostDbPath();

try {
  seedCostDb(path);
  console.log(`[agent-budget] cost catalog ready at ${path}`);
} catch (err) {
  console.error("[agent-budget] seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
