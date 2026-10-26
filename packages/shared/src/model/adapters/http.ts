import { AppErrorCode, internalError } from "../../a2a/errors";

export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; provider: string; timeoutMs?: number },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // Compose, never displace: the caller's signal (cancel/plan deadline) AND the
  // per-request deadline must both apply (§6.1 "honor AbortSignal and the
  // request deadline"). `signal ?? timeout(...)` silently dropped the deadline
  // whenever a caller signal was present.
  const signal = opts.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
    : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const timedOut = (err as Error)?.name === "TimeoutError";
    throw internalError(
      timedOut ? AppErrorCode.AgentTimeout : AppErrorCode.ModelUnavailable,
      `${opts.provider}: ${timedOut ? "request timed out" : `cannot reach ${url}`}`,
      true,
      { provider: opts.provider },
    );
  }

  const text = await res.text();
  if (!res.ok) {
    const rateLimited = res.status === 429;
    throw internalError(
      rateLimited ? AppErrorCode.UpstreamRateLimited : AppErrorCode.ModelUnavailable,
      `${opts.provider}: HTTP ${res.status} ${truncate(text, 300)}`,
      rateLimited || res.status >= 500,
      { provider: opts.provider, status: res.status },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw internalError(
      AppErrorCode.UpstreamInvalidResponse,
      `${opts.provider}: non-JSON response`,
      false,
      { provider: opts.provider },
    );
  }
}

export function requireApiKey(key: string | undefined, provider: string): string {
  if (!key) {
    throw internalError(
      AppErrorCode.ModelUnavailable,
      `${provider}: API key not configured`,
      false,
      { provider },
    );
  }
  return key;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
