/** Tenant isolation for every Phase 3 table (raw SQL as sentinel_app, and through the API). */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SCENARIOS } from "./fixtures/scenarios.js";
import { APP_URL, asAppInTenant, auth, fieldFixture, login, makeApp, tenantId, withClient, type FieldFixture } from "./helpers.js";

const PHASE3_TABLES = ["scenario_input", "risk_snapshot", "narrative", "google_connection", "google_oauth_state", "google_folder", "export_job"];

let app: FastifyInstance;
let acme: string;
let acmeId: string;
let blueId: string;
let b: FieldFixture;
let a: FieldFixture;
let blueUser: string;
const blueJob = randomUUID();

/** Commits rows in tenant B as sentinel_app (so RLS WITH CHECK applies to the seeding too). */
async function seedBlue() {
  await withClient(APP_URL, async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [blueId]);
    const A = b.assessmentId;
    await c.query("INSERT INTO scenario_input (tenant_id, assessment_id, scenario_id, likelihood, impact) VALUES ($1, $2, 'fixture-intrusion', 3, 3)", [blueId, A]);
    await c.query("INSERT INTO risk_snapshot (tenant_id, assessment_id, method_version, result) VALUES ($1, $2, 'm', '{}')", [blueId, A]);
    await c.query("INSERT INTO narrative (tenant_id, assessment_id, section, text, status) VALUES ($1, $2, 'methodology', 'Blue secret narrative', 'edited')", [blueId, A]);
    await c.query("INSERT INTO google_connection (tenant_id, refresh_token, iv, tag, scopes, connected_by) VALUES ($1, '\\x00', $2, $3, '{}', $4)", [blueId, Buffer.alloc(12), Buffer.alloc(16), blueUser]);
    await c.query("INSERT INTO google_oauth_state (tenant_id, state_hash, user_id, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')", [blueId, "a".repeat(64), blueUser]);
    await c.query("INSERT INTO google_folder (tenant_id, path, folder_id) VALUES ($1, '[\"x\"]', 'folder1')", [blueId]);
    await c.query("INSERT INTO export_job (id, tenant_id, assessment_id, targets, template_version, created_by, status) VALUES ($1, $2, $3, '{docs}', 't', $4, 'succeeded')", [blueJob, blueId, A, blueUser]);
    await c.query("COMMIT");
  });
}

beforeAll(async () => {
  app = await makeApp({}, { risk: { scenarios: FIXTURE_SCENARIOS } });
  acme = (await login(app, "owner@acme.test")).token;
  const bl = await login(app, "owner@bluefield.test");
  blueUser = bl.body.session.user.id;
  acmeId = await tenantId("acme-integrators");
  blueId = await tenantId("bluefield-security");
  a = await fieldFixture(app, acme, [], "Acme iso 3");
  b = await fieldFixture(app, bl.token, [], "Blue iso 3");
  await seedBlue();
});
afterAll(() => app.close());

