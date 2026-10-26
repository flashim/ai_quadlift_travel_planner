import { AppErrorCode, internalError } from "@travel/shared";
import { wikipedia } from "./wikipedia";
import { wikivoyage } from "./wikivoyage";
import type { KnowledgeProvider } from "./types";

/** All providers the agent can reach — also the tools' `source` enum (§17.2). */
const ALL: Record<string, KnowledgeProvider> = {
  wikivoyage,
  wikipedia,
};

/** Default research order: Wikivoyage first, Wikipedia as the fallback. */
const DEFAULT_CHAIN = ["wikivoyage", "wikipedia"];

/**
 * Knowledge source chain for this deployment (`KNOWLEDGE_PROVIDERS`).
 * Unknown names fail fast at startup — a typo must not silently disable a
 * research source (mirrors `WEATHER_PROVIDERS`, §17.2).
 */
export function knowledgeChain(env: NodeJS.ProcessEnv = process.env): KnowledgeProvider[] {
  const raw = env.KNOWLEDGE_PROVIDERS?.trim();
  const names = (raw && raw.length > 0 ? raw : DEFAULT_CHAIN.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !ALL[n]);
  if (unknown.length > 0) {
    throw internalError(
      AppErrorCode.InvalidParams,
      `Unknown KNOWLEDGE_PROVIDERS entries: ${unknown.join(", ")} (available: ${Object.keys(ALL).join(", ")})`,
      false,
    );
  }
  return [...new Set(names)].map((n) => ALL[n]!);
}

/** Resolve a model-provided `source` argument against the registry (§6.1). */
export function knowledgeProvider(name: string): KnowledgeProvider | undefined {
  return ALL[name];
}

/** Names offered as tool arguments — regenerated per deployment. */
export function knowledgeSourceNames(): string[] {
  return Object.keys(ALL);
}
