import { AppErrorCode, internalError } from "@travel/shared";
import { openMeteoProvider } from "./open-meteo";
import { openWeatherProvider } from "./openweathermap";
import { tomorrowProvider } from "./tomorrow";
import { wttrProvider } from "./wttr";
import type { FetchForecastOptions, Forecast, SkippedProvider, WeatherProvider } from "./types";

/** Name-keyed provider registry (§6.2) — adding a service = add it here. */
export const weatherProviderRegistry: Record<string, WeatherProvider> = {
  "open-meteo": openMeteoProvider,
  openweather: openWeatherProvider,
  tomorrow: tomorrowProvider,
  wttr: wttrProvider,
};

/** Configured fallback order: free keyless sources first, keyed ones in between. */
const DEFAULT_CHAIN = "open-meteo,openweather,tomorrow,wttr";
/** Providers with no credential requirement — used when every keyed one is skipped. */
const KEYLESS_CHAIN = "open-meteo,wttr";

export interface ChainReport {
  /** Providers that can actually run right now, in fallback order. */
  chain: WeatherProvider[];
  /** Named in the config but unusable (missing API key) — surface as a disclaimer. */
  skipped: SkippedProvider[];
  /** True when the configured chain had no runnable provider and the keyless
   *  defaults took over (§17.3 graceful degradation). */
  fallback: boolean;
}

function namesFrom(env: NodeJS.ProcessEnv): string[] {
  const raw = env.WEATHER_PROVIDERS ?? env.WEATHER_PROVIDER;
  const effective = (raw?.trim() || DEFAULT_CHAIN).toLowerCase();
  return [...new Set(effective.split(",").map((s) => s.trim()).filter(Boolean))];
}

function providerFor(name: string, raw: string): WeatherProvider {
  const provider = weatherProviderRegistry[name];
  if (!provider) {
    throw internalError(
      AppErrorCode.InvalidParams,
      `Unknown weather provider "${name}" (configured: ${raw}; available: ${Object.keys(weatherProviderRegistry).join(", ")})`,
      false,
      { provider: name },
    );
  }
  return provider;
}

function runnable(provider: WeatherProvider, env: NodeJS.ProcessEnv): boolean {
  if (!provider.requiredEnv) return true;
  return Boolean(env[provider.requiredEnv]?.trim());
}

/**
 * Configured provider chain: `WEATHER_PROVIDERS` (comma-separated fallback
 * order, first success wins — mirrors MODEL_FALLBACK_CHAIN) or the
 * `WEATHER_PROVIDER` single-provider alias.
 *
 * Unknown or empty chains fail fast (a typo must not silently disable a
 * provider). Named providers whose API key is missing are *skipped* with a
 * reason — and if that empties the chain, the keyless defaults take over so
 * the section still answers (§17.3 graceful degradation).
 */
export function resolveChainReport(env: NodeJS.ProcessEnv = process.env): ChainReport {
  const names = namesFrom(env);
  const raw = env.WEATHER_PROVIDERS ?? env.WEATHER_PROVIDER ?? DEFAULT_CHAIN;
  if (names.length === 0) {
    throw internalError(
      AppErrorCode.InvalidParams,
      "weather provider chain resolved to an empty list (WEATHER_PROVIDERS)",
      false,
    );
  }

  const skipped: SkippedProvider[] = [];
  const chain: WeatherProvider[] = [];
  for (const name of names) {
    const provider = providerFor(name, raw);
    if (runnable(provider, env)) {
      chain.push(provider);
    } else {
      skipped.push({
        name,
        reason: `missing ${provider.requiredEnv}`,
      });
    }
  }

  if (chain.length > 0) return { chain, skipped, fallback: false };

  // Everything that was configured needs a key we do not have — degrade to the
  // keyless pair rather than failing the section outright.
  const fallbackChain = KEYLESS_CHAIN.split(",")
    .map((name) => providerFor(name, KEYLESS_CHAIN))
    .filter((p) => !skipped.some((s) => s.name === p.name));
  if (fallbackChain.length === 0) {
    throw internalError(
      AppErrorCode.InvalidParams,
      `weather provider chain has no runnable provider (configured: ${raw}; skipped: ${skipped
        .map((s) => `${s.name} (${s.reason})`)
        .join(", ")})`,
      false,
    );
  }
  return { chain: fallbackChain, skipped, fallback: true };
}

/** Runnable providers only — the shape the card and legacy callers expect. */
export function resolveChain(env: NodeJS.ProcessEnv = process.env): WeatherProvider[] {
  return resolveChainReport(env).chain;
}

/**
 * Walk the configured chain with a shared time budget (§6.2): each provider
 * gets only what is left of `opts.timeoutMs`, so fallbacks never blow the
 * section deadline. Last error is rethrown once the chain is exhausted.
 */
export async function fetchForecast(
  location: string,
  opts: FetchForecastOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Forecast> {
  const { chain } = resolveChainReport(env);
  const budget = opts.timeoutMs ?? 9_000;
  const started = Date.now();
  const remaining = () => Math.max(500, budget - (Date.now() - started));
  let lastError: unknown;

  for (const provider of chain) {
    try {
      return await provider.forecast(location, { ...opts, timeoutMs: remaining() });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? internalError(
    AppErrorCode.UpstreamInvalidResponse,
    `weather unavailable for "${location}"`,
    true,
  );
}