describe("raw SQL as sentinel_app", () => {
  it("RLS is enabled and forced on every Phase 3 table", async () => {
    await withClient(APP_URL, async (c) => {
      const { rows } = await c.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)", [PHASE3_TABLES]);
      expect(rows).toHaveLength(PHASE3_TABLES.length);
      for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    });
  });

  it("tenant B rows are invisible to tenant A and without a tenant", async () => {
    await asAppInTenant(blueId, async (q) => {
      for (const t of PHASE3_TABLES) expect((await q(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBeGreaterThan(0);
    });
    await asAppInTenant(acmeId, async (q) => {
      for (const t of PHASE3_TABLES) expect((await q(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [blueId])).rows[0].n, t).toBe(0);
    });
    await withClient(APP_URL, async (c) => {
      for (const t of PHASE3_TABLES) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${t} without tenant`).toBe(0);
    });
  });

  it("tenant A cannot update or delete tenant B rows", async () => {
    await asAppInTenant(acmeId, async (q) => {
      expect((await q("UPDATE narrative SET text = 'pwned' WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
      expect((await q("UPDATE export_job SET status = 'failed' WHERE id = $1", [blueJob])).rowCount).toBe(0);
      expect((await q("DELETE FROM google_connection WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
      expect((await q("DELETE FROM scenario_input WHERE tenant_id = $1", [blueId])).rowCount).toBe(0);
    });
  });

  it("WITH CHECK rejects writing rows into tenant B from tenant A", async () => {
    const attempts: [string, unknown[]][] = [
      ["INSERT INTO scenario_input (tenant_id, assessment_id, scenario_id, likelihood, impact) VALUES ($1, $2, 'fixture-crypto', 1, 1)", [blueId, b.assessmentId]],
      ["INSERT INTO risk_snapshot (tenant_id, assessment_id, method_version, result) VALUES ($1, $2, 'm', '{}')", [blueId, b.assessmentId]],
      ["INSERT INTO narrative (tenant_id, assessment_id, section, text, status) VALUES ($1, $2, 'key_findings', 'x', 'edited')", [blueId, b.assessmentId]],
      ["INSERT INTO google_folder (tenant_id, path, folder_id) VALUES ($1, 'p', 'f')", [blueId]],
      ["INSERT INTO export_job (tenant_id, assessment_id, targets, template_version, created_by) VALUES ($1, $2, '{docs}', 't', $3)", [blueId, b.assessmentId, blueUser]],
    ];
    for (const [sql, params] of attempts) {
      await expect(asAppInTenant(acmeId, (q) => q(sql, params)), sql).rejects.toThrow(/row-level security/);
    }
  });

  it("composite foreign keys reject an own-tenant row pointing at a tenant B assessment", async () => {
    await expect(
      asAppInTenant(acmeId, (q) => q("INSERT INTO scenario_input (tenant_id, assessment_id, scenario_id, likelihood, impact) VALUES ($1, $2, 'fixture-crypto', 1, 1)", [acmeId, b.assessmentId])),
    ).rejects.toThrow(/foreign key/);
    await expect(
      asAppInTenant(acmeId, (q) => q("INSERT INTO narrative (tenant_id, assessment_id, section, text, status) VALUES ($1, $2, 'recommendations', 'x', 'edited')", [acmeId, b.assessmentId])),
    ).rejects.toThrow(/foreign key/);
  });

  it("risk snapshots are append-only for the app role", async () => {
    await asAppInTenant(blueId, async (q) => {
      await expect(q("UPDATE risk_snapshot SET result = '{}'")).rejects.toThrow(/permission denied/);
    });
    await asAppInTenant(blueId, async (q) => {
      await expect(q("DELETE FROM risk_snapshot")).rejects.toThrow(/permission denied/);
    });
  });
});

describe("through the API", () => {
  it("tenant A gets 404 for tenant B's assessment risk, narrative, preview, and exports", async () => {
    const B = b.assessmentId;
    for (const url of [`/assessments/${B}/risk/inputs`, `/assessments/${B}/risk`, `/assessments/${B}/narrative`, `/assessments/${B}/report/preview`, `/assessments/${B}/exports`, `/exports/${blueJob}`, `/risk/compare?assessmentIds=${B}`]) {
      const res = await app.inject({ url, headers: auth(acme) });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain("Blue secret");
    }
    for (const [method, url, payload] of [
      ["PUT", `/assessments/${B}/risk/inputs`, { scenarios: [] }],
      ["PUT", `/assessments/${B}/narrative/methodology`, { text: "x" }],
      ["POST", `/assessments/${B}/reopen`, { reason: "steal it" }],
    ] as const) {
      expect((await app.inject({ method, url, headers: auth(acme), payload })).statusCode, url).toBe(404);
    }
  });

  it("the dashboard counts only the caller's tenant", async () => {
    const d = (await app.inject({ url: "/dashboard", headers: auth(acme) })).json();
    expect(JSON.stringify(d)).not.toContain("Blue iso 3");
  });
});
