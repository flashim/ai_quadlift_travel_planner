import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assertAllowedHost, clearForecastCache, fetchJson, hostsOf } from "@travel/shared";
import { wmoCondition } from "../src/providers/open-meteo";
import { tomorrowCondition } from "../src/providers/tomorrow";
import { openWeatherProvider } from "../src/providers/openweathermap";
import { tomorrowProvider } from "../src/providers/tomorrow";
import { resolveChain, resolveChainReport } from "../src/providers/registry";
import type { FetchForecastOptions } from "../src/providers/types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = { provider: "test", userAgent: "vitest", allowedHosts: ["api.example.com"] };
const opts: FetchForecastOptions = { userAgent: "vitest" };

describe("weather http layer (§6.2)", () => {
  beforeEach(() => {
    clearForecastCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearForecastCache();
  });

  it("refuses hosts outside the allowlist without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJson("https://evil.example.com/x", base)).rejects.toThrow(
      "not in the allowlist",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => assertAllowedHost("https://api.example.com/x", ["api.example.com"], "test")).not.toThrow();
  });

  it("retries 5xx with bounded attempts, then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls < 3 ? json({ error: true }, 500) : json({ ok: true });
      }),
    );
    const result = await fetchJson("https://api.example.com/a", {
      ...base,
      backoffBaseMs: 0,
      schema: z.object({ ok: z.boolean() }),
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("gives up when the time budget is already spent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJson("https://api.example.com/a", { ...base, timeoutMs: 100 })).rejects.toThrow(
      "budget exhausted",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches validated payloads across repeat calls", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return json({ ok: true });
      }),
    );
    const opts = { ...base, schema: z.object({ ok: z.boolean() }) };
    await fetchJson("https://api.example.com/a", opts);
    await fetchJson("https://api.example.com/a", opts);
    expect(calls).toBe(1);
  });

  it("never caches payloads that fail validation", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return json({ bogus: 1 });
      }),
    );
    await expect(
      fetchJson("https://api.example.com/a", {
        ...base,
        backoffBaseMs: 0,
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow("unexpected payload");
    expect(calls).toBe(3);
  });

  it("maps 429 to UPSTREAM_RATE_LIMITED after bounded retries", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return json({}, 429);
      }),
    );
    const err = (await fetchJson("https://api.example.com/a", { ...base, backoffBaseMs: 0 }).catch(
      (e: unknown) => e,
    )) as { appCode?: string; retryable?: boolean };
    expect(err.appCode).toBe("UPSTREAM_RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable 4xx responses", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return json({}, 404);
      }),
    );
    const err = (await fetchJson("https://api.example.com/a", { ...base, backoffBaseMs: 0 }).catch(
      (e: unknown) => e,
    )) as { appCode?: string; retryable?: boolean };
    expect(err.appCode).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it("extracts unique hosts for the allowlist", () => {
    expect(
      hostsOf(
        "https://api.open-meteo.com/v1/forecast",
        "https://geocoding-api.open-meteo.com/v1/search",
        "https://api.open-meteo.com/v1/forecast",
      ),
    ).toEqual(["api.open-meteo.com", "geocoding-api.open-meteo.com"]);
  });
});

describe("weather provider registry", () => {
  it("defaults to the open-meteo → openweather → tomorrow → wttr chain", () => {
    expect(
      resolveChain({
        OPENWEATHER_API_KEY: "k",
        TOMORROW_API_KEY: "k",
      } as NodeJS.ProcessEnv).map((p) => p.name),
    ).toEqual(["open-meteo", "openweather", "tomorrow", "wttr"]);
  });

  it("skips keyed providers when their API key is missing (§17.3)", () => {
    const report = resolveChainReport({} as NodeJS.ProcessEnv);
    expect(report.chain.map((p) => p.name)).toEqual(["open-meteo", "wttr"]);
    expect(report.skipped.map((s) => s.name)).toEqual(["openweather", "tomorrow"]);
    expect(report.skipped[0]?.reason).toContain("OPENWEATHER_API_KEY");
    expect(report.skipped[1]?.reason).toContain("TOMORROW_API_KEY");
    expect(report.fallback).toBe(false);
  });

  it("falls back to the keyless defaults when every configured provider is keyed", () => {
    const report = resolveChainReport({
      WEATHER_PROVIDERS: "openweather,tomorrow",
    } as NodeJS.ProcessEnv);
    expect(report.chain.map((p) => p.name)).toEqual(["open-meteo", "wttr"]);
    expect(report.fallback).toBe(true);
    expect(report.skipped).toHaveLength(2);
  });

  it("keeps a keyed provider when its key IS configured", () => {
    expect(
      resolveChain({ WEATHER_PROVIDERS: "openweather", OPENWEATHER_API_KEY: "k" } as NodeJS.ProcessEnv).map(
        (p) => p.name,
      ),
    ).toEqual(["openweather"]);
  });

  it("supports the single-provider alias and dedupes chains", () => {
    expect(
      resolveChain({ WEATHER_PROVIDER: "wttr" } as NodeJS.ProcessEnv).map((p) => p.name),
    ).toEqual(["wttr"]);
    expect(
      resolveChain({ WEATHER_PROVIDERS: "wttr,open-meteo,wttr" } as NodeJS.ProcessEnv).map(
        (p) => p.name,
      ),
    ).toEqual(["wttr", "open-meteo"]);
  });

  it("fails fast on unknown or empty chains", () => {
    expect(() => resolveChain({ WEATHER_PROVIDERS: "bogus" } as NodeJS.ProcessEnv)).toThrow(
      'Unknown weather provider "bogus"',
    );
    expect(() => resolveChain({ WEATHER_PROVIDERS: " , " } as NodeJS.ProcessEnv)).toThrow(
      "empty list",
    );
  });
});

