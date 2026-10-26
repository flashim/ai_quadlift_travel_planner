import { z } from "zod";
import { AppErrorCode, internalError, RpcError } from "../a2a/errors";

/** §6.2 shared upstream HTTP layer: 60-minute cache for validated payloads. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 9_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 200;
/** Do not start an attempt (or sleep) with less than this budget left. */
const MIN_SLICE_MS = 500;

interface CacheEntry {
  expiresAt: number;
  payload: unknown;
}

const cache = new Map<string, CacheEntry>();

export function clearForecastCache(): void {
  cache.clear();
}

export interface FetchJsonOptions {
  /** Registry name — used in error messages and details. */
  provider: string;
  userAgent: string;
  /** §6.2 SSRF guard: only these hosts may be contacted (host or host:port form). */
  allowedHosts: readonly string[];
  /** Total budget for this call, shared across attempts + backoff (defaults 9 s). */
  timeoutMs?: number;
  /** Composed with the per-request deadline; never displaced (§6.2). */
  signal?: AbortSignal;
  /** Cache key; defaults to the URL. Pass a normalized location key (§17.3). */
  cacheKey?: string;
  cacheTtlMs?: number;
  /** Upper bound on attempts; the time budget may cut this shorter (§6.2). */
  maxAttempts?: number;
  backoffBaseMs?: number;
  /** Zod schema — a payload only enters the cache once it validates (§6.2). */
  schema?: z.ZodType;
}

/**
 * GET JSON with the §6.2 guarantees: host allowlist, request timeout composed
 * with the caller's AbortSignal, bounded retries with exponential backoff on
 * 429/5xx/transient errors, response caching, and Zod validation upstream.
 * `timeoutMs` is a total budget shared by every attempt (mirrors the model
 * router's deadline slicing), so the caller's section deadline is never blown.
 */
export async function fetchJson(url: string, opts: FetchJsonOptions): Promise<unknown> {
  const provider = opts.provider;
  assertAllowedHost(url, opts.allowedHosts, provider);

  const key = opts.cacheKey ?? url;
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.payload;
    cache.delete(key);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  let lastError: RpcError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining < MIN_SLICE_MS) break;

    if (attempt > 1) {
      const backoffMs = backoffBaseMs * 2 ** (attempt - 2);
      try {
        await sleep(Math.min(backoffMs, remaining), opts.signal);
      } catch {
        throw internalError(
          AppErrorCode.PlanCancelled,
          `${provider}: cancelled during retry backoff`,
          false,
          { provider },
        );
      }
    }

    const slice = deadlineAt - Date.now();
    if (slice < MIN_SLICE_MS) break;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": opts.userAgent },
        signal: opts.signal
          ? AbortSignal.any([AbortSignal.timeout(slice), opts.signal])
          : AbortSignal.timeout(slice),
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        throw internalError(
          AppErrorCode.PlanCancelled,
          `${provider}: request cancelled`,
          false,
          { provider },
        );
      }
      const timedOut = (err as Error)?.name === "TimeoutError";
      lastError = internalError(
        timedOut ? AppErrorCode.AgentTimeout : AppErrorCode.AgentUnreachable,
        `${provider}: ${timedOut ? "timed out" : "unreachable"} for ${url}`,
        true,
        { provider },
      );
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastError = internalError(
        res.status === 429 ? AppErrorCode.UpstreamRateLimited : AppErrorCode.UpstreamInvalidResponse,
        `${provider}: HTTP ${res.status} for ${url}`,
        true,
        { provider, status: res.status },
      );
      continue;
    }
    if (!res.ok) {
      throw internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `${provider}: HTTP ${res.status} for ${url}`,
        false,
        { provider, status: res.status },
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      lastError = internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `${provider}: non-JSON response from ${url}`,
        true,
        { provider },
      );
      continue;
    }

    if (opts.schema) {
      const parsed = opts.schema.safeParse(payload);
      if (!parsed.success) {
        lastError = internalError(
          AppErrorCode.UpstreamInvalidResponse,
          `${provider}: unexpected payload from ${url}`,
          true,
          { provider },
        );
        continue;
      }
      payload = parsed.data;
    }

    cache.set(key, { expiresAt: Date.now() + (opts.cacheTtlMs ?? CACHE_TTL_MS), payload });
    return payload;
  }

  throw lastError ?? internalError(
    AppErrorCode.UpstreamInvalidResponse,
    `${provider}: budget exhausted before a successful response for ${url}`,
    true,
    { provider },
  );
}

/** §6.2 SSRF guard — the fetch layer refuses anything outside the allowlist. */
export function assertAllowedHost(url: string, allowedHosts: readonly string[], provider: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw internalError(
      AppErrorCode.UpstreamInvalidResponse,
      `${provider}: invalid upstream URL`,
      false,
      { provider },
    );
  }
  const allowed = allowedHosts.includes(parsed.host) || allowedHosts.includes(parsed.hostname);
  if (!allowed) {
    throw internalError(
      AppErrorCode.UpstreamInvalidResponse,
      `${provider}: host "${parsed.host}" is not in the allowlist`,
      false,
      { provider, host: parsed.host },
    );
  }
}

/** Hostnames (no path) of the given absolute URLs — feed fetchJson allowlist. */
export function hostsOf(...urls: string[]): string[] {
  return [...new Set(urls.map((u) => new URL(u).host))];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
