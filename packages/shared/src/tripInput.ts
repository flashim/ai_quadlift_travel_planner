/**
 * Preflight trip input — deterministic parsing + validation that runs in the browser
 * **before** `POST /api/plans` (§13), so an incomplete or impossible request never
 * reaches the intent model and no specialist agent is ever dispatched for it.
 *
 * Two jobs:
 *
 * 1. **Read the request text.** Dates written as prose ("first week of December",
 *    "December 5 to December 9") are resolved to concrete ISO dates, picking the
 *    nearest upcoming occurrence when no year was stated. An explicit traveller
 *    count in the text ("family of four") overrides the number in the field.
 * 2. **Refuse to spend tokens on a plan we cannot evaluate.** Missing dates, an
 *    end before the start, a trip longer than `TRIP_MAX_DAYS`, a start in the past,
 *    an out-of-range traveller count, or a missing/invalid employee id (when the HR
 *    portal is connected) come back as field-level issues and the plan is not created.
 *
 * Everything here is pure and injectable (`today`) so it is fully unit-testable.
 */
import { durationFromQuery, TRIP_MAX_DAYS } from "./duration";

export type PreflightField =
  | "query"
  | "startDate"
  | "endDate"
  | "travelers"
  | "employeeId"
  | "employeeName";

export interface PreflightIssue {
  field: PreflightField;
  message: string;
}

/** What the free text of the request says about dates and travellers. */
export interface TripTextParse {
  startDate?: string;
  endDate?: string;
  travelerCount?: number;
  /** Human-readable trace of every assumption the parser made. */
  notes: string[];
}

