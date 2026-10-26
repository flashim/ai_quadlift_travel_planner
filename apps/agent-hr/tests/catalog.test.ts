import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_DB,
  normalizeEmployeeId,
  normalizeName,
  remainingDays,
} from "../src/catalog";

describe("employee catalog", () => {
  it("keys every record by a canonical employee id", () => {
    const ids = Object.keys(EMPLOYEE_DB);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    for (const id of ids) expect(id).toMatch(/^E\d{4}$/);
    for (const [key, row] of Object.entries(EMPLOYEE_DB)) expect(row.employeeId).toBe(key);
  });

  it("derives the remaining balance from the entitlement", () => {
    expect(remainingDays(EMPLOYEE_DB.E0001)).toBe(20); // 25 - 5
    expect(remainingDays(EMPLOYEE_DB.E0002)).toBe(2); // 20 - 18
    expect(remainingDays(EMPLOYEE_DB.E0003)).toBe(30); // 30 - 0
    expect(remainingDays(EMPLOYEE_DB.E0011)).toBe(0); // fully used
  });

  it("normalizes user-supplied identifiers", () => {
    expect(normalizeEmployeeId("  e0001 ")).toBe("E0001");
    expect(normalizeName("  Grace   Hopper ")).toBe("grace hopper");
  });

  it("contains a deliberate name collision so bare names cannot be trusted", () => {
    const named = Object.values(EMPLOYEE_DB).filter((e) => e.name === "Ada Lovelace");
    expect(named.map((e) => e.employeeId).sort()).toEqual(["E0001", "E0013"]);
  });
});
