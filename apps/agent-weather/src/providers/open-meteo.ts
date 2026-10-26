import { z } from "zod";
import { AppErrorCode, fetchJson, hostsOf, internalError } from "@travel/shared";
import type { FetchForecastOptions, Forecast, WeatherProvider } from "./types";

const NAME = "open-meteo";
const DEFAULT_FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const DEFAULT_GEOCODING_BASE = "https://geocoding-api.open-meteo.com/v1/search";
/** Free-tier daily horizon (§17.3: never invent forecasts beyond the provider). */
const FORECAST_DAYS = 16;
const DAILY_VARS =
  "weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max";

const geocodeResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        admin1: z.string().optional(),
        country: z.string().optional(),
      }),
    )
    .optional(),
});

const forecastResponseSchema = z.object({
  daily: z.object({
    time: z.array(z.string()).min(1),
    weathercode: z.array(z.number().nullable()),
    temperature_2m_max: z.array(z.number().nullable()),
    temperature_2m_min: z.array(z.number().nullable()),
    precipitation_sum: z.array(z.number().nullable()).optional(),
    wind_speed_10m_max: z.array(z.number().nullable()).optional(),
  }),
});

type GeocodeResponse = z.infer<typeof geocodeResponseSchema>;
type ForecastResponse = z.infer<typeof forecastResponseSchema>;

/** WMO weather interpretation codes → human-readable conditions (deterministic, §11). */
export const WMO_CONDITIONS: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with light hail",
  99: "Thunderstorm with heavy hail",
};

export function wmoCondition(code: number | null | undefined): string {
  if (code === null || code === undefined) return "Unknown";
  return WMO_CONDITIONS[code] ?? `Unknown (code ${code})`;
}

function placeLabel(place: { name: string; admin1?: string; country?: string }): string {
  const parts = [place.name, place.admin1, place.country].filter((p): p is string => Boolean(p));
  return parts.filter((p, i) => parts.indexOf(p) === i).join(", ");
}

function toDays(daily: ForecastResponse["daily"]): Forecast["days"] {
  return daily.time.flatMap((date, i) => {
    const minC = daily.temperature_2m_min[i];
    const maxC = daily.temperature_2m_max[i];
    if (minC === null || minC === undefined || maxC === null || maxC === undefined) return [];
    const precipMm = daily.precipitation_sum?.[i];
    const windKmph = daily.wind_speed_10m_max?.[i];
    return [
      {
        date,
        minC,
        maxC,
        condition: wmoCondition(daily.weathercode[i]),
        ...(precipMm !== null && precipMm !== undefined ? { precipMm } : {}),
        ...(windKmph !== null && windKmph !== undefined ? { windKmph } : {}),
      },
    ];
  });
}

export const openMeteoProvider: WeatherProvider = {
  name: "open-meteo",
  async forecast(location: string, opts: FetchForecastOptions): Promise<Forecast> {
    const forecastBase = (process.env.OPEN_METEO_BASE_URL ?? DEFAULT_FORECAST_BASE).replace(/\/+$/, "");
    const geocodingBase = (process.env.OPEN_METEO_GEOCODING_BASE_URL ?? DEFAULT_GEOCODING_BASE).replace(/\/+$/, "");
    const allowedHosts = hostsOf(forecastBase, geocodingBase);
    const budget = opts.timeoutMs ?? 9_000;
    const started = Date.now();
    const remaining = () => Math.max(500, budget - (Date.now() - started));
    const normalized = location.trim().toLowerCase().replace(/\s+/g, " ");
    const common = {
      provider: NAME,
      userAgent: opts.userAgent,
      allowedHosts,
      signal: opts.signal,
    };

    const geocodingUrl = `${geocodingBase}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geocoding = (await fetchJson(geocodingUrl, {
      ...common,
      timeoutMs: remaining(),
      cacheKey: `open-meteo:geo:${normalized}`,
      schema: geocodeResponseSchema,
    })) as GeocodeResponse;
    const place = geocoding.results?.[0];
    if (!place) {
      throw internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `open-meteo: no location matched "${location}"`,
        false,
        { provider: NAME },
      );
    }

    const forecastUrl =
      `${forecastBase}?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&daily=${DAILY_VARS}&timezone=auto&forecast_days=${FORECAST_DAYS}`;
    const forecastPayload = (await fetchJson(forecastUrl, {
      ...common,
      timeoutMs: remaining(),
      cacheKey: `open-meteo:fc:${place.latitude.toFixed(4)},${place.longitude.toFixed(4)}`,
      schema: forecastResponseSchema,
    })) as ForecastResponse;

    const days = toDays(forecastPayload.daily);
    if (days.length === 0) {
      throw internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `open-meteo: no forecast days for "${location}"`,
        false,
        { provider: NAME },
      );
    }

    return {
      location: placeLabel(place),
      days,
      asOf: new Date().toISOString(),
      provider: NAME,
    };
  },
};
