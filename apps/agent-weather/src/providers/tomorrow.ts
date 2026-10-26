import { z } from "zod";
import { AppErrorCode, fetchJson, hostsOf, internalError } from "@travel/shared";
import type { FetchForecastOptions, Forecast, WeatherProvider } from "./types";

const NAME = "tomorrow";
const DEFAULT_BASE = "https://api.tomorrow.io";
/** One Call-style daily horizon served by the free tier (§17.3). */
const FORECAST_DAYS = 7;

const forecastResponseSchema = z.object({
  location: z
    .object({
      lat: z.number().optional(),
      lon: z.number().optional(),
      name: z.string().optional(),
    })
    .optional(),
  timelines: z.object({
    daily: z
      .array(
        z.object({
          startTime: z.string(),
          values: z.object({
            temperatureMax: z.number().optional(),
            temperatureMin: z.number().optional(),
            temperatureAvg: z.number().optional(),
            weatherCode: z.number().optional(),
            precipitationSum: z.number().optional(),
            windSpeedAvg: z.number().optional(),
          }),
        }),
      )
      .optional(),
  }),
});

type ForecastResponse = z.infer<typeof forecastResponseSchema>;

/** Tomorrow.io weather codes → human-readable conditions (deterministic, §11). */
export const TOMORROW_CONDITIONS: Record<number, string> = {
  1000: "Clear",
  1001: "Cloudy",
  1100: "Mostly cloudy",
  1101: "Partly cloudy",
  1102: "Scattered clouds",
  2000: "Fog",
  2100: "Light fog",
  3000: "Light wind",
  4000: "Drizzle",
  4100: "Light rain",
  4200: "Rain",
  4300: "Heavy rain",
  5000: "Frozen rain",
  5100: "Light ice",
  5101: "Ice",
  5102: "Heavy ice",
  6000: "Flurries",
  6100: "Light snow",
  6200: "Snow",
  6300: "Heavy snow",
  7000: "Ice pellets",
  7100: "Light ice pellets",
  7200: "Heavy ice pellets",
  8000: "Thunderstorm",
};

export function tomorrowCondition(code: number | null | undefined): string {
  if (code === null || code === undefined) return "Unknown";
  return TOMORROW_CONDITIONS[code] ?? `Unknown (code ${code})`;
}

function toDays(body: ForecastResponse): Forecast["days"] {
  return (body.timelines.daily ?? [])
    .map((entry) => {
      const values = entry.values;
      const maxC = values.temperatureMax ?? values.temperatureAvg;
      const minC = values.temperatureMin ?? values.temperatureAvg;
      if (typeof maxC !== "number" || typeof minC !== "number") return null;
      const precipMm = values.precipitationSum;
      const windKmph = values.windSpeedAvg;
      return {
        date: entry.startTime.slice(0, 10),
        minC,
        maxC,
        condition: tomorrowCondition(values.weatherCode),
        ...(typeof precipMm === "number" ? { precipMm } : {}),
        ...(typeof windKmph === "number" ? { windKmph } : {}),
      };
    })
    .filter((day): day is NonNullable<typeof day> => day !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, FORECAST_DAYS);
}

/**
 * Tomorrow.io (`TOMORROW_API_KEY`, §17.3): v4 forecast with the daily
 * timesteps; the `location` parameter accepts a place name, so no separate
 * geocoding hop is needed. A missing key is a registry-level skip.
 */
export const tomorrowProvider: WeatherProvider = {
  name: NAME,
  requiredEnv: "TOMORROW_API_KEY",
  async forecast(location: string, opts: FetchForecastOptions): Promise<Forecast> {
    const apiKey = process.env.TOMORROW_API_KEY?.trim();
    if (!apiKey) {
      throw internalError(
        AppErrorCode.InvalidParams,
        `${NAME}: TOMORROW_API_KEY is not configured`,
        false,
        { provider: NAME },
      );
    }
    const base = (process.env.TOMORROW_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
    const allowedHosts = hostsOf(base);
    const normalized = location.trim().toLowerCase().replace(/\s+/g, " ");
    const url =
      `${base}/v4/weather/forecast?location=${encodeURIComponent(location)}` +
      `&apikey=${encodeURIComponent(apiKey)}&units=metric&unitsSystem=metric` +
      `&timesteps=1d&forecastDays=${FORECAST_DAYS}` +
      `&fields=temperatureMax,temperatureMin,temperatureAvg,weatherCode,precipitationSum,windSpeedAvg`;

    let body: unknown;
    try {
      body = await fetchJson(url, {
        provider: NAME,
        userAgent: opts.userAgent,
        allowedHosts,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 9_000,
        cacheKey: `tomorrow:fc:${normalized}`,
        schema: forecastResponseSchema,
      });
    } catch (err) {
      // Invalid keys surface as HTTP 401/403 — report them as config, not upstream.
      if (err && typeof err === "object" && "data" in err) {
        const status = (err as { data?: { status?: number } }).data?.status;
        if (status === 401 || status === 403) {
          throw internalError(
            AppErrorCode.InvalidParams,
            `${NAME}: API key rejected (HTTP ${status})`,
            false,
            { provider: NAME },
          );
        }
      }
      throw err;
    }

    const days = toDays(body as ForecastResponse);
    if (days.length === 0) {
      throw internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `${NAME}: no forecast days for "${location}"`,
        false,
        { provider: NAME },
      );
    }

    return {
      location: (body as ForecastResponse).location?.name ?? location,
      days,
      asOf: new Date().toISOString(),
      provider: NAME,
    };
  },
};
