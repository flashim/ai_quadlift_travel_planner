import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCatalog, resolveCostDbPath, seedCostDb } from "../src/db";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "travel-costs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("cost catalog IO", () => {
  it("resolves the default path to <repoRoot>/data/costs.db, cwd-independent", () => {
    expect(resolveCostDbPath()).toMatch(/\/data\/costs\.db$/);
    expect(resolveCostDbPath("/abs/costs.db")).toBe("/abs/costs.db");
    expect(resolveCostDbPath(":memory:")).toBe(":memory:");
  });

  it("seeds idempotently and reopens the file", () => {
    const path = join(tempDir(), "costs.db");
    seedCostDb(path);
    seedCostDb(path);

    const catalog = openCatalog(path);
    expect(catalog.usable).toBe(true);
    expect(catalog.lookup("Paris")).toMatchObject({ location: "paris", matched: true });
    catalog.close();

    const again = openCatalog(path);
    expect(again.usable).toBe(true);
    again.close();
  });

  it("matches by exact key, whole-token containment, then the default row", () => {
    const catalog = openCatalog(":memory:");
    expect(catalog.usable).toBe(true);
    expect(catalog.lookup("  TOKYO  ")).toMatchObject({ location: "tokyo", matched: true });
    expect(catalog.lookup("New York City")).toMatchObject({ location: "new york", matched: true });
    expect(catalog.lookup("Bali, Indonesia")).toMatchObject({ location: "bali", matched: true });
    expect(catalog.lookup("Amsterdam, Netherlands")).toMatchObject({
      location: "amsterdam",
      matched: true,
    });
    // whole-token boundary: "rome" inside "Chrome" must not match
    expect(catalog.lookup("The Chrome City")).toMatchObject({ location: "default", matched: false });
    expect(catalog.lookup("Kyoto, Japan")).toMatchObject({ location: "default", matched: false });
    catalog.close();
  });

  it("serves from a read-only connection so the catalog cannot be mutated", () => {
    const path = join(tempDir(), "costs.db");
    seedCostDb(path);
    const catalog = openCatalog(path);
    expect(catalog.usable).toBe(true);

    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (p: string, o?: { readOnly: boolean }) => {
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const readOnly = new DatabaseSync(path, { readOnly: true });
    expect(() => readOnly.prepare("UPDATE costs SET hotel = 0").run()).toThrow(/read.?only/i);
    readOnly.close();
    catalog.close();
  });

  it("returns an unusable handle instead of throwing when the path cannot be created", () => {
    const blocker = join(tempDir(), "blocker");
    writeFileSync(blocker, "not a directory");

    const catalog = openCatalog(join(blocker, "costs.db"));
    expect(catalog.usable).toBe(false);
    expect(catalog.error).toBeTruthy();
    expect(() => catalog.lookup("Paris")).toThrow();
    expect(() => catalog.close()).not.toThrow();
  });
});
