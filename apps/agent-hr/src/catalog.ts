/**
 * Synthetic employee leave-balance records (§17.5).
 *
 * This is the source of truth that `src/db.ts` seeds into `<repo>/data/hr.db`.
 * Days are whole days of annual leave; `usedDays` counts already-taken days, so
 * `remainingDays = entitlementDays - usedDays` is the balance a trip must fit in.
 */

export interface EmployeeRecord {
  /** Canonical employee number, format `E` + 4 digits. */
  employeeId: string;
  name: string;
  department: string;
  /** Contracted annual entitlement in days. */
  entitlementDays: number;
  /** Days already taken this year. */
  usedDays: number;
}

export const EMPLOYEE_DB: Record<string, EmployeeRecord> = {
  E0001: {
    employeeId: "E0001",
    name: "Ada Lovelace",
    department: "Engineering",
    entitlementDays: 25,
    usedDays: 5,
  },
  E0002: {
    employeeId: "E0002",
    name: "Grace Hopper",
    department: "Engineering",
    entitlementDays: 20,
    usedDays: 18,
  },
  E0003: {
    employeeId: "E0003",
    name: "Alan Turing",
    department: "Research",
    entitlementDays: 30,
    usedDays: 0,
  },
  E0004: {
    employeeId: "E0004",
    name: "Katherine Johnson",
    department: "Analytics",
    entitlementDays: 25,
    usedDays: 20,
  },
  E0005: {
    employeeId: "E0005",
    name: "Margaret Hamilton",
    department: "Engineering",
    entitlementDays: 22,
    usedDays: 4,
  },
  E0006: {
    employeeId: "E0006",
    name: "Radia Perlman",
    department: "Infrastructure",
    entitlementDays: 25,
    usedDays: 12,
  },
  E0007: {
    employeeId: "E0007",
    name: "Barbara Liskov",
    department: "Research",
    entitlementDays: 28,
    usedDays: 26,
  },
  E0008: {
    employeeId: "E0008",
    name: "Jean Bartik",
    department: "Support",
    entitlementDays: 20,
    usedDays: 7,
  },
  E0009: {
    employeeId: "E0009",
    name: "Frances Allen",
    department: "Analytics",
    entitlementDays: 25,
    usedDays: 15,
  },
  E0010: {
    employeeId: "E0010",
    name: "Shafi Goldwasser",
    department: "Research",
    entitlementDays: 30,
    usedDays: 9,
  },
  E0011: {
    employeeId: "E0011",
    name: "Karen Spärck Jones",
    department: "Support",
    entitlementDays: 18,
    usedDays: 18,
  },
  E0012: {
    employeeId: "E0012",
    name: "Sophie Wilson",
    department: "Infrastructure",
    entitlementDays: 26,
    usedDays: 3,
  },
  // Deliberate name collision: proves why the id is the mandatory key and a bare
  // name can only be a fallback (the agent answers `ambiguous`, never guesses).
  E0013: {
    employeeId: "E0013",
    name: "Ada Lovelace",
    department: "Data Platform",
    entitlementDays: 24,
    usedDays: 6,
  },
};

/** Days still available on the record's annual entitlement. */
export function remainingDays(employee: EmployeeRecord): number {
  return employee.entitlementDays - employee.usedDays;
}

/** Canonical form of a user-supplied employee number (` e0001 ` → `E0001`). */
export function normalizeEmployeeId(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
