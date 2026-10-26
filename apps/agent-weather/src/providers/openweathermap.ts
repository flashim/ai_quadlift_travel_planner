import { z } from "zod";
import { AppErrorCode, fetchJson, hostsOf, internalError } from "@travel/shared";
import type { FetchForecastOptions, Forecast, WeatherProvider } from "./types";

const NAME = "openweather";
const DEFAULT_BASE = "https://api.openweathermap.org";
/** The free `/data/2.5/forecast` endpoint serves 3-hourly steps for 5 days. */
const FORECAST_STEPS = 40;
const METERS_PER_S_TO_KMPH = 3.6;

const geoResponseSchema = z
  .array(
    z.object({
      name: z.string(),
      lat: z.number(),
      lon: z.number(),
      country: z.string().optional(),
      state: z.string().optional(),
    }),
  )
  .min(1);

const forecastResponseSchema = z.object({
  city: z.object({ name: z.string(), country: z.string().optional() }).optional(),
  list: z
    .array(
      z.object({
        dt: z.number(),
        main: z.object({ temp_min: z.number(), temp_max: z.number() }),
        weather: z.array(z.object({ description: z.string() })).optional(),
        wind: z.object({ speed: z.number() }).optional(),
      }),
    )
    .min(1),
});

type GeoResponse = z.infer<typeof geoResponseSchema>;
type ForecastResponse = z.infer<typeof forecastResponseSchema>;

function dateOf(dt: number): string {
  return new Date(dt * 1000).toISOString().slice(0, 10);
}

function label(description: string | undefined): string {
  if (!description) return "Unknown";
  return description.charAt(0).toUpperCase() + description.slice(1);
}

/** Dominant condition of a day: most frequent step description, first wins ties. */
function dominant(entries: ForecastResponse["list"]): string {
  const counts = new Map<string, number>();
  for (const step of entries) {
    const desc = label(step.weather?.[0]?.description);
    counts.set(desc, (counts.get(desc) ?? 0) + 1);
  }
  let best = label(entries[0]?.weather?.[0]?.description);
  let bestCount = 0;
  for (const [desc, count] of counts) {
    if (count > bestCount) {
      best = desc;
      bestCount = count;
    }
  }
  return best;
}

/** Collapse 3-hourly steps into calendar days (min of mins, max of maxes). */
function toDays(body: ForecastResponse): Forecast["days"] {
  const byDate = new Map<string, ForecastResponse["list"]>();
  for (const step of body.list) {
    const date = dateOf(step.dt);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(step);
    else byDate.set(date, [step]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 7)
    .map(([date, steps]) => {
      const minC = Math.min(...steps.map((s) => s.main.temp_min));
      const maxC = Math.max(...steps.map((s) => s.main.temp_max));
      const windKmph = Math.max(
        ...steps.map((s) => (s.wind ? s.wind.speed * METERS_PER_S_TO_KMPH : 0)),
      );
      return {
        date,
        minC,
        maxC,
        condition: dominant(steps),
        ...(windKmph > 0 ? { windKmph: Math.round(windKmph) } : {}),
      };
    });
}

/**
 * OpenWeatherMap (`OPENWEATHER_API_KEY`, §17.3): direct geocoding + the free
 * 5-day/3-hourly forecast, aggregated to one entry per calendar day. The key is
 * checked before any request — a missing key is a registry-level skip, not a
 * failed upstream call.
 */
export const openWeatherProvider: WeatherProvider = {
  name: NAME,
  requiredEnv: "OPENWEATHER_API_KEY",
  async forecast(location: string, opts: FetchForecastOptions): Promise<Forecast> {
    const apiKey = process.env.OPENWEATHER_API_KEY?.trim();
    if (!apiKey) {
      throw internalError(
        AppErrorCode.InvalidParams,
        `${NAME}: OPENWEATHER_API_KEY is not configured`,
        false,
        { provider: NAME },
      );
    }
    const base = (process.env.OPENWEATHER_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
    const allowedHosts = hostsOf(base);
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

    const geoUrl = `${base}/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${encodeURIComponent(apiKey)}`;
    let place: GeoResponse[number] | undefined;
    try {
      const geo = (await fetchJson(geoUrl, {
        ...common,
        timeoutMs: remaining(),
        cacheKey: `openweather:geo:${normalized}`,
        schema: geoResponseSchema,
      })) as GeoResponse;
      place = geo[0];
    } catch (err) {
      // Invalid credentials surface as HTTP 401 — report them as config, not upstream.
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
    if (!place) {
      throw internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `${NAME}: no location matched "${location}"`,
        false,
        { provider: NAME },
      );
    }

    const forecastUrl =
      `${base}/data/2.5/forecast?lat=${place.lat}&lon=${place.lon}` +
      `&units=metric&cnt=${FORECAST_STEPS}&appid=${encodeURIComponent(apiKey)}`;
    const forecastPayload = (await fetchJson(forecastUrl, {
      ...common,
      timeoutMs: remaining(),
      cacheKey: `openweather:fc:${place.lat.toFixed(4)},${place.lon.toFixed(4)}`,
      schema: forecastResponseSchema,
    })) as ForecastResponse;

    const days = toDays(forecastPayload);
    if (days.length === 0) {
      throw internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `${NAME}: no forecast days for "${location}"`,
        false,
        { provider: NAME },
      );
    }

    const city = forecastPayload.city?.name ?? place.name;
    const labelParts = [city, place.state, place.country].filter(
      (p): p is string => Boolean(p),
    );
    return {
      location: labelParts.filter((p, i) => labelParts.indexOf(p) === i).join(", "),
      days,
      asOf: new Date().toISOString(),
      provider: NAME,
    };
  },
};
