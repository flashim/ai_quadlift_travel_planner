export interface ForecastDay {
  date: string;
  minC: number;
  maxC: number;
  condition: string;
  precipMm?: number;
  windKmph?: number;
}

export interface Forecast {
  /** Resolved place name (geocoded or upstream-provided). */
  location: string;
  days: ForecastDay[];
  asOf: string;
  /** Registry name of the provider that answered ("open-meteo" | "openweather" | "tomorrow" | "wttr"). */
  provider: string;
}

export interface FetchForecastOptions {
  userAgent: string;
  timeoutMs?: number;
  /** Composed with the per-request deadline; never displaced (§6.2). */
  signal?: AbortSignal;
}

/** §6.2 external data adapter: one weather upstream behind a common interface. */
export interface WeatherProvider {
  readonly name: string;
  /** Env var that must hold an API key for this provider to run (§17.3). When
   *  unset, the registry skips the provider gracefully instead of failing. */
  readonly requiredEnv?: string;
  forecast(location: string, opts: FetchForecastOptions): Promise<Forecast>;
}

/** A provider the configured chain names but cannot run (missing key, etc.). */
export interface SkippedProvider {
  name: string;
  reason: string;
}
