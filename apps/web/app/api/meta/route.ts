import { NextResponse } from "next/server";
import { loadEnv, modelCatalog, readModelEnv, type ModelCatalog } from "@travel/shared";

export const dynamic = "force-dynamic";

// Next resolves env files from apps/web; the repo-root .env is ours to load.
loadEnv();

// Groq/Ollama probes are network calls — cache the catalog for a minute so a
// page reload doesn't re-hit the providers.
let cache: { at: number; value: ModelCatalog } | null = null;
const CACHE_TTL_MS = 60_000;

/** Configured model layer (§6.1) + live model catalog for the UI selector. */
export async function GET(): Promise<Response> {
  const env = readModelEnv();
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    cache = { at: Date.now(), value: await modelCatalog(env) };
  }
  return NextResponse.json({
    provider: env.defaultProvider,
    model: env.defaultModel,
    roleOverrides: env.roleOverrides,
    fallbackChain: env.fallbackChain,
    timeoutMs: env.timeoutMs,
    groqModel: env.groqModel ?? null,
    catalog: cache.value,
  });
}
