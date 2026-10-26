import { loadEnv } from "@travel/shared";
import { buildWeatherServer } from "./agent";

loadEnv();

const PORT = Number(process.env.AGENT_WEATHER_PORT ?? 8002);

buildWeatherServer()
  .then(async (app) => {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error("[agent-weather] fatal:", err);
    process.exit(1);
  });