export interface PreflightInput {
  query: string;
  startDate?: string;
  endDate?: string;
  /** Current value of the travellers field. */
  travelers: number;
  hrEnabled: boolean;
  employeeId?: string;
  employeeName?: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  /** Assumptions worth showing the user ("read from your text: …"). */
  notes: string[];
  /** Reconciled values — send exactly these, do not re-derive them. */
  query: string;
  startDate?: string;
  endDate?: string;
  travelerCount: number;
  requestHrValidation: boolean;
  employeeId?: string;
  employeeName?: string;
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Full names first so `december` is never read as `dec` + "ember". */
const MONTH_PATTERN =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
const DAY_PATTERN = "(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)";
const YEAR_PATTERN = "(\\d{4})";
const RANGE_SEP = "(?:to|until|through|thru|till|until|-|–|—|/)";

const WEEK_WORD_PATTERN = "(first|1st|second|2nd|third|3rd|fourth|4th|last)";
const WEEK_START: Record<string, number> = { first: 1, "1st": 1, second: 8, "2nd": 8, third: 15, "3rd": 15, fourth: 22, "4th": 22 };
const SEASON_PATTERN = "(early|mid|middle|end|late)";

const TRAVELER_UNITS =
  "travelers?|travellers?|people|persons|pax|adults|guests|of us";
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// --- small date helpers (UTC-constructed, compared lexicographically) ---

function toIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function todayIso(today: Date): string {
  return toIso(today.getFullYear(), today.getMonth(), today.getDate());
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return toIso(y!, m! - 1, d! + delta);
}

function isValidIso(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return m! >= 1 && m! <= 12 && d! >= 1 && d! <= daysInMonth(y!, m! - 1);
}

function count(value: string): number | undefined {
  const asNumber = Number.parseInt(value, 10);
  if (Number.isInteger(asNumber)) return asNumber;
  return WORD_NUMBERS[value.toLowerCase()];
}

/**
 * Resolve a month/day mention to the nearest upcoming occurrence.
 * An explicit year always wins (the user asked for it); without one, a date that has
 * already passed this year rolls to next year.
 */
function resolveMonthDate(
  month: string,
  day: number,
  year: number | undefined,
  today: Date,
  notes: string[],
): string | undefined {
  const monthIndex = MONTHS[month.toLowerCase()];
  if (monthIndex === undefined) return undefined;

  if (year === undefined) {
    const candidateYear = today.getFullYear();
    if (day > daysInMonth(candidateYear, monthIndex)) return undefined;
    const candidate = toIso(candidateYear, monthIndex, day);
    if (candidate >= todayIso(today)) return candidate;
    const nextYear = candidateYear + 1;
    if (day > daysInMonth(nextYear, monthIndex)) return undefined;
    notes.push(
      `Nearest ${MONTH_NAMES[monthIndex]} ${day} is ${candidate} → using ${toIso(nextYear, monthIndex, day)} (${nextYear}, the next occurrence).`,
    );
    return toIso(nextYear, monthIndex, day);
  }

  if (day > daysInMonth(year, monthIndex)) return undefined;
  return toIso(year, monthIndex, day);
}

// --- request-text parsing ---

function parseIsoRange(text: string): TripTextParse | undefined {
  const match = text.match(
    new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2})\\s*${RANGE_SEP}\\s*(\\d{4}-\\d{2}-\\d{2})\\b`, "i"),
  );
  if (!match) return undefined;
  const start = match[1]!;
  const end = match[2]!;
  if (!isValidIso(start) || !isValidIso(end)) return undefined;
  return { startDate: start, endDate: end, notes: [] };
}

function parseIsoSingle(text: string): TripTextParse | undefined {
  const match = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (!match) return undefined;
  const start = match[1]!;
  if (!isValidIso(start)) return undefined;
  return { startDate: start, notes: [] };
}

function parseMonthRange(text: string, today: Date, notes: string[]): TripTextParse | undefined {
  // "5 December 2026 until 8 December 2026" → "December 5 2026 until December 8 2026"
  const normalized = text.replace(
    new RegExp(`\\b${DAY_PATTERN}\\s+${MONTH_PATTERN}\\b`, "gi"),
    (_match, day: string, month: string) => `${month} ${day}`,
  );
  const re = new RegExp(
    `\\b${MONTH_PATTERN}\\b\\.?\\s+${DAY_PATTERN}(?:[,\\s]+${YEAR_PATTERN})?\\s*${RANGE_SEP}\\s*` +
      `(?:(?:on\\s+)?${MONTH_PATTERN}\\b\\.?\\s+)?${DAY_PATTERN}(?:[,\\s]+${YEAR_PATTERN})?`,
    "i",
  );
  const m = normalized.match(re);
  if (!m) return undefined;

  const startYear = m[3] ? Number(m[3]) : undefined;
  const endMonth = m[4];
  const endDay = Number(m[5]);
  const endYear = m[6] ? Number(m[6]) : undefined;

  const startDate = resolveMonthDate(m[1]!, Number(m[2]), startYear, today, notes);
  if (!startDate) return undefined;

  const monthName = endMonth ?? m[1]!;
  const monthIndex = MONTHS[monthName.toLowerCase()] ?? MONTHS[m[1]!.toLowerCase()]!;
  let year = endYear ?? startYear ?? Number(startDate.slice(0, 4));
  // "December 28 to January 2" wraps into the following year.
  if (endYear === undefined) {
    const sameYear = toIso(year, monthIndex, endDay);
    if (endDay <= daysInMonth(year, monthIndex) && sameYear < startDate) year += 1;
  }
  if (endDay > daysInMonth(year, monthIndex)) return undefined;
  return { startDate, endDate: toIso(year, monthIndex, endDay), notes: [] };
}

function parseMonthSingle(text: string, today: Date, notes: string[]): TripTextParse | undefined {
  const monthFirst = new RegExp(`\\b${MONTH_PATTERN}\\b\\.?\\s+${DAY_PATTERN}(?:[,\\s]+${YEAR_PATTERN})?\\b`, "i");
  const dayFirst = new RegExp(`\\b${DAY_PATTERN}\\s+${MONTH_PATTERN}\\b\\.?(?:[,\\s]+${YEAR_PATTERN})?\\b`, "i");

  let m = text.match(monthFirst);
  let month: string;
  let day: number;
  let year: number | undefined;
  if (m) {
    month = m[1]!;
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
  } else {
    m = text.match(dayFirst);
    if (!m) return undefined;
    day = Number(m[1]);
    month = m[2]!;
    year = m[3] ? Number(m[3]) : undefined;
  }

  const startDate = resolveMonthDate(month, day, year, today, notes);
  if (!startDate) return undefined;
  return { startDate, notes: [] };
}

function parseWeekPeriod(text: string, today: Date, notes: string[]): TripTextParse | undefined {
  const re = new RegExp(
    `\\b${WEEK_WORD_PATTERN}\\s+week\\s+(?:of|in|on)\\s+(?:the\\s+)?${MONTH_PATTERN}\\b\\.?(?:[,\\s]+${YEAR_PATTERN})?`,
    "i",
  );
  const m = text.match(re);
  if (!m) return undefined;

  const word = m[1]!.toLowerCase();
  const monthIndex = MONTHS[m[2]!.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const explicitYear = m[3] ? Number(m[3]) : undefined;

  const year = (() => {
    if (explicitYear !== undefined) return explicitYear;
    const candidate = toIso(today.getFullYear(), monthIndex, 1);
    if (candidate >= todayIso(today)) return today.getFullYear();
    notes.push(
      `Nearest ${MONTH_NAMES[monthIndex]} is next year → using ${today.getFullYear() + 1}.`,
    );
    return today.getFullYear() + 1;
  })();

  const monthDays = daysInMonth(year, monthIndex);
  const startDay = word === "last" ? Math.max(1, monthDays - 6) : WEEK_START[word] ?? 1;
  if (startDay > monthDays) return undefined;
  const startDate = toIso(year, monthIndex, startDay);
  // A stated trip length is more specific than the week itself ("five days in the
  // first week of December" starts on the 1st and runs five days, not seven).
  const stated = durationFromQuery(text);
  const endDate = stated
    ? addDays(startDate, Math.min(stated, TRIP_MAX_DAYS) - 1)
    : toIso(year, monthIndex, Math.min(monthDays, startDay + 6));
  return { startDate, endDate, notes: [] };
}

function parseSeasonAnchor(text: string, today: Date, notes: string[]): TripTextParse | undefined {
  const re = new RegExp(`\\b${SEASON_PATTERN}[\\s-]+(?:of[\\s-]+|in[\\s-]+)?${MONTH_PATTERN}\\b\\.?(?:[,\\s]+${YEAR_PATTERN})?`, "i");
  const m = text.match(re);
  if (!m) return undefined;

  const anchor = m[1]!.toLowerCase();
  const monthIndex = MONTHS[m[2]!.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const explicitYear = m[3] ? Number(m[3]) : undefined;
  const year = explicitYear ?? today.getFullYear();

  const monthDays = daysInMonth(year, monthIndex);
  const startDay =
    anchor === "early" ? 1 : anchor === "mid" || anchor === "middle" ? Math.min(11, monthDays) : Math.max(1, monthDays - 9);

  let startDate = toIso(year, monthIndex, startDay);
  if (explicitYear === undefined && startDate < todayIso(today)) {
    const nextYear = year + 1;
    notes.push(`Nearest ${MONTH_NAMES[monthIndex]} is next year → using ${nextYear}.`);
    startDate = toIso(nextYear, monthIndex, Math.min(startDay, daysInMonth(nextYear, monthIndex)));
  }
  return { startDate, notes: [] };
}

function parseBareMonth(text: string, today: Date, notes: string[]): TripTextParse | undefined {
  const m = text.match(new RegExp(`\\b${MONTH_PATTERN}\\b(?:[,\\s]+${YEAR_PATTERN})?(?![-\\d])`, "i"));
  if (!m) return undefined;
  const monthIndex = MONTHS[m[1]!.toLowerCase()];
  if (monthIndex === undefined) return undefined;
  const explicitYear = m[2] ? Number(m[2]) : undefined;
  const year = explicitYear ?? today.getFullYear();

  let startDate = toIso(year, monthIndex, 1);
  if (explicitYear === undefined && startDate < todayIso(today)) {
    const nextYear = year + 1;
    notes.push(`Nearest ${MONTH_NAMES[monthIndex]} is next year → using ${nextYear}.`);
    startDate = toIso(nextYear, monthIndex, 1);
  }
  // A bare month has no end on its own — the caller needs a stated duration.
  return { startDate, notes: [] };
}

/** Dates and travellers stated in the request text itself. */
export function parseTripText(query: string, today: Date = new Date()): TripTextParse {
  const text = query.trim();
  const notes: string[] = [];

  const dates =
    parseIsoRange(text) ??
    parseIsoSingle(text) ??
    parseMonthRange(text, today, notes) ??
    parseMonthSingle(text, today, notes) ??
    parseWeekPeriod(text, today, notes) ??
    parseSeasonAnchor(text, today, notes) ??
    parseBareMonth(text, today, notes) ??
    {};

  return { ...dates, travelerCount: parseTravelers(text), notes };
}

function parseTravelers(text: string): number | undefined {
  const numbers = Object.keys(WORD_NUMBERS).join("|");
  const literal = `\\d{1,2}|${numbers}`;

  const withUnit = text.match(
    new RegExp(`\\b(${literal})\\s*(?:\\+\\s*)?(?:${TRAVELER_UNITS})\\b`, "i"),
  );
  if (withUnit?.[1]) return bounded(count(withUnit[1]));

  const group = text.match(new RegExp(`\\b(?:family|group|party|team)\\s+of\\s+(${literal})\\b`, "i"));
  if (group?.[1]) return bounded(count(group[1]));

  if (/\bsolo\b/i.test(text)) return 1;
  if (/\bcouple\b/i.test(text)) return 2;
  return undefined;
}

function bounded(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 50) return undefined;
  return value;
}

/**
 * Reconcile the form fields with the request text and decide whether a plan may be
 * created at all. Pure: pass `today` in tests.
 */
export function preflightTripInput(input: PreflightInput, today: Date = new Date()): PreflightResult {
  const issues: PreflightIssue[] = [];
  const notes: string[] = [];
  const query = input.query.trim();

  if (!query) {
    issues.push({ field: "query", message: "Tell us where you want to go, and when." });
  }

  const parsed = query ? parseTripText(query, today) : { notes: [] as string[] };
  notes.push(...parsed.notes);

  // --- travellers: an explicit count in the text overrides the field ---
  let travelerCount = input.travelers;
  if (parsed.travelerCount !== undefined) {
    if (parsed.travelerCount !== input.travelers) {
      notes.push(
        `Your request says ${parsed.travelerCount} traveler(s) — using that instead of the ${input.travelers} in the field.`,
      );
    }
    travelerCount = parsed.travelerCount;
  }
  if (!Number.isInteger(travelerCount) || travelerCount < 1 || travelerCount > 50) {
    issues.push({ field: "travelers", message: "Number of travelers must be between 1 and 50." });
  }

  // --- dates: text first (§13), then the date fields, then a stated trip length ---
  const stated = durationFromQuery(query);
  if (parsed.startDate && (input.startDate || input.endDate)) {
    const picked = [input.startDate, input.endDate].filter(Boolean).join(" → ");
    const read = [parsed.startDate, parsed.endDate].filter(Boolean).join(" → ");
    if (read !== picked) notes.push(`Using ${read} read from your text (the dates below were updated).`);
  }
  let startDate = parsed.startDate ?? input.startDate;
  let endDate: string | undefined;
  if (parsed.endDate) {
    endDate = parsed.endDate;
  } else if (stated && startDate) {
    endDate = addDays(startDate, stated - 1);
    notes.push(`Trip length read from your text: ${stated} day(s) → ${startDate} → ${endDate}.`);
  } else {
    endDate = input.endDate;
  }
  if (!startDate && endDate && stated) startDate = addDays(endDate, 1 - stated);

  if (!startDate && !endDate) {
    issues.push({
      field: "startDate",
      message:
        "Add your dates — pick them below or mention them in the request (e.g. “from 2026-12-01 to 2026-12-07” or “first week of December”).",
    });
  } else if (!endDate) {
    issues.push({
      field: "endDate",
      message: "Add an end date below, or say how long the trip is (e.g. “five days”).",
    });
  } else if (!startDate) {
    issues.push({
      field: "startDate",
      message: "Add a start date below, or say how long the trip is (e.g. “five days”).",
    });
  } else if (endDate < startDate) {
    issues.push({
      field: "endDate",
      message: `Your end date (${endDate}) is before your start date (${startDate}).`,
    });
  } else {
    const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
    if (days > TRIP_MAX_DAYS) {
      issues.push({
        field: "endDate",
        message: `Trips are supported up to ${TRIP_MAX_DAYS} days — this one is ${days} days.`,
      });
    }
    if (startDate < todayIso(today)) {
      issues.push({
        field: "startDate",
        message: `Your trip starts on ${startDate}, which has already passed.`,
      });
    }
  }

  // --- HR (§17.5): the id is mandatory once the portal is connected ---
  let employeeId: string | undefined;
  let employeeName: string | undefined;
  if (input.hrEnabled) {
    const id = (input.employeeId ?? "").trim().toUpperCase();
    const name = (input.employeeName ?? "").trim();
    if (!id) {
      issues.push({
        field: "employeeId",
        message: "Enter your employee ID (format E0001) — required to check your leave balance.",
      });
    } else if (!/^E\d{4}$/.test(id)) {
      issues.push({ field: "employeeId", message: "Employee ID must be E followed by 4 digits, e.g. E0001." });
    } else {
      employeeId = id;
    }
    if (name.length > 120) {
      issues.push({ field: "employeeName", message: "Employee name must be 120 characters or fewer." });
    } else if (name) {
      employeeName = name;
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    notes,
    query,
    startDate,
    endDate,
    travelerCount,
    requestHrValidation: input.hrEnabled,
    employeeId,
    employeeName,
  };
}
