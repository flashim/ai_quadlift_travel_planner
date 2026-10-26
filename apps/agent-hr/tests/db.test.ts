import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHrCatalog, resolveHrDbPath, seedHrDb } from "../src/db";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "travel-hr-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("employee database IO", () => {
  it("resolves the default path to <repoRoot>/data/hr.db, cwd-independent", () => {
    expect(resolveHrDbPath()).toMatch(/\/data\/hr\.db$/);
    expect(resolveHrDbPath("/abs/hr.db")).toBe("/abs/hr.db");
    expect(resolveHrDbPath(":memory:")).toBe(":memory:");
  });

  it("seeds idempotently and reopens the file", () => {
    const path = join(tempDir(), "hr.db");
    seedHrDb(path);
    seedHrDb(path);

    const catalog = openHrCatalog(path);
    expect(catalog.usable).toBe(true);
    expect(catalog.lookup("E0001")).toMatchObject({
      status: "found",
      employee: { employeeId: "E0001", name: "Ada Lovelace" },
    });
    catalog.close();

    const again = openHrCatalog(path);
    expect(again.usable).toBe(true);
    again.close();
  });

  it("looks up by id first, then by a unique name", () => {
    const catalog = openHrCatalog(":memory:");
    expect(catalog.usable).toBe(true);

    expect(catalog.lookup(" e0002 ")).toMatchObject({
      status: "found",
      employee: { employeeId: "E0002", department: "Engineering" },
    });
    // no id → unique name fallback
    expect(catalog.lookup(undefined, "Grace Hopper")).toMatchObject({
      status: "found",
      employee: { employeeId: "E0002" },
    });
    // id wins over a conflicting name
    expect(catalog.lookup("E0003", "Grace Hopper")).toMatchObject({
      status: "found",
      employee: { employeeId: "E0003" },
    });
    catalog.close();
  });

  it("reports unknown and ambiguous identifiers instead of guessing", () => {
    const catalog = openHrCatalog(":memory:");

    const missing = catalog.lookup("E9999");
    expect(missing.status).toBe("not-found");
    if (missing.status === "not-found") expect(missing.detail).toContain("E9999");

    expect(catalog.lookup(undefined, "Nobody Here")).toMatchObject({ status: "not-found" });

    const ambiguous = catalog.lookup(undefined, "Ada Lovelace");
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.detail).toContain("supply an employee id");
    }

    expect(catalog.lookup()).toMatchObject({ status: "not-found" });
    catalog.close();
  });

  it("serves from a read-only connection so HR records cannot be mutated", () => {
    const path = join(tempDir(), "hr.db");
    seedHrDb(path);
    const catalog = openHrCatalog(path);
    expect(catalog.usable).toBe(true);

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (p: string, o?: { readOnly: boolean }) => {
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const readOnly = new DatabaseSync(path, { readOnly: true });
    expect(() =>
      readOnly.prepare("UPDATE employees SET used_days = 0").run(),
    ).toThrow(/read.?only/i);
    readOnly.close();
    catalog.close();
  });

  it("returns an unusable handle instead of throwing when the path cannot be created", () => {
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "not a directory");

    const catalog = openHrCatalog(join(blocker, "hr.db"));
    expect(catalog.usable).toBe(false);
    expect(catalog.error).toBeTruthy();
    expect(() => catalog.lookup("E0001")).toThrow();
    expect(() => catalog.close()).not.toThrow();
  });
});
