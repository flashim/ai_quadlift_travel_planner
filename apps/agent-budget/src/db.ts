import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { internalError, AppErrorCode } from "@travel/shared";
import { COST_DB, DEFAULT_KEY, exactKey, paddedKey, type CostProfile } from "./catalog";

/**
 * Cost catalog IO (§17.4).
 *
 * `node:sqlite` is loaded lazily through `createRequire` — bundlers (and Vite's SSR
 * pipeline, which does not list `node:sqlite` as a builtin) only rewrite static and
 * dynamic `import()`, so this reaches Node's real loader — and every failure path
 * returns an unusable handle instead of throwing: the budget agent MUST start and
 * answer with a failed section rather than exit, because `concurrently -k` would take
 * the whole dev stack down with it. A broken catalog reports `/health: degraded` and
 * the section fails; the plan still completes (§12 optional-section tolerance).
 */

const nodeRequire = createRequire(import.meta.url);

interface CostRow {
  location: string;
  hotel: number;
  food: number;
  transport: number;
  activities: number;
  currency: string;
  fx: number;
}

export interface LookupResult {
  /** Catalog key that was matched (or `"default"`). */
  location: string;
  /** `false` when no row matched and the default profile was used. */
  matched: boolean;
  profile: CostProfile;
}

export interface CatalogHandle {
  path: string;
  usable: boolean;
  /** Why the catalog is unusable, when it is. */
  error?: string;
  lookup(destination: string): LookupResult;
  close(): void;
}

/** `<repoRoot>/data/costs.db`, or `COST_DB_PATH` (relative paths resolve from the repo root). */
export function resolveCostDbPath(envValue?: string): string {
  const raw = envValue ?? process.env.COST_DB_PATH ?? "";
  if (!raw) return join(repoRoot(), "data", "costs.db");
  if (raw === ":memory:") return raw;
  return isAbsolute(raw) ? raw : resolve(repoRoot(), raw);
}

/** `apps/agent-budget/src/db.ts` → the checkout root, independent of `process.cwd()`. */
function repoRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unusable(path: string, error: string): CatalogHandle {
  return {
    path,
    usable: false,
    error,
    lookup(destination: string): LookupResult {
      throw internalError(AppErrorCode.Internal, `cost catalog unavailable: ${error}`, false, {
        destination,
      });
    },
    close: () => {},
  };
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS costs (
    location TEXT PRIMARY KEY,
    hotel REAL NOT NULL,
    food REAL NOT NULL,
    transport REAL NOT NULL,
    activities REAL NOT NULL,
    currency TEXT NOT NULL,
    fx REAL NOT NULL
  )
`;

function seed(db: DatabaseSync): void {
  db.exec(CREATE_SQL);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM costs`).get() as { n?: number } | undefined;
  if ((count?.n ?? 0) > 0) return;
  const insert: StatementSync = db.prepare(
    `INSERT INTO costs (location, hotel, food, transport, activities, currency, fx)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [key, p] of Object.entries(COST_DB)) {
    insert.run(key, p.hotel, p.food, p.transport, p.activities, p.currency, p.fx);
  }
}

/** Create/populate `costs.db` if it is missing. Used by `src/seed.ts` and on startup. */
export function seedCostDb(path = resolveCostDbPath()): void {
  const Db = loadDatabaseSync();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Db(path);
  try {
    seed(db);
  } finally {
    db.close();
  }
}

/** Loads `node:sqlite`, or throws with a message naming the requirement. */
function loadDatabaseSync(): typeof DatabaseSync {
  try {
    return (nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  } catch (err) {
    throw new Error(
      `node:sqlite unavailable (${message(err)}) — Node 24+ is required for the cost catalog`,
    );
  }
}

/**
 * Open the catalog. The returned handle is always safe to use: when `usable` is
 * false, `lookup()` throws a non-retryable `INTERNAL` error and `/health` reports
 * `degraded`, but the process keeps running.
 */
export function openCatalog(explicitPath?: string): CatalogHandle {
  const path = resolveCostDbPath(explicitPath);

  let Db: typeof DatabaseSync;
  try {
    Db = loadDatabaseSync();
  } catch (err) {
    return unusable(path, message(err));
  }

  let db: DatabaseSync;
  try {
    if (path === ":memory:") {
      db = new Db(path);
      seed(db);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      const writer = new Db(path);
      try {
        seed(writer);
      } finally {
        writer.close();
      }
      // Read-only from here on: the agent must never mutate the catalog (§17.4).
      db = new Db(path, { readOnly: true });
    }
  } catch (err) {
    return unusable(path, `cannot open cost catalog: ${message(err)}`);
  }

  const handle: CatalogHandle = {
    path,
    usable: true,
    lookup(destination: string): LookupResult {
      try {
        return lookupRow(db, destination);
      } catch (err) {
        throw internalError(
          AppErrorCode.Internal,
          `cost catalog lookup failed: ${message(err)}`,
          false,
          { destination },
        );
      }
    },
    close(): void {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
  return handle;
}

/**
 * Three-rung match ladder, in SQL: exact key → catalog key appearing as a whole
 * token of the destination → the `default` row.
 */
function lookupRow(db: DatabaseSync, destination: string): LookupResult {
  const exact = db
    .prepare(`SELECT * FROM costs WHERE lower(location) = ?`)
    .get(exactKey(destination)) as CostRow | undefined;
  if (exact) return toResult(exact, true);

  const partial = db
    .prepare(
      `SELECT * FROM costs
       WHERE location <> ?
         AND instr(?, ' ' || location || ' ') > 0
       ORDER BY length(location) DESC
       LIMIT 1`,
    )
    .get(DEFAULT_KEY, paddedKey(destination)) as CostRow | undefined;
  if (partial) return toResult(partial, true);

  const fallback = db
    .prepare(`SELECT * FROM costs WHERE location = ?`)
    .get(DEFAULT_KEY) as CostRow | undefined;
  if (!fallback) throw new Error(`cost catalog has no "${DEFAULT_KEY}" row`);
  return toResult(fallback, false);
}

function toResult(row: CostRow, matched: boolean): LookupResult {
  return {
    location: row.location,
    matched,
    profile: {
      hotel: row.hotel,
      food: row.food,
      transport: row.transport,
      activities: row.activities,
      currency: row.currency,
      fx: row.fx,
    },
  };
}
