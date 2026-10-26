import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentCardSchema } from "@travel/shared";
import { buildWeatherServer } from "../src/agent";
import { clearForecastCache } from "@travel/shared";

const geocodePayload = {
  results: [
    {
      name: "Paris",
      latitude: 48.85,
      longitude: 2.35,
      admin1: "Île-de-France",
      country: "France",
    },
  ],
};

const forecastPayload = {
  daily: {
    time: ["2026-10-05", "2026-10-06"],
    weathercode: [61, 0],
    temperature_2m_max: [18, 19],
    temperature_2m_min: [10, 11],
    precipitation_sum: [0.2, 0.0],
    wind_speed_10m_max: [14, 10],
  },
};

const wttrPayload = {
  weather: [
    {
      date: "2026-10-05",
      mintempC: "10",
      maxtempC: "18",
      hourly: Array.from({ length: 8 }, () => ({
        weatherDesc: [{ value: "Partly cloudy" }],
        precipMM: "0.2",
        windspeedKmph: "14",
      })),
    },
    {
      date: "2026-10-06",
      mintempC: "11",
      maxtempC: "19",
      hourly: Array.from({ length: 8 }, () => ({
        weatherDesc: [{ value: "Sunny" }],
        precipMM: "0.0",
        windspeedKmph: "10",
      })),
    },
  ],
  nearest_area: [{ areaName: [{ value: "Paris" }] }],
  request: [{ query: "Paris, France" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchImpl = (url: string) => Response | Promise<Response>;

function stubFetch(impl: FetchImpl): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => impl(String(input))),
  );
}

function defaultFetch(url: string): Response {
  if (url.includes("geocoding-api.open-meteo.com")) return json(geocodePayload);
  if (url.includes("api.open-meteo.com")) return json(forecastPayload);
  if (url.includes("wttr.in") || url.includes("wttr.is")) return json(wttrPayload);
  throw new Error(`unexpected fetch: ${url}`);
}

async function send(app: Awaited<ReturnType<typeof buildWeatherServer>>, params: unknown) {
  const res = await app.inject({
    method: "POST",
    url: "/",
    payload: { jsonrpc: "2.0", id: 1, method: "message/send", params },
  });
  return JSON.parse(res.body);
}