describe("openweathermap provider (§17.3)", () => {
  beforeEach(() => clearForecastCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearForecastCache();
  });

  const geoPayload = [
    { name: "Paris", lat: 48.85, lon: 2.35, country: "FR", state: "Île-de-France" },
  ];
  const forecastPayload = {
    city: { name: "Paris", country: "FR" },
    list: [
      // day 1: two steps, wind in m/s → km/h
      {
        dt: Math.floor(Date.parse("2026-10-05T06:00:00Z") / 1000),
        main: { temp_min: 10, temp_max: 15 },
        weather: [{ description: "light rain" }],
        wind: { speed: 4 },
      },
      {
        dt: Math.floor(Date.parse("2026-10-05T12:00:00Z") / 1000),
        main: { temp_min: 11, temp_max: 18 },
        weather: [{ description: "light rain" }],
        wind: { speed: 6 },
      },
      // day 2
      {
        dt: Math.floor(Date.parse("2026-10-06T12:00:00Z") / 1000),
        main: { temp_min: 11, temp_max: 19 },
        weather: [{ description: "clear sky" }],
        wind: { speed: 3 },
      },
    ],
  };

  it("aggregates 3-hourly steps into calendar days", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/geo/1.0/direct")) return json(geoPayload);
        if (url.includes("/data/2.5/forecast")) return json(forecastPayload);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const forecast = await openWeatherProvider.forecast("Paris", opts);
    expect(forecast.provider).toBe("openweather");
    expect(forecast.location).toBe("Paris, Île-de-France, FR");
    expect(forecast.days).toEqual([
      { date: "2026-10-05", minC: 10, maxC: 18, condition: "Light rain", windKmph: 22 },
      { date: "2026-10-06", minC: 11, maxC: 19, condition: "Clear sky", windKmph: 11 },
    ]);
  });

  it("maps a rejected API key to a non-retryable config error", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "bad");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ code: 401, message: "invalid api key" }, 401)),
    );
    await expect(openWeatherProvider.forecast("Paris", opts)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("API key rejected"),
    });
  });

  it("refuses to run without a key", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "");
    await expect(openWeatherProvider.forecast("Paris", opts)).rejects.toThrow(
      "OPENWEATHER_API_KEY is not configured",
    );
  });
});

describe("tomorrow.io provider (§17.3)", () => {
  beforeEach(() => clearForecastCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearForecastCache();
  });

  const dailyPayload = {
    location: { lat: 48.85, lon: 2.35, name: "Paris" },
    timelines: {
      daily: [
        {
          startTime: "2026-10-05T00:00:00Z",
          values: {
            temperatureMax: 18,
            temperatureMin: 10,
            weatherCode: 4200,
            precipitationSum: 0.4,
            windSpeedAvg: 12,
          },
        },
        {
          startTime: "2026-10-06T00:00:00Z",
          values: { temperatureMax: 19, temperatureMin: 11, weatherCode: 1000 },
        },
      ],
    },
  };

  it("maps daily timesteps to forecast days", async () => {
    vi.stubEnv("TOMORROW_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        expect(url).toContain("api.tomorrow.io/v4/weather/forecast");
        expect(url).toContain("timesteps=1d");
        return json(dailyPayload);
      }),
    );
    const forecast = await tomorrowProvider.forecast("Paris", opts);
    expect(forecast.provider).toBe("tomorrow");
    expect(forecast.location).toBe("Paris");
    expect(forecast.days).toEqual([
      {
        date: "2026-10-05",
        minC: 10,
        maxC: 18,
        condition: "Rain",
        precipMm: 0.4,
        windKmph: 12,
      },
      { date: "2026-10-06", minC: 11, maxC: 19, condition: "Clear" },
    ]);
  });

  it("maps weather codes deterministically and degrades unknown ones", () => {
    expect(tomorrowCondition(1000)).toBe("Clear");
    expect(tomorrowCondition(8000)).toBe("Thunderstorm");
    expect(tomorrowCondition(4242)).toBe("Unknown (code 4242)");
    expect(tomorrowCondition(null)).toBe("Unknown");
  });

  it("refuses to run without a key", async () => {
    vi.stubEnv("TOMORROW_API_KEY", "  ");
    await expect(tomorrowProvider.forecast("Paris", opts)).rejects.toThrow(
      "TOMORROW_API_KEY is not configured",
    );
  });
});

describe("WMO condition mapping", () => {
  it("maps known codes and degrades unknown ones deterministically", () => {
    expect(wmoCondition(0)).toBe("Clear");
    expect(wmoCondition(61)).toBe("Light rain");
    expect(wmoCondition(95)).toBe("Thunderstorm");
    expect(wmoCondition(4242)).toBe("Unknown (code 4242)");
    expect(wmoCondition(null)).toBe("Unknown");
  });
});
