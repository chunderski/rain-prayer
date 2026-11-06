/** Tenant isolation for every Phase 4 table (raw SQL as sentinel_app, and through the API). */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SCENARIOS } from "./fixtures/scenarios.js";
import { APP_URL, asAppInTenant, auth, fieldFixture, login, makeApp, tenantId, withClient, type FieldFixture } from "./helpers.js";

const PHASE4_TABLES = ["tenant_branding", "member_setup_token", "price_book_item", "quote_settings", "quote", "quote_line"];

let app: FastifyInstance;
let acme: string;
let acmeId: string;
let blueId: string;
let a: FieldFixture;
let b: FieldFixture;
let blueQuote: string;
let blueItem: string;

beforeAll(async () => {
  app = await makeApp({}, { risk: { scenarios: FIXTURE_SCENARIOS }, walkthrough: null });
  acme = (await login(app, "owner@acme.test")).token;
  const blue = (await login(app, "owner@bluefield.test")).token;
  acmeId = await tenantId("acme-integrators");
  blueId = await tenantId("bluefield-security");
  a = await fieldFixture(app, acme, [], "Acme iso 4");
  b = await fieldFixture(app, blue, [], "Blue iso 4");
  const H = auth(blue);
  const must = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, code = 200) => {
    const r = await p;
    if (r.statusCode !== code) throw new Error(`${r.statusCode} ${r.body}`);
    return r.json();
  };
  await must(app.inject({ method: "PUT", url: "/branding", headers: H, payload: { displayName: "Blue secret brand", primaryColor: "#123456", accentColor: "#654321" } }));
  await must(app.inject({ method: "POST", url: "/members", headers: H, payload: { email: "iso4-invite@bluefield.test", name: "Iso", role: "viewer" } }), 201);
  blueItem = randomUUID();
  await must(app.inject({ method: "PUT", url: `/price-book/${blueItem}`, headers: H, payload: { sku: "BLUE-SECRET", name: "Blue secret item", category: "service", unit: "lot", materialCost: 10, laborHours: 1, defaultMarginPct: 30 } }));
  await must(app.inject({ method: "PUT", url: "/tenant/quote-settings", headers: H, payload: { defaultLaborRate: 80, minMarginPct: 20, defaultTerms: "Blue terms", validDays: 14 } }));
  const q = await must(app.inject({ method: "POST", url: `/assessments/${b.assessmentId}/quotes`, headers: H, payload: {} }), 201);
  blueQuote = q.id;
  const line = { id: randomUUID(), findingId: null, priceBookItemId: blueItem, description: "Blue secret line", category: "service", unit: "lot", quantity: 1, materialCost: 10, laborHours: 1, marginPct: 30, tier: "all", optional: false, needsPricing: false, sortOrder: 0 };
  await must(app.inject({ method: "PUT", url: `/quotes/${blueQuote}`, headers: H, payload: { title: q.title, laborRate: 80, validUntil: q.validUntil, tiers: q.tiers, notes: "", terms: "", lines: [line] } }));
});
afterAll(() => app.close());

