import type { SharedContext } from "./schemas/plan";

/**
 * Trip length in days — the single source of truth for the orchestrator's day grid
 * (§17.1 `computeDuration`) and the budget agent's pricing (§17.4). Both sides call
 * this module so the rendered itinerary and the cost estimate can never disagree.
 *
 * Precedence: parsed dates → original input dates → query text → 3 (with a
 * disclaimer at the call site when `source === "default"`).
 */

/** The subset of `PlanInput` trip length depends on. */
export interface DurationInput {
  query?: string;
  startDate?: string;
  endDate?: string;
}

export type DurationSource = "parsed-dates" | "input-dates" | "query" | "default";

/** Fallback when no dates and no stated duration could be derived (callers must warn). */
export const DEFAULT_DURATION_DAYS = 3;

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

/** Longest trip the day grid and the budget catalog can price (mirrored by the UI preflight). */
export const TRIP_MAX_DAYS = 30;

/** Duration stated in free text ("5 days", "five days"), 1..30, else `undefined`. */
export function durationFromQuery(query: string): number | undefined {
  const match = query.match(/\b(\d{1,2})\s*(?:-|\s)?\s*days?\b/i);
  if (match) {
    const days = Number.parseInt(match[1]!, 10);
    if (days >= 1 && days <= TRIP_MAX_DAYS) return days;
  }
  const word = query.match(/\b([a-z]+)\s+days?\b/i);
  if (word) {
    const days = WORD_NUMBERS[word[1]!.toLowerCase()];
    if (days && days <= TRIP_MAX_DAYS) return days;
  }
  return undefined;
}

/** Trip length from a pair of ISO dates, else `undefined`. */
export function durationFromDates(startDate?: string, endDate?: string): number | undefined {
  if (!startDate || !endDate) return undefined;
  const from = Date.parse(startDate);
  const to = Date.parse(endDate);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  const days = Math.round((to - from) / 86_400_000) + 1;
  return days >= 1 && days <= TRIP_MAX_DAYS ? days : undefined;
}

/**
 * Trip length plus where it came from, so callers that fall back to the default can
 * warn the user (the budget agent prices a default-length trip only with a disclaimer).
 */
export function resolveDuration(
  input: DurationInput,
  ctx?: SharedContext,
): { days: number; source: DurationSource } {
  const parsed = durationFromDates(ctx?.startDate, ctx?.endDate);
  if (parsed !== undefined) return { days: parsed, source: "parsed-dates" };
  const original = durationFromDates(input.startDate, input.endDate);
  if (original !== undefined) return { days: original, source: "input-dates" };
  const stated = durationFromQuery(input.query ?? "");
  if (stated !== undefined) return { days: stated, source: "query" };
  return { days: DEFAULT_DURATION_DAYS, source: "default" };
}

/**
 * Trip length in days.
 * `ctx` is the query-parsing output (§17.1); `input` is the original user request,
 * kept as the fallback so a duration stated in the query survives even when no
 * explicit dates were parsed.
 */
export function durationDays(input: DurationInput, ctx?: SharedContext): number {
  return resolveDuration(input, ctx).days;
}
