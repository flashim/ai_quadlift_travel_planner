import { describe, expect, it } from "vitest";
import { DEFAULT_KEY, COST_DB, estimateCost, exactKey, paddedKey, roundMoney } from "../src/catalog";

describe("cost catalog helpers", () => {
  it("normalizes the destination for the exact-match rung", () => {
    expect(exactKey("  TOKYO  ")).toBe("tokyo");
    expect(exactKey("Paris")).toBe("paris");
  });

  it("builds a whole-token key for the containment rung", () => {
    expect(paddedKey("Paris, France")).toBe(" paris france ");
    expect(paddedKey("new york city")).toBe(" new york city ");
    expect(paddedKey("New York, USA")).toBe(" new york usa ");
  });

  it("always ships a default profile as the ladder's last rung", () => {
    expect(COST_DB[DEFAULT_KEY]).toBeDefined();
    expect(COST_DB[DEFAULT_KEY]!.currency).toBe("USD");
    expect(COST_DB[DEFAULT_KEY]!.fx).toBe(1);
    expect(Object.keys(COST_DB)).toHaveLength(11);
  });

  it("prices the hotel per night and the rest per day, both scaled by travelers", () => {
    const paris = COST_DB.paris!;
    // 5 days → 4 nights, 2 travelers: hotel 150×4×2, everything else ×5×2
    const { usd, local } = estimateCost(paris, 5, 4, 2);
    expect(usd).toEqual({ hotel: 1200, food: 600, transport: 200, activities: 400, total: 2400 });
    expect(local).toEqual({ hotel: 1104, food: 552, transport: 184, activities: 368, total: 2208 });
    // local total agrees with usd.total × fx
    expect(local.total).toBe(roundMoney(usd.total * paris.fx));
  });

  it("charges no hotel nights on a single-day trip", () => {
    const { usd } = estimateCost(COST_DB[DEFAULT_KEY]!, 1, 0, 1);
    expect(usd.hotel).toBe(0);
    expect(usd.total).toBe(45 + 18 + 30);
  });

  it("rounds money to two decimals", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(99.999)).toBe(100);
  });
});
