/** Tenant isolation: enforced by Postgres RLS, verified both through the API and with raw SQL. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_URL, auth, login, makeApp, tenantId, withClient } from "./helpers.js";

let app: FastifyInstance;
let acme: string; // owner@acme.test token
let blue: string; // owner@bluefield.test token
let acmeId: string;
let blueId: string;
let blueClientId: string;
let blueSiteId: string;
let blueAssessmentId: string;

beforeAll(async () => {
  app = await makeApp();
  acme = (await login(app, "owner@acme.test")).token;
  blue = (await login(app, "owner@bluefield.test")).token;
  acmeId = await tenantId("acme-integrators");
  blueId = await tenantId("bluefield-security");
  // Data in tenant B (Bluefield).
  blueClientId = (await app.inject({ method: "POST", url: "/clients", headers: auth(blue), payload: { name: "Bluefield Secret Client" } })).json().id;
  blueSiteId = (await app.inject({ method: "POST", url: "/sites", headers: auth(blue), payload: { clientId: blueClientId, name: "Blue HQ" } })).json().id;
  const a = await app.inject({
    method: "POST", url: "/assessments", headers: auth(blue),
    payload: { siteId: blueSiteId, title: "Blue assessment", frameworks: [{ frameworkId: "test-fw", version: "1.0.0" }] },
  });
  expect(a.statusCode).toBe(201);
  blueAssessmentId = a.json().id;
  // And something in tenant A.
  await app.inject({ method: "POST", url: "/clients", headers: auth(acme), payload: { name: "Acme Client" } });
});
afterAll(() => app.close());

describe("API: tenant A cannot see or touch tenant B", () => {
  it("lists only its own clients, sites, and assessments", async () => {
    const clients = (await app.inject({ url: "/clients", headers: auth(acme) })).json();
    expect(clients.map((c: { name: string }) => c.name)).not.toContain("Bluefield Secret Client");
    expect(clients.length).toBeGreaterThan(0);
    const sites = (await app.inject({ url: "/sites", headers: auth(acme) })).json();
    expect(sites.find((s: { id: string }) => s.id === blueSiteId)).toBeUndefined();
    const assessments = (await app.inject({ url: "/assessments", headers: auth(acme) })).json();
    expect(assessments.find((s: { id: string }) => s.id === blueAssessmentId)).toBeUndefined();
  });

  it("gets 404 reading tenant B records by id", async () => {
    expect((await app.inject({ url: `/clients/${blueClientId}`, headers: auth(acme) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/assessments/${blueAssessmentId}`, headers: auth(acme) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/sites?clientId=${blueClientId}`, headers: auth(acme) })).json()).toEqual([]);
  });

  it("cannot create into tenant B by referencing tenant B parents", async () => {
    const site = await app.inject({ method: "POST", url: "/sites", headers: auth(acme), payload: { clientId: blueClientId, name: "Sneaky" } });
    expect(site.statusCode).toBe(404);
    const asmt = await app.inject({
      method: "POST", url: "/assessments", headers: auth(acme),
      payload: { siteId: blueSiteId, title: "Sneaky", frameworks: [{ frameworkId: "test-fw", version: "1.0.0" }] },
    });
    expect(asmt.statusCode).toBe(404);
    const blueSites = (await app.inject({ url: `/sites?clientId=${blueClientId}`, headers: auth(blue) })).json();
    expect(blueSites).toHaveLength(1);
  });

  it("ignores a tenant id smuggled in the body", async () => {
    const res = await app.inject({ method: "POST", url: "/clients", headers: auth(acme), payload: { name: "Smuggle", tenantId: blueId } });
    expect(res.statusCode).toBe(201);
    const blueNames = (await app.inject({ url: "/clients", headers: auth(blue) })).json().map((c: { name: string }) => c.name);
    expect(blueNames).not.toContain("Smuggle");
  });

  it("audit log shows only own tenant events", async () => {
    const rows = (await app.inject({ url: "/audit?limit=500", headers: auth(acme) })).json();
    expect(rows.find((r: { entityId: string }) => r.entityId === blueClientId)).toBeUndefined();
  });
});

describe("raw SQL as sentinel_app", () => {
  const inTenant = <T>(tid: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>) =>
    withClient(APP_URL, async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
        return await fn((sql, p) => c.query(sql, p));
      } finally {
        await c.query("ROLLBACK");
      }
    });

  it("with tenant A setting sees zero tenant B rows in every tenant table", async () => {
    await inTenant(acmeId, async (q) => {
      for (const t of ["client", "site", "area", "assessment", "assessment_framework", "membership", "refresh_token", "audit_log"]) {
        const r = await q(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [blueId]);
        expect(r.rows[0].n, t).toBe(0);
      }
      expect((await q("SELECT count(*)::int AS n FROM tenant WHERE id = $1", [blueId])).rows[0].n).toBe(0);
      expect((await q("SELECT count(*)::int AS n FROM client")).rows[0].n).toBeGreaterThan(0);
      // Users of tenant B are invisible too.
      expect((await q("SELECT count(*)::int AS n FROM app_user WHERE email = 'owner@bluefield.test'")).rows[0].n).toBe(0);
    });
  });

  it("with tenant A setting cannot update or delete tenant B rows", async () => {
    await inTenant(acmeId, async (q) => {
      expect((await q("UPDATE client SET name = 'pwned' WHERE id = $1", [blueClientId])).rowCount).toBe(0);
      expect((await q("DELETE FROM client WHERE id = $1", [blueClientId])).rowCount).toBe(0);
    });
  });

  it("with tenant A setting cannot insert a row for tenant B", async () => {
    await expect(inTenant(acmeId, (q) => q("INSERT INTO client (tenant_id, name) VALUES ($1, 'x')", [blueId]))).rejects.toThrow(/row-level security/);
  });

  it("with no tenant setting sees nothing", async () => {
    await withClient(APP_URL, async (c) => {
      for (const t of ["tenant", "membership", "client", "site", "assessment", "audit_log", "refresh_token", "app_user"]) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
      // After a tenant transaction ends the setting is gone again on the same connection.
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [acmeId]);
      expect((await c.query("SELECT count(*)::int AS n FROM client")).rows[0].n).toBeGreaterThan(0);
      await c.query("COMMIT");
      expect((await c.query("SELECT count(*)::int AS n FROM client")).rows[0].n).toBe(0);
    });
  });

  it("cannot UPDATE or DELETE audit_log", async () => {
    await expect(inTenant(acmeId, (q) => q("UPDATE audit_log SET action = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(inTenant(acmeId, (q) => q("DELETE FROM audit_log"))).rejects.toThrow(/permission denied/);
    await expect(inTenant(acmeId, (q) => q("TRUNCATE audit_log"))).rejects.toThrow(/permission denied/);
  });

  it("cannot write reference tables or read password hashes", async () => {
    await expect(withClient(APP_URL, (c) => c.query("INSERT INTO framework (id, name, short_name, kind, category) VALUES ('evil', 'e', 'e', 'k', 'cyber')"))).rejects.toThrow(/permission denied/);
    await expect(withClient(APP_URL, (c) => c.query("UPDATE requirement SET title = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(inTenant(acmeId, (q) => q("SELECT password_hash FROM app_user"))).rejects.toThrow(/permission denied/);
  });

  it("cannot disable RLS or act as owner", async () => {
    await expect(withClient(APP_URL, (c) => c.query("ALTER TABLE client DISABLE ROW LEVEL SECURITY"))).rejects.toThrow(/must be owner/);
    await expect(withClient(APP_URL, (c) => c.query("SET ROLE sentinel_owner"))).rejects.toThrow(/permission denied/);
  });
});
