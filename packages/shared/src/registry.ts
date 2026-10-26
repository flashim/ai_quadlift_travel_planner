import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const registryEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case agent name"),
  baseUrl: z.string().url(),
  sections: z.array(z.string().min(1)).min(1),
  required: z.boolean().default(false),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(15_000),
  /**
   * Skip this agent's sections when the plan input has no truthy value for this key —
   * how an optional, opt-in agent (HR, §17.5) stays out of every plan the user did
   * not ask for, without the orchestrator hardcoding a section name.
   */
  requiresField: z.string().min(1).optional(),
  /**
   * When this agent's section fails, push the reason into `PlanState.errors` so it
   * reaches `itinerary.warnings` (§17.5: "unable to connect" must be said in the
   * summary). Absent ⇒ failures are recorded on the section only, as before.
   */
  warnOnFailure: z.boolean().default(false),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

export const registryFileSchema = z.object({
  version: z.number().int().positive(),
  agents: z.array(registryEntrySchema),
});

export interface AgentRegistry {
  version: number;
  agents: RegistryEntry[];
}

/** Environment variable that overrides an agent's baseUrl (compose service DNS, §3.2). */
export function baseUrlEnvVar(name: string): string {
  return `AGENT_${name.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
}

/**
 * Resolve a relative registry path (default `config/agents.json` or an
 * explicit `AGENTS_REGISTRY_PATH` from `.env`) by walking up from cwd: the
 * shared `.env` uses a repo-root-relative path, but npm runs workspace
 * scripts with cwd `apps/*`, so a plain `resolve()` from cwd would miss it.
 * Absolute paths (e.g. Docker's `/app/config/agents.json`) are used as-is.
 */
function locateRegistryPath(path: string): string {
  if (isAbsolute(path)) return path;
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, path);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(path);
}

export function loadRegistry(
  path = process.env.AGENTS_REGISTRY_PATH ?? "config/agents.json",
): AgentRegistry {
  const file = locateRegistryPath(path);
  if (!existsSync(file)) {
    throw new Error(
      `Agent registry not found at ${file}. Set AGENTS_REGISTRY_PATH or run from the repo root.`,
    );
  }
  const raw = readFileSync(file, "utf8");
  const parsed = registryFileSchema.parse(JSON.parse(raw));
  const agents = parsed.agents.map((entry) => {
    const override = process.env[baseUrlEnvVar(entry.name)];
    return override ? { ...entry, baseUrl: override.replace(/\/+$/, "") } : entry;
  });
  assertUniqueNames(agents);
  return { version: parsed.version, agents };
}

export function enabledAgents(registry: AgentRegistry): RegistryEntry[] {
  return registry.agents.filter((a) => a.enabled);
}

/** Sections that the registry can fill, mapped to their agent entry. */
export function sectionProviders(registry: AgentRegistry): Map<string, RegistryEntry> {
  const map = new Map<string, RegistryEntry>();
  for (const agent of enabledAgents(registry)) {
    for (const section of agent.sections) {
      if (map.has(section)) {
        throw new Error(`Duplicate section "${section}" in agent registry`);
      }
      map.set(section, agent);
    }
  }
  return map;
}

function assertUniqueNames(agents: RegistryEntry[]): void {
  const seen = new Set<string>();
  for (const a of agents) {
    if (seen.has(a.name)) throw new Error(`Duplicate agent name in registry: ${a.name}`);
    seen.add(a.name);
  }
}
