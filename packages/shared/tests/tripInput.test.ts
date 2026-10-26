import { describe, expect, it } from "vitest";
import { parseTripText, preflightTripInput } from "../src/tripInput";

/** Fixed "today": 30 September 2026. */
const TODAY = new Date("2026-09-30T12:00:00");
/** Fixed "today" inside December, to prove the nearest-occurrence roll. */
const IN_DECEMBER = new Date("2026-12-15T12:00:00");

function preflight(overrides: Partial<Parameters<typeof preflightTripInput>[0]> = {}) {
  return preflightTripInput(
    {
      query: "Plan five days in Paris from 2026-10-05 to 2026-10-09",
      travelers: 2,
      hrEnabled: false,
      ...overrides,
    },
    TODAY,
  );
}

/** Same defaults, but a query that states no dates — the fields are then in charge. */
function preflightFields(overrides: Partial<Parameters<typeof preflightTripInput>[0]> = {}) {
  return preflight({ query: "A holiday", ...overrides });
}

function messages(result: ReturnType<typeof preflightTripInput>): string[] {
  return result.issues.map((i) => i.message);
}

describe("parseTripText — dates in prose", () => {
  it("reads an explicit ISO range", () => {
    const parsed = parseTripText("Five days in Paris from 2026-10-05 to 2026-10-09", TODAY);
    expect(parsed).toMatchObject({ startDate: "2026-10-05", endDate: "2026-10-09" });
  });

  it("reads month-name ranges with and without a year", () => {
    expect(parseTripText("December 5 to December 9, 2026", TODAY)).toMatchObject({
      startDate: "2026-12-05",
      endDate: "2026-12-09",
    });
    expect(parseTripText("from Dec 5 to 9", TODAY)).toMatchObject({
      startDate: "2026-12-05",
      endDate: "2026-12-09",
    });
    expect(parseTripText("5 December 2026 until 8 December 2026", TODAY)).toMatchObject({
      startDate: "2026-12-05",
      endDate: "2026-12-08",
    });
  });

  it("takes the nearest upcoming occurrence when no year is stated", () => {
    // 30 Sep 2026 → December is still ahead this year
    expect(parseTripText("December 5 to December 9", TODAY)).toMatchObject({
      startDate: "2026-12-05",
      endDate: "2026-12-09",
    });
    // 15 Dec 2026 → 5 Dec already passed, so next year
    const rolled = parseTripText("December 5 to December 9", IN_DECEMBER);
    expect(rolled).toMatchObject({ startDate: "2027-12-05", endDate: "2027-12-09" });
    expect(rolled.notes.join(" ")).toContain("next occurrence");
  });

  it("reads week phrases as the nearest week of that month", () => {
    expect(parseTripText("first week of December", TODAY)).toMatchObject({
      startDate: "2026-12-01",
      endDate: "2026-12-07",
    });
    expect(parseTripText("the second week in March", TODAY)).toMatchObject({
      startDate: "2027-03-08",
      endDate: "2027-03-14",
    });
    expect(parseTripText("last week of December 2026", TODAY)).toMatchObject({
      startDate: "2026-12-25",
      endDate: "2026-12-31",
    });
    // already past → next year
    expect(parseTripText("first week of December", IN_DECEMBER)).toMatchObject({
      startDate: "2027-12-01",
      endDate: "2027-12-07",
    });
  });

  it("lets a stated trip length shorten the week it sits in", () => {
    expect(parseTripText("five days in the first week of December", TODAY)).toMatchObject({
      startDate: "2026-12-01",
      endDate: "2026-12-05",
    });
  });

  it("anchors seasonal wording to a day of the month", () => {
    expect(parseTripText("early December", TODAY)).toMatchObject({ startDate: "2026-12-01" });
    expect(parseTripText("mid-December", TODAY)).toMatchObject({ startDate: "2026-12-11" });
    expect(parseTripText("end of December", TODAY)).toMatchObject({ startDate: "2026-12-22" });
  });

  it("accepts a bare month when a trip length is stated elsewhere", () => {
    expect(parseTripText("five days in Paris in December", TODAY)).toMatchObject({
      startDate: "2026-12-01",
    });
    expect(parseTripText("five days in Paris in December", TODAY).endDate).toBeUndefined();
    expect(parseTripText("December 2026", TODAY)).toMatchObject({ startDate: "2026-12-01" });
    expect(parseTripText("ten days in Rome, May 2027", TODAY)).toMatchObject({
      startDate: "2027-05-01",
    });
  });

  it("does not read a bare month out of ordinary words", () => {
    expect(parseTripText("a decadence of travel", TODAY).startDate).toBeUndefined();
    expect(parseTripText("see the marches and markets", TODAY).startDate).toBeUndefined();
  });

  it("returns nothing when the request has no dates", () => {
    const parsed = parseTripText("Plan a nice holiday", TODAY);
    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toBeUndefined();
  });
});

describe("parseTripText — travellers in prose", () => {
  it("reads an explicit count with a unit", () => {
    expect(parseTripText("five days in Paris for 4 travelers", TODAY).travelerCount).toBe(4);
    expect(parseTripText("a trip for three travellers", TODAY).travelerCount).toBe(3);
    expect(parseTripText("2 people wanted", TODAY).travelerCount).toBe(2);
  });

  it("reads group idioms", () => {
    expect(parseTripText("family of four going to Rome", TODAY).travelerCount).toBe(4);
    expect(parseTripText("there are five of us", TODAY).travelerCount).toBe(5);
    expect(parseTripText("flying solo", TODAY).travelerCount).toBe(1);
    expect(parseTripText("a couple, three days in Rome", TODAY).travelerCount).toBe(2);
  });

  it("never mistakes a trip length for a traveller count", () => {
    expect(parseTripText("five days in Paris", TODAY).travelerCount).toBeUndefined();
    expect(parseTripText("day 2 of the trip", TODAY).travelerCount).toBeUndefined();
  });
});

