/**
 * The cost catalog: seeded reference rows (USD) plus the pricing arithmetic (§17.4).
 * Pure data and math — no IO and no model calls, so the budget section is
 * deterministic (§11 precedent: the weather agent is deterministic for the same
 * reason).
 */

export interface CostProfile {
  /** USD per room per night. */
  hotel: number;
  /** USD per person per day. */
  food: number;
  /** USD per person per day. */
  transport: number;
  /** USD per person per day. */
  activities: number;
  /** Currency of the destination, e.g. `EUR`. */
  currency: string;
  /** Local currency units per 1 USD (so `local = usd × fx`). */
  fx: number;
}

/** Seed rows written into `costs.db` on first start (see `src/seed.ts`). */
export const COST_DB: Record<string, CostProfile> = {
  paris: { hotel: 150, food: 60, transport: 20, activities: 40, currency: "EUR", fx: 0.92 },
  tokyo: { hotel: 120, food: 50, transport: 25, activities: 35, currency: "JPY", fx: 150 },
  "new york": { hotel: 220, food: 80, transport: 15, activities: 55, currency: "USD", fx: 1.0 },
  london: { hotel: 180, food: 65, transport: 20, activities: 45, currency: "GBP", fx: 0.79 },
  bali: { hotel: 60, food: 25, transport: 12, activities: 25, currency: "IDR", fx: 15600 },
  dubai: { hotel: 160, food: 70, transport: 18, activities: 50, currency: "AED", fx: 3.67 },
  singapore: { hotel: 140, food: 55, transport: 20, activities: 40, currency: "SGD", fx: 1.34 },
  rome: { hotel: 130, food: 55, transport: 15, activities: 35, currency: "EUR", fx: 0.92 },
  barcelona: { hotel: 120, food: 50, transport: 15, activities: 35, currency: "EUR", fx: 0.92 },
  amsterdam: { hotel: 145, food: 60, transport: 18, activities: 40, currency: "EUR", fx: 0.92 },
  /** Always present — the ladder's last rung when nothing else matches. */
  default: { hotel: 100, food: 45, transport: 18, activities: 30, currency: "USD", fx: 1.0 },
};

/** Fallback key used when no row matches the destination. */
export const DEFAULT_KEY = "default";

/** Exact-match key: trimmed and lowercased. */
export function exactKey(destination: string): string {
  return destination.trim().toLowerCase();
}

/**
 * Key for the containment rung: spaces at both ends so a catalog key only matches
 * on a whole-token boundary, commas flattened to spaces, inner runs collapsed.
 * `"new york city"` → `" new york city "` matches `" new york "`;
 * `"The Chrome City"` does **not** match `rome`.
 */
export function paddedKey(destination: string): string {
  const normalized = exactKey(destination).replace(/,/g, " ").replace(/\s+/g, " ");
  return ` ${normalized} `;
}

/** Money to two decimals, half away from zero. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface CostBreakdown {
  hotel: number;
  food: number;
  transport: number;
  activities: number;
  total: number;
}

export interface CostEstimate {
  usd: CostBreakdown;
  local: CostBreakdown;
}

/**
 * Whole-trip cost from a matched profile.
 * `hotel` is priced per night (nights = days − 1); food, transport and activities
 * are per person per day; everything scales by traveler count.
 */
export function estimateCost(
  profile: CostProfile,
  days: number,
  nights: number,
  travelers: number,
): CostEstimate {
  const usd = {
    hotel: roundMoney(profile.hotel * nights * travelers),
    food: roundMoney(profile.food * days * travelers),
    transport: roundMoney(profile.transport * days * travelers),
    activities: roundMoney(profile.activities * days * travelers),
    total: 0,
  };
  usd.total = roundMoney(usd.hotel + usd.food + usd.transport + usd.activities);

  const local = {
    hotel: roundMoney(usd.hotel * profile.fx),
    food: roundMoney(usd.food * profile.fx),
    transport: roundMoney(usd.transport * profile.fx),
    activities: roundMoney(usd.activities * profile.fx),
    total: 0,
  };
  local.total = roundMoney(local.hotel + local.food + local.transport + local.activities);

  return { usd, local };
}
