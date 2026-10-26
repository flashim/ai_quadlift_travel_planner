import type { ModelEnvConfig } from "./resolve";
import { readModelEnv } from "./resolve";

export interface CatalogGroup {
  provider: string;
  label: string;
  models: string[];
}

export interface ModelCatalog {
  groups: CatalogGroup[];
  configured: { provider: string; model: string };
}

const GROUP_LABELS: Record<string, string> = {
  groq: "Groq (cloud)",
  ollama: "Ollama (local)",
  openai: "OpenAI (cloud)",
  mock: "Mock (offline)",
};

const PROBE_TIMEOUT_MS = 2_500;

function label(provider: string): string {
  return GROUP_LABELS[provider] ?? provider;
}

function preferredFirst(models: string[], preferred?: string): string[] {
  if (!preferred) return models;
  return [preferred, ...models.filter((m) => m !== preferred)];
}

/**
 * Live model catalog for the UI selector (§6.1): Groq models from
 * `/models` when `GROQ_API_KEY` is set, local models from Ollama
 * `/api/tags`, and the offline mock. Probes are best-effort — on failure
 * each group degrades to its configured default instead of breaking the UI.
 */
export async function modelCatalog(
  env: ModelEnvConfig = readModelEnv(),
  raw: NodeJS.ProcessEnv = process.env,
): Promise<ModelCatalog> {
  const groups: CatalogGroup[] = [];

  if (raw.GROQ_API_KEY?.trim()) {
    const base = (raw.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
    let models: string[] = [];
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${raw.GROQ_API_KEY}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = (await res.json()) as { data?: { id?: string }[] };
      models = (body.data ?? [])
        .map((d) => d.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch {
      // unreachable — fall back to the configured model below
    }
    models = preferredFirst(models, env.groqModel ?? raw.GROQ_MODEL);
    if (models.length > 0) {
      groups.push({ provider: "groq", label: label("groq"), models });
    }
  }

  const ollamaBase = (raw.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
  let ollamaModels: string[] = [];
  try {
    const res = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = (await res.json()) as { models?: { name?: string }[] };
    ollamaModels = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    // Ollama not running — degraded below
  }
  if (ollamaModels.length === 0 && env.defaultProvider === "ollama") {
    ollamaModels = [env.defaultModel];
  }
  if (ollamaModels.length > 0) {
    const preferred = env.defaultProvider === "ollama" ? env.defaultModel : undefined;
    groups.push({ provider: "ollama", label: label("ollama"), models: preferredFirst(ollamaModels, preferred) });
  }

  groups.push({ provider: "mock", label: label("mock"), models: ["mock"] });

  return { groups, configured: { provider: env.defaultProvider, model: env.defaultModel } };
}
