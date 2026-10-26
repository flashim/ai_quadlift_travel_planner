import { loadEnv } from "@travel/shared";
import { resolveHrDbPath, seedHrDb } from "./db";

loadEnv();

/** `npm run db:seed` — create and populate `hr.db` without starting the agent. */
const path = resolveHrDbPath();

try {
  seedHrDb(path);
  console.log(`[agent-hr] employee database ready at ${path}`);
} catch (err) {
  console.error("[agent-hr] seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
