import { loadEnv } from "@travel/shared";
import { buildHrServer } from "./agent";

loadEnv();

const PORT = Number(process.env.AGENT_HR_PORT ?? 8004);

buildHrServer()
  .then(async (app) => {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error("[agent-hr] fatal:", err);
    process.exit(1);
  });