describe("preflightTripInput — reconcile form and text", () => {
  it("accepts a complete request unchanged", () => {
    const result = preflight();
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({
      startDate: "2026-10-05",
      endDate: "2026-10-09",
      travelerCount: 2,
      requestHrValidation: false,
    });
    expect(result.employeeId).toBeUndefined();
  });

  it("prefers the dates in the text over the ones in the field", () => {
    const result = preflight({ startDate: "2026-11-01", endDate: "2026-11-07" });
    expect(result.startDate).toBe("2026-10-05");
    expect(result.endDate).toBe("2026-10-09");
    expect(result.notes.join(" ")).toContain("read from your text");
  });

  it("uses the date fields when the text has no dates", () => {
    const result = preflight({
      query: "A relaxing week away",
      startDate: "2026-11-01",
      endDate: "2026-11-07",
    });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-07" });
  });

  it("derives the end date from a stated trip length", () => {
    // a stated length alone is not enough — there is no start date to add it to
    expect(preflight({ query: "Five days in Paris" }).ok).toBe(false);

    const startOnly = preflight({ query: "Five days in Paris", startDate: "2026-12-01" });
    expect(startOnly.ok).toBe(true);
    expect(startOnly.endDate).toBe("2026-12-05");

    const endOnly = preflight({ query: "Five days in Paris", endDate: "2026-12-05" });
    expect(endOnly.ok).toBe(true);
    expect(endOnly.startDate).toBe("2026-12-01");
  });

  it("overrides the travellers field with an explicit count from the text", () => {
    const result = preflight({ query: `${preflight().query} for 4 travelers`, travelers: 2 });
    expect(result.travelerCount).toBe(4);
    expect(result.notes.join(" ")).toContain("4 traveler(s)");
    expect(preflight({ query: "Three days in Rome", travelers: 5 }).travelerCount).toBe(5);
  });

  it("fills dates from prose when the fields are empty", () => {
    const result = preflight({ query: "Five days in Paris, first week of December" });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ startDate: "2026-12-01", endDate: "2026-12-05" });
  });
});

describe("preflightTripInput — refuses to create an unevaluatable plan", () => {
  it("asks for dates when there are none", () => {
    const result = preflight({ query: "Plan a holiday in Paris" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ field: "startDate" });
    expect(messages(result).join(" ")).toContain("Add your dates");
  });

  it("asks for an end date when only a start is known", () => {
    const result = preflight({ query: "A holiday in Paris", startDate: "2026-12-01" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ field: "endDate" });
    expect(messages(result).join(" ")).toContain("how long the trip is");
  });

  it("rejects an end date before the start date", () => {
    const result = preflightFields({ startDate: "2026-12-10", endDate: "2026-12-01" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.field).toBe("endDate");
    expect(messages(result).join(" ")).toContain("before your start date");
  });

  it("rejects a trip longer than the day grid can build", () => {
    const result = preflightFields({ startDate: "2026-12-01", endDate: "2027-01-20" });
    expect(result.ok).toBe(false);
    expect(messages(result).join(" ")).toContain("up to 30 days");
  });

  it("rejects a trip that already started", () => {
    const result = preflightFields({ startDate: "2020-01-01", endDate: "2020-01-05" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.field).toBe("startDate");
    expect(messages(result).join(" ")).toContain("already passed");
  });

  it("rejects an empty request and an impossible traveller count", () => {
    expect(preflight({ query: "   " }).issues[0]).toMatchObject({ field: "query" });
    const travelers = preflight({ travelers: 99 });
    expect(travelers.ok).toBe(false);
    expect(travelers.issues[0]).toMatchObject({ field: "travelers" });
  });

  it("asks for the employee id only while the HR portal is connected", () => {
    const missing = preflight({ hrEnabled: true });
    expect(missing.ok).toBe(false);
    expect(missing.issues[0]).toMatchObject({ field: "employeeId" });
    expect(messages(missing).join(" ")).toContain("employee ID");

    const malformed = preflight({ hrEnabled: true, employeeId: "E9" });
    expect(malformed.ok).toBe(false);
    expect(malformed.issues[0]).toMatchObject({ field: "employeeId" });

    // not connected → no id needed, and no HR fields are ever sent
    const off = preflight({ employeeId: "E0001", employeeName: "Ada" });
    expect(off.ok).toBe(true);
    expect(off.employeeId).toBeUndefined();
    expect(off.employeeName).toBeUndefined();
    expect(off.requestHrValidation).toBe(false);
  });

  it("normalizes and keeps a valid HR identity", () => {
    const result = preflight({ hrEnabled: true, employeeId: " e0001 ", employeeName: "  Ada Lovelace " });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      requestHrValidation: true,
      employeeId: "E0001",
      employeeName: "Ada Lovelace",
    });

    const blank = preflight({ hrEnabled: true, employeeId: "E0001", employeeName: "   " });
    expect(blank.ok).toBe(true);
    expect(blank.employeeName).toBeUndefined();

    const long = preflight({ hrEnabled: true, employeeId: "E0001", employeeName: "x".repeat(121) });
    expect(long.ok).toBe(false);
    expect(long.issues[0]).toMatchObject({ field: "employeeName" });
  });

  it("collects every problem at once so the form can show them together", () => {
    const result = preflightFields({
      travelers: 0,
      hrEnabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.field).sort()).toEqual(
      ["employeeId", "startDate", "travelers"].sort(),
    );
  });
});