describe("weather agent contract", () => {
  beforeEach(() => {
    clearForecastCache();
    stubFetch(defaultFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearForecastCache();
  });

  async function server() {
    return buildWeatherServer({ logger: false });
  }

  it("publishes a valid agent card listing the configured providers", async () => {
    const app = await server();
    for (const url of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/a2a+json");
      const card = agentCardSchema.parse(JSON.parse(res.body));
      expect(card.name).toBe("weather");
      expect(card.skills[0]?.tags).toContain("open-meteo");
      expect(card.skills[0]?.tags).toContain("wttr");
      // keyed providers are only advertised when their key is configured
      expect(card.skills[0]?.tags).not.toContain("openweather");
      expect(card.skills[0]?.tags).not.toContain("tomorrow");
    }
    await app.close();
  });

  it("reports keyed providers skipped for a missing API key as a disclaimer", async () => {
    vi.stubEnv("WEATHER_PROVIDERS", "open-meteo,openweather,tomorrow,wttr");
    const app = await server();
    const body = await send(app, {
      section: "weather",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
    });
    expect(body.error).toBeUndefined();
    const { sectionResult } = body.result;
    expect(sectionResult.data.provider).toBe("open-meteo");
    const disclaimers = sectionResult.data.disclaimers.join(" ");
    expect(disclaimers).toContain("openweather");
    expect(disclaimers).toContain("OPENWEATHER_API_KEY");
    expect(disclaimers).toContain("tomorrow");
    expect(disclaimers).toContain("TOMORROW_API_KEY");
    await app.close();
  });

  it("reports health", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
    await app.close();
  });

  it("rejects malformed params with INVALID_PARAMS", async () => {
    const app = await server();
    const body = await send(app, { sharedContext: { travelers: 1 } });
    expect(body.error).toBeDefined();
    expect(body.error.data.code).toBe("INVALID_PARAMS");
    expect(body.error.data.retryable).toBe(false);
    await app.close();
  });

  it("returns a weather section from open-meteo mapped to travel dates", async () => {
    const app = await server();
    const body = await send(app, {
      planId: "p1",
      section: "weather",
      sharedContext: {
        destination: "Paris",
        startDate: "2026-10-05",
        endDate: "2026-10-06",
        travelers: 2,
        interests: [],
      },
    });
    expect(body.error).toBeUndefined();
    const { sectionResult } = body.result;
    expect(sectionResult.key).toBe("weather");
    expect(sectionResult.status).toBe("completed");
    expect(sectionResult.data.location).toBe("Paris, Île-de-France, France");
    expect(sectionResult.data.coverage).toBe("forecast");
    expect(sectionResult.data.provider).toBe("open-meteo");
    expect(sectionResult.data.days).toHaveLength(2);
    expect(sectionResult.data.days[0]).toMatchObject({
      date: "2026-10-05",
      minC: 10,
      maxC: 18,
      condition: "Light rain",
      precipMm: 0.2,
      windKmph: 14,
    });
    expect(sectionResult.data.days[1].condition).toBe("Clear");
    await app.close();
  });

  it("flags travel dates beyond the forecast horizon", async () => {
    const app = await server();
    const body = await send(app, {
      section: "weather",
      sharedContext: {
        destination: "Paris",
        startDate: "2026-12-01",
        travelers: 1,
        interests: [],
      },
    });
    const { sectionResult } = body.result;
    expect(sectionResult.data.coverage).toBe("outside-forecast");
    expect(sectionResult.data.disclaimers.join(" ")).toContain("beyond the available forecast");
    await app.close();
  });

  it("falls back to the wttr provider when open-meteo fails", async () => {
    stubFetch((url) => {
      if (url.includes("geocoding-api.open-meteo.com")) return json({ error: true }, 500);
      if (url.includes("wttr.in") || url.includes("wttr.is")) return json(wttrPayload);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const app = await server();
    const body = await send(app, {
      section: "weather",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
    });
    expect(body.error).toBeUndefined();
    const { sectionResult } = body.result;
    expect(sectionResult.status).toBe("completed");
    expect(sectionResult.data.provider).toBe("wttr");
    expect(sectionResult.data.location).toBe("Paris");
    expect(sectionResult.data.days[0].condition).toBe("Partly cloudy");
    await app.close();
  });

  it("honours a single-provider WEATHER_PROVIDERS selection", async () => {
    vi.stubEnv("WEATHER_PROVIDERS", "wttr");
    const app = await server();
    const body = await send(app, {
      section: "weather",
      sharedContext: { destination: "Paris", travelers: 1, interests: [] },
    });
    expect(body.error).toBeUndefined();
    expect(body.result.sectionResult.data.provider).toBe("wttr");
    await app.close();
  });

  it("fails the section when the geocoder matches nothing", async () => {
    vi.stubEnv("WEATHER_PROVIDERS", "open-meteo");
    stubFetch((url) => {
      if (url.includes("geocoding-api.open-meteo.com")) return json({ generationtime_ms: 1 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const app = await server();
    const body = await send(app, {
      section: "weather",
      sharedContext: { destination: "Nowhere", travelers: 1, interests: [] },
    });
    expect(body.error).toBeDefined();
    expect(body.error.data.code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(body.error.data.retryable).toBe(false);
    expect(body.error.message).toContain("no location matched");
    await app.close();
  });

  it("returns an unknown method error for unsupported RPC methods", async () => {
    const app = await server();
    const res = await app.inject({
      method: "POST",
      url: "/",
      payload: { jsonrpc: "2.0", id: 9, method: "does/not/exist", params: {} },
    });
    expect(JSON.parse(res.body).error.code).toBe(-32601);
    await app.close();
  });
});
