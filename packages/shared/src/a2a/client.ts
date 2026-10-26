import { z } from "zod";
import { agentCardSchema, type AgentCard } from "../schemas/agent-card";
import type { RpcResponse } from "../schemas/rpc";
import { AppErrorCode, RpcError, internalError } from "./errors";

export interface CallOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function rpcCall<T = unknown>(
  baseUrl: string,
  method: string,
  params: unknown,
  opts: CallOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Compose, never displace: caller signal (cancel/plan deadline) AND the
  // per-call timeout must both apply. `signal ?? AbortSignal.timeout(...)`
  // dropped the section deadline whenever the workflow passed its plan signal.
  const signal = opts.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), opts.signal])
    : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, "/"), {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
      signal,
    });
  } catch (err) {
    const timedOut = (err as Error)?.name === "TimeoutError" || signal.aborted;
    throw internalError(
      timedOut ? AppErrorCode.AgentTimeout : AppErrorCode.AgentUnreachable,
      timedOut ? `Agent timed out after ${timeoutMs}ms: ${baseUrl}` : `Agent unreachable: ${baseUrl}`,
      true,
      { baseUrl, method },
    );
  }

  if (!res.ok) {
    throw internalError(
      AppErrorCode.AgentUnreachable,
      `Agent returned HTTP ${res.status}: ${baseUrl}`,
      res.status >= 500,
      { baseUrl, method, status: res.status },
    );
  }

  let body: RpcResponse;
  try {
    body = (await res.json()) as RpcResponse;
  } catch {
    throw internalError(
      AppErrorCode.UpstreamInvalidResponse,
      `Agent returned non-JSON response: ${baseUrl}`,
      false,
      { baseUrl, method },
    );
  }

  if ("error" in body) {
    const data = body.error.data ?? {};
    const code =
      typeof data.code === "string" ? data.code : AppErrorCode.Internal;
    throw new RpcError(body.error.code, body.error.message, {
      ...data,
      code,
      retryable: data.retryable === true,
    });
  }
  return body.result as T;
}

export async function fetchAgentCard(baseUrl: string, opts: CallOptions = {}): Promise<AgentCard> {
  let lastError: unknown;
  for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
    try {
      const res = await fetch(joinUrl(baseUrl, path), {
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 5_000),
        headers: opts.headers,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const parsed = agentCardSchema.safeParse(json);
      if (parsed.success) return parsed.data;
      lastError = internalError(
        AppErrorCode.UpstreamInvalidResponse,
        `Invalid agent card at ${baseUrl}${path}`,
        false,
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw (
    lastError ??
    internalError(AppErrorCode.AgentUnreachable, `No agent card at ${baseUrl}`, true)
  );
}

export async function fetchHealth(
  baseUrl: string,
  opts: CallOptions = {},
): Promise<{ status: string; version?: string; uptimeSec?: number }> {
  const res = await fetch(joinUrl(baseUrl, "/health"), {
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    headers: opts.headers,
  });
  if (!res.ok) {
    throw internalError(
      AppErrorCode.AgentUnreachable,
      `Health check failed (${res.status}): ${baseUrl}`,
      true,
    );
  }
  return z
    .object({
      status: z.string(),
      version: z.string().optional(),
      uptimeSec: z.number().optional(),
    })
    .parse(await res.json());
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}
