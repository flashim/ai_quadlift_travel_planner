import { loadEnv } from "@travel/shared";
import { buildOrchestratorServer } from "./server";

loadEnv();

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8000);

buildOrchestratorServer()
  .then(async (app) => {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error("[orchestrator] fatal:", err);
    process.exit(1);
  });
