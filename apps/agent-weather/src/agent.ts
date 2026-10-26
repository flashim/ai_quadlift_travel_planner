import {
  AppErrorCode,
  createAgentCard,
  createAgentServer,
  internalError,
  parseParams,
  sectionCallParamsSchema,
  type SectionCallParams,
  type SectionEnvelope,
} from "@travel/shared";
import type { FastifyInstance } from "fastify";
import { fetchForecast, resolveChainReport } from "./providers/registry";
import type { ForecastDay } from "./providers/types";

const VERSION = "0.1.0";
const USER_AGENT = `travel-planner-weather/${VERSION}`;
/** Fits inside the weather section budget (registry timeoutMs 10 000, §9). */
const FETCH_BUDGET_MS = 9_000;

async function weatherHandler(raw: unknown): Promise<{ sectionResult: SectionEnvelope }> {
  const params = parseParams(sectionCallParamsSchema, raw) as SectionCallParams;
  const destination = params.sharedContext.destination;
  if (!destination) {
    throw internalError(
      AppErrorCode.InvalidParams,
      "weather agent requires sharedContext.destination",
      false,
    );
  }

  // Resolve once: the chain walk and the disclaimer below must agree on which
  // providers were skipped for missing keys (§17.3 graceful degradation).
  const report = resolveChainReport();
  const forecast = await fetchForecast(destination, {
    userAgent: USER_AGENT,
    timeoutMs: FETCH_BUDGET_MS,
  });

  const start = params.sharedContext.startDate;
  const end = params.sharedContext.endDate;
  const lastForecast = forecast.days.length
    ? forecast.days[forecast.days.length - 1]!.date
    : undefined;
  const disclaimers: string[] = [];
  let coverage: "forecast" | "outside-forecast" = "forecast";

  for (const skipped of report.skipped) {
    disclaimers.push(
      `Weather provider "${skipped.name}" unavailable (${skipped.reason}); using ${report.chain.map((p) => p.name).join(" → ")} instead.`,
    );
  }
  if (report.fallback) {
    disclaimers.push(
      `No configured weather provider had credentials — serving the keyless forecast (${report.chain.map((p) => p.name).join(" → ")}).`,
    );
  }

  if (start && lastForecast && start > lastForecast) {
    coverage = "outside-forecast";
    disclaimers.push(
      `Travel dates start ${start}, beyond the available forecast horizon (${lastForecast}). ` +
        `Nearest available days are shown; conditions may differ.`,
    );
  } else if (!start) {
    disclaimers.push("No travel dates provided; showing the current short-range forecast.");
  }
  if (end && lastForecast && end > lastForecast && coverage === "forecast") {
    disclaimers.push(
      `Forecast covers only through ${lastForecast}; later days are outside the horizon.`,
    );
  }

  const data = {
    location: forecast.location,
    coverage,
    provider: forecast.provider,
    asOf: forecast.asOf,
    days: forecast.days.map((d: ForecastDay) => ({
      date: d.date,
      minC: d.minC,
      maxC: d.maxC,
      condition: d.condition,
      ...(d.precipMm !== undefined ? { precipMm: d.precipMm } : {}),
      ...(d.windKmph !== undefined ? { windKmph: d.windKmph } : {}),
    })),
    disclaimers,
  };

  return {
    sectionResult: { key: params.section ?? "weather", status: "completed", data },
  };
}

export async function buildWeatherServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const port = Number(process.env.AGENT_WEATHER_PORT ?? 8002);
  // Fail fast at startup on a bad WEATHER_PROVIDERS config (§6.2).
  const providerNames = resolveChainReport().chain.map((p) => p.name);
  const card = createAgentCard({
    name: "weather",
    description: `Retrieves a short-range weather forecast for a destination via ${providerNames.join(" → ")} and maps it to travel dates.`,
    version: VERSION,
    baseUrl: `http://localhost:${port}`,
    skills: [
      {
        id: "weather-forecast",
        name: "Weather Forecast",
        description: "Daily min/max temperatures and conditions for the destination.",
        tags: ["weather", "forecast", ...providerNames],
        examples: ["Forecast for Paris from 2026-10-05 to 2026-10-09"],
      },
    ],
  });

  return createAgentServer({
    card,
    handlers: { "message/send": weatherHandler },
    logger: opts.logger ?? true,
  });
}
