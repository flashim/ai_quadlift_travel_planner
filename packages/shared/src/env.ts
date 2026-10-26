import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function findEnvFile(explicit: string): string | null {
  const direct = resolve(explicit);
  if (explicit !== ".env") return existsSync(direct) ? direct : null;
  // `.env` may live at the repo root even when cwd is a workspace dir
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Minimal `.env` loader (no dependency): KEY=VALUE lines, `#` comments,
 * optional quotes. Existing process env always wins, and missing files are
 * ignored, so `cp .env.example .env` is optional — defaults must suffice.
 */
export function loadEnv(path = process.env.ENV_FILE ?? ".env"): void {
  const file = findEnvFile(path);
  if (!file) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
