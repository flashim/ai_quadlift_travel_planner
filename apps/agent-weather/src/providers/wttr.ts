import { z } from "zod";
import { AppErrorCode, fetchJson, hostsOf, internalError, RpcError } from "@travel/shared";
import type { FetchForecastOptions, Forecast, WeatherProvider } from "./types";

const NAME = "wttr";
/** §17.3 fallback domain wttr.is; first domain wins, second on retryable failure. */
const DOMAINS = ["https://wttr.in", "https://wttr.is"];

const wttrDaySchema = z.object({
  date: z.string(),
  mintempC: z.string(),
  maxtempC: z.string(),
  hourly: z
    .array(
      z.object({
        weatherDesc: z.array(z.object({ value: z.string() })).default([]),
        precipMM: z.string().optional(),
        windspeedKmph: z.string().optional(),
      }),
    )
    .optional(),
});

const wttrResponseSchema = z.object({
  weather: z.array(wttrDaySchema).min(1),
  nearest_area: z
    .array(
      z.object({
        areaName: z.array(z.object({ value: z.string() })).default([]),
      }),
    )
    .optional(),
  request: z
    .array(
      z.object({
        query: z.string().optional(),
      }),
    )
    .optional(),
});

type WttrResponse = z.infer<typeof wttrResponseSchema>;

function toDays(body: WttrResponse): Forecast["days"] {
  return body.weather.map((d) => {
    const noon = d.hourly?.[4] ?? d.hourly?.[d.hourly.length - 1];
    const wind = noon?.windspeedKmph !== undefined ? Number(noon.windspeedKmph) : undefined;
    const precip = noon?.precipMM !== undefined ? Number(noon.precipMM) : undefined;
    return {
      date: d.date,
      minC: Number(d.mintempC),
      maxC: Number(d.maxtempC),
      condition: noon?.weatherDesc?.[0]?.value ?? "Unknown",
      ...(Number.isFinite(precip) ? { precipMm: precip! } : {}),
      ...(Number.isFinite(wind) ? { windKmph: wind! } : {}),
    };
  });
}

export const wttrProvider: WeatherProvider = {
  name: NAME,
  async forecast(location: string, opts: FetchForecastOptions): Promise<Forecast> {
    const allowedHosts = hostsOf(...DOMAINS);
    const budget = opts.timeoutMs ?? 9_000;
    const started = Date.now();
    const remaining = () => Math.max(500, budget - (Date.now() - started));
    const normalized = location.trim().toLowerCase().replace(/\s+/g, "+");
    let lastError: unknown;

    for (const domain of DOMAINS) {
      const encoded = encodeURIComponent(location).replace(/%20/g, "+");
      const url = `${domain}/${encoded}?format=j1&m`;
      try {
        const body = (await fetchJson(url, {
          provider: NAME,
          userAgent: opts.userAgent,
          allowedHosts,
          signal: opts.signal,
          timeoutMs: remaining(),
          cacheKey: `wttr:${normalized}`,
          schema: wttrResponseSchema,
        })) as WttrResponse;

        const days = toDays(body);
        const resolvedLocation =
          body.nearest_area?.[0]?.areaName?.[0]?.value ?? body.request?.[0]?.query ?? location;
        return {
          location: resolvedLocation,
          days,
          asOf: new Date().toISOString(),
          provider: NAME,
        };
      } catch (err) {
        lastError = err;
        // Non-retryable (e.g. malformed request) — the other domain would fail the same way.
        if (err instanceof RpcError && !err.retryable) throw err;
      }
    }

    throw lastError ?? internalError(
      AppErrorCode.UpstreamInvalidResponse,
      `wttr: forecast unavailable for "${location}"`,
      true,
      { provider: NAME },
    );
  },
};