describe("raw SQL as sentinel_app", () => {
  it("RLS is enabled and forced on every Phase 4 table", async () => {
    await withClient(APP_URL, async (c) => {
      const { rows } = await c.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)", [PHASE4_TABLES]);
      expect(rows).toHaveLength(PHASE4_TABLES.length);
      for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    });
  });

  it("tenant B rows are invisible to tenant A and without a tenant", async () => {
    await asAppInTenant(blueId, async (q) => {
      for (const t of PHASE4_TABLES) expect((await q(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBeGreaterThan(0);
    });
    await asAppInTenant(acmeId, async (q) => {
      for (const t of PHASE4_TABLES) expect((await q(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [blueId])).rows[0].n, t).toBe(0);
    });
    await withClient(APP_URL, async (c) => {
      for (const t of PHASE4_TABLES) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${t} without tenant`).toBe(0);
    });
  });

  it("tenant A cannot update or delete tenant B rows", async () => {
    await asAppInTenant(acmeId, async (q) => {
      expect((await q("UPDATE tenant_branding SET display_name = 'pwned' WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
      expect((await q("UPDATE quote SET status = 'accepted' WHERE id = $1", [blueQuote])).rowCount).toBe(0);
      expect((await q("UPDATE price_book_item SET material_cost = 0 WHERE id = $1", [blueItem])).rowCount).toBe(0);
      expect((await q("DELETE FROM quote_line WHERE quote_id = $1", [blueQuote])).rowCount).toBe(0);
      expect((await q("DELETE FROM member_setup_token WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
      expect((await q("UPDATE quote_settings SET min_margin_pct = 0 WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
      expect((await q("UPDATE membership SET role = 'owner' WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
    });
  });

  it("WITH CHECK and composite foreign keys reject writes into tenant B from tenant A", async () => {
    const attempts: [string, unknown[]][] = [
      ["INSERT INTO tenant_branding (tenant_id, display_name, primary_color, accent_color) VALUES ($1, 'x', '#000000', '#000000')", [blueId]],
      ["INSERT INTO price_book_item (id, tenant_id, sku, name, category, unit, material_cost, labor_hours, default_margin_pct) VALUES (gen_random_uuid(), $1, 'X', 'xx', 'service', 'lot', 0, 0, 0)", [blueId]],
      ["INSERT INTO quote_settings (tenant_id, default_labor_rate, min_margin_pct, valid_days) VALUES ($1, 1, 1, 1)", [blueId]],
      ["INSERT INTO quote (tenant_id, assessment_id, number, base_number, title, labor_rate, valid_until, tiers, min_margin_pct) VALUES ($1, $2, 'Q-2026-9999', 'Q-2026-9999', 't', 1, '2030-01-01', '{good}', 0)", [blueId, b.assessmentId]],
    ];
    for (const [sql, params] of attempts) {
      await expect(asAppInTenant(acmeId, (q) => q(sql, params)), sql).rejects.toThrow(/row-level security|violates/);
    }
    // Tenant A row pointing at tenant B's assessment, quote, price book item, or client: composite FKs refuse.
    const fkAttempts: [string, unknown[]][] = [
      ["INSERT INTO quote (tenant_id, assessment_id, number, base_number, title, labor_rate, valid_until, tiers, min_margin_pct) VALUES ($1, $2, 'Q-2026-9998', 'Q-2026-9998', 't', 1, '2030-01-01', '{good}', 0)", [acmeId, b.assessmentId]],
      ["INSERT INTO quote_line (id, tenant_id, quote_id, description, category, unit, quantity, material_cost, labor_hours, margin_pct, tier) VALUES (gen_random_uuid(), $1, $2, 'x', 'service', 'lot', 1, 0, 0, 0, 'all')", [acmeId, blueQuote]],
      ["UPDATE membership SET role = 'client_viewer', client_id = $1 WHERE role = 'viewer'", [b.clientId]],
    ];
    for (const [sql, params] of fkAttempts) {
      await expect(asAppInTenant(acmeId, (q) => q(sql, params)), sql).rejects.toThrow(/violates foreign key/);
    }
  });

  it("the app role cannot change a tenant's plan", async () => {
    await expect(asAppInTenant(acmeId, (q) => q("UPDATE tenant SET plan = 'partner' WHERE id = $1", [acmeId]))).rejects.toThrow(/permission denied/);
  });
});

describe("through the API", () => {
  it("tenant A cannot read or act on tenant B quotes, items, or branding", async () => {
    const H = auth(acme);
    expect((await app.inject({ url: `/quotes/${blueQuote}`, headers: H })).statusCode).toBe(404);
    expect((await app.inject({ url: `/quotes/${blueQuote}/csv`, headers: H })).statusCode).toBe(404);
    expect((await app.inject({ url: `/quotes/${blueQuote}/preview`, headers: H })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/quotes/${blueQuote}/actions`, headers: H, payload: { action: "submit" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/assessments/${b.assessmentId}/quotes`, headers: H })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/assessments/${b.assessmentId}/quotes`, headers: H, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/price-book/${blueItem}`, headers: H })).statusCode).toBe(404);
    const reuse = await app.inject({ method: "PUT", url: `/price-book/${blueItem}`, headers: H, payload: { sku: "A-1", name: "Take over", category: "service", unit: "lot", materialCost: 1, laborHours: 0, defaultMarginPct: 0 } });
    expect(reuse.statusCode).toBe(409);
    const items = (await app.inject({ url: "/price-book", headers: H })).body;
    expect(items).not.toContain("BLUE-SECRET");
    expect((await app.inject({ url: "/branding", headers: H })).body).not.toContain("Blue secret brand");
    expect((await app.inject({ url: "/members", headers: H })).body).not.toContain("iso4-invite");
    expect((await app.inject({ url: `/portfolio?clientId=${b.clientId}`, headers: H })).json().clients).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/members", headers: H, payload: { email: "x@acme.test", name: "X", role: "client_viewer", clientId: b.clientId } })).statusCode).toBe(400);
    // A tenant A quote line may not reference tenant B's price book item.
    const q = (await app.inject({ method: "POST", url: `/assessments/${a.assessmentId}/quotes`, headers: H, payload: {} })).json();
    const line = { id: randomUUID(), findingId: null, priceBookItemId: blueItem, description: "x", category: "service", unit: "lot", quantity: 1, materialCost: 1, laborHours: 0, marginPct: 30, tier: "all", optional: false, needsPricing: false, sortOrder: 0 };
    const r = await app.inject({ method: "PUT", url: `/quotes/${q.id}`, headers: H, payload: { title: "t", laborRate: 1, validUntil: q.validUntil, tiers: ["good"], notes: "", terms: "", lines: [line] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("unknown_price_book_item");
  });
});
