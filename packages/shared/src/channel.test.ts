import { describe, expect, it } from "vitest";
import { quoteTotals, unitPrice, type QuoteLine } from "./channel.js";

const line = (o: Partial<QuoteLine>): QuoteLine => ({
  id: "00000000-0000-4000-8000-000000000001", findingId: null, priceBookItemId: null, description: "x", category: "hardware", unit: "each",
  quantity: 1, materialCost: 0, laborHours: 0, marginPct: 0, tier: "all", optional: false, needsPricing: false, sortOrder: 0, ...o,
});

describe("quote math", () => {
  it("prices a line as cost over one minus margin", () => {
    expect(unitPrice({ materialCost: 600, laborHours: 4, marginPct: 25 }, 100)).toBe(1333.33);
  });
  it("totals per tier: 'all' lines in every tier, tier lines only in theirs, optional lines separate", () => {
    const t = quoteTotals({
      laborRate: 100,
      tiers: ["good", "best"],
      lines: [
        line({ materialCost: 100, laborHours: 1, marginPct: 50, quantity: 2 }), // all: price 400 each tier
        line({ materialCost: 300, marginPct: 25, tier: "best" }), // best only: 400
        line({ materialCost: 75, marginPct: 25, tier: "good", optional: true }), // good optional: 100
      ],
    });
    expect(t).toEqual([
      { tier: "good", materials: 200, labor: 200, cost: 400, price: 800, margin: 400, marginPct: 50, optionalPrice: 100 },
      { tier: "best", materials: 500, labor: 200, cost: 700, price: 1200, margin: 500, marginPct: 41.67, optionalPrice: 0 },
    ]);
  });
  it("an empty tier has zero totals and zero margin percent", () => {
    expect(quoteTotals({ laborRate: 90, tiers: ["better"], lines: [] })[0]).toMatchObject({ price: 0, marginPct: 0 });
  });
});
