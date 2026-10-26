import { loadEnv } from "@travel/shared";
import { buildDestinationServer } from "./agent";

loadEnv();

const PORT = Number(process.env.AGENT_DESTINATION_PORT ?? 8001);

buildDestinationServer()
  .then(async (app) => {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error("[agent-destination] fatal:", err);
    process.exit(1);
  });
