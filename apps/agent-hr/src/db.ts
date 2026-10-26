import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { AppErrorCode, internalError } from "@travel/shared";
import {
  EMPLOYEE_DB,
  normalizeEmployeeId,
  normalizeName,
  type EmployeeRecord,
} from "./catalog";

/**
 * Employee leave-balance store (§17.5).
 *
 * Same discipline as the budget agent's catalog: `node:sqlite` is reached through
 * `createRequire` (Vite does not list `node:sqlite` as a builtin, so neither a
 * static nor a dynamic `import()` resolves it), every failure path hands back an
 * unusable handle instead of throwing, and the file is reopened read-only after
 * seeding. The agent MUST boot and answer with a failed section rather than exit —
 * `concurrently -k` would otherwise tear down the whole dev stack.
 */

const nodeRequire = createRequire(import.meta.url);

interface EmployeeRow {
  employee_id: string;
  name: string;
  department: string;
  entitlement_days: number;
  used_days: number;
}

export type LookupOutcome =
  | { status: "found"; employee: EmployeeRecord }
  | { status: "not-found"; detail: string }
  | { status: "ambiguous"; detail: string };

export interface HrCatalogHandle {
  path: string;
  usable: boolean;
  /** Why the catalog is unusable, when it is. */
  error?: string;
  lookup(employeeId?: string, employeeName?: string): LookupOutcome;
  close(): void;
}

/** `<repoRoot>/data/hr.db`, or `HR_DB_PATH` (relative paths resolve from the repo root). */
export function resolveHrDbPath(envValue?: string): string {
  const raw = envValue ?? process.env.HR_DB_PATH ?? "";
  if (!raw) return join(repoRoot(), "data", "hr.db");
  if (raw === ":memory:") return raw;
  return isAbsolute(raw) ? raw : resolve(repoRoot(), raw);
}

/** `apps/agent-hr/src/db.ts` → the checkout root, independent of `process.cwd()`. */
function repoRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unusable(path: string, error: string): HrCatalogHandle {
  return {
    path,
    usable: false,
    error,
    lookup(employeeId?: string, employeeName?: string): LookupOutcome {
      throw internalError(AppErrorCode.Internal, `employee database unavailable: ${error}`, false, {
        employeeId,
        employeeName,
      });
    },
    close: () => {},
  };
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS employees (
    employee_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    entitlement_days INTEGER NOT NULL,
    used_days INTEGER NOT NULL
  )
`;

function seed(db: DatabaseSync): void {
  db.exec(CREATE_SQL);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM employees`).get() as { n?: number } | undefined;
  if ((count?.n ?? 0) > 0) return;
  const insert: StatementSync = db.prepare(
    `INSERT INTO employees (employee_id, name, department, entitlement_days, used_days)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of Object.values(EMPLOYEE_DB)) {
    insert.run(row.employeeId, row.name, row.department, row.entitlementDays, row.usedDays);
  }
}

/** Create/populate `hr.db` if it is missing. Used by `src/seed.ts` and on startup. */
export function seedHrDb(path = resolveHrDbPath()): void {
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
      `node:sqlite unavailable (${message(err)}) — Node 24+ is required for the employee database`,
    );
  }
}

/**
 * Open the employee database. The handle is always safe to use: when `usable` is
 * false, `lookup()` throws a non-retryable `INTERNAL` error and `/health` reports
 * `degraded`, but the process keeps running.
 */
export function openHrCatalog(explicitPath?: string): HrCatalogHandle {
  const path = resolveHrDbPath(explicitPath);

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
      // Read-only from here on: the agent must never mutate HR records (§17.5).
      db = new Db(path, { readOnly: true });
    }
  } catch (err) {
    return unusable(path, `cannot open employee database: ${message(err)}`);
  }

  const handle: HrCatalogHandle = {
    path,
    usable: true,
    lookup(employeeId?: string, employeeName?: string): LookupOutcome {
      try {
        return lookupEmployee(db, employeeId, employeeName);
      } catch (err) {
        throw internalError(
          AppErrorCode.Internal,
          `employee database lookup failed: ${message(err)}`,
          false,
          { employeeId, employeeName },
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
 * `employeeId` wins when both are supplied; otherwise fall back to a name match.
 * Zero matches → `not-found`, more than one → `ambiguous` (never guess).
 */
function lookupEmployee(
  db: DatabaseSync,
  employeeId?: string,
  employeeName?: string,
): LookupOutcome {
  const id = employeeId ? normalizeEmployeeId(employeeId) : "";
  if (id) {
    const byId = db
      .prepare(`SELECT * FROM employees WHERE upper(employee_id) = ?`)
      .get(id) as EmployeeRow | undefined;
    if (byId) return { status: "found", employee: toRecord(byId) };
    return {
      status: "not-found",
      detail: `No employee record for "${id}".`,
    };
  }

  const name = employeeName ? normalizeName(employeeName) : "";
  if (!name) {
    return { status: "not-found", detail: "No employee id or name was supplied." };
  }

  const rows = db
    .prepare(`SELECT * FROM employees WHERE lower(trim(name)) = ? ORDER BY employee_id`)
    .all(name) as unknown as EmployeeRow[];
  const first = rows[0];
  if (rows.length === 1 && first) return { status: "found", employee: toRecord(first) };
  if (rows.length > 1) {
    return {
      status: "ambiguous",
      detail: `${rows.length} employees are named "${employeeName}"; supply an employee id instead.`,
    };
  }
  return { status: "not-found", detail: `No employee record for "${employeeName}".` };
}

function toRecord(row: EmployeeRow): EmployeeRecord {
  return {
    employeeId: row.employee_id,
    name: row.name,
    department: row.department,
    entitlementDays: row.entitlement_days,
    usedDays: row.used_days,
  };
}
