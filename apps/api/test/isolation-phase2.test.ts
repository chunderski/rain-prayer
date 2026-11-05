/** Tenant isolation for every Phase 2 table (raw SQL as sentinel_app, and through the API). */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VisionClient } from "@sentinel/ai";
import { APP_URL, asAppInTenant, auth, fieldFixture, login, makeApp, nowIso, tenantId, withClient, type FieldFixture } from "./helpers.js";

const PHASE2_TABLES = [
  "tenant_settings", "assessment_assessor", "asset", "answer", "finding", "finding_control", "photo", "photo_control",
  "ai_suggestion", "sync_operation", "sync_conflict", "change_log", "change_seq",
];

const fake: VisionClient = {
  async analyze() {
    return {
      text: JSON.stringify({
        imageQuality: "ok", assetType: { value: "fence", confidence: 0.9 }, condition: { rating: "fair", summary: "ok", confidence: 0.5 },
        deficiencies: [], controls: [{ id: "SC-PER-001", confidence: 0.9, rationale: "fence" }],
        draftFindings: [{ title: "Fence issue", description: "d", recommendation: "r", severity: "low", controlIds: ["SC-PER-001"], confidence: 0.5 }], cautions: [],
      }),
    };
  },
};

let app: FastifyInstance;
let acme: string;
let blue: string;
let acmeId: string;
let blueId: string;
let b: FieldFixture;
const ids = { area: "", asset: randomUUID(), answer: randomUUID(), finding: randomUUID(), photo: randomUUID(), suggestion: "" };

beforeAll(async () => {
  app = await makeApp({}, { vision: fake });
  acme = (await login(app, "owner@acme.test")).token;
  const bl = await login(app, "owner@bluefield.test");
  blue = bl.token;
  acmeId = await tenantId("acme-integrators");
  blueId = await tenantId("bluefield-security");
  await fieldFixture(app, acme, [], "Acme iso");
  b = await fieldFixture(app, blue, [bl.body.session.user.id], "Blue iso");
  const B = auth(blue);
  const A = b.assessmentId;
  await app.inject({ method: "PATCH", url: "/tenant/settings", headers: B, payload: { allowGps: true } });
  ids.area = (await app.inject({ method: "POST", url: `/sites/${b.siteId}/areas`, headers: B, payload: { name: "Blue yard" } })).json().id;
  await app.inject({ method: "PUT", url: `/assessments/${A}/assets/${ids.asset}`, headers: B, payload: { id: ids.asset, assessmentId: A, assetType: "fence", label: "Blue fence" } });
  await app.inject({ method: "PUT", url: `/assessments/${A}/answers/${ids.answer}`, headers: B, payload: { id: ids.answer, assessmentId: A, questionId: "Q-PER-001-01", value: { kind: "choice", value: "yes" }, answeredAt: nowIso() } });
  await app.inject({ method: "POST", url: `/assessments/${A}/photos`, headers: B, payload: { id: ids.photo, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 10, controlIds: ["SC-PER-001"] } });
  const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#000" } }).jpeg().toBuffer();
  await app.inject({ method: "PUT", url: `/photos/${ids.photo}/content`, headers: { ...B, "content-type": "image/jpeg" }, payload: img });
  ids.suggestion = (await app.inject({ method: "POST", url: `/photos/${ids.photo}/analyze`, headers: B, payload: {} })).json().id;
  // Push creates the finding (sync_operation), a second stale push creates a sync_conflict.
  const f = { id: ids.finding, assessmentId: A, title: "Blue secret finding", severity: "high", controlIds: ["SC-PER-001"] };
  const p1 = await app.inject({ method: "POST", url: "/sync/push", headers: B, payload: { deviceId: randomUUID(), ops: [{ opId: randomUUID(), entity: "finding", action: "upsert", id: ids.finding, data: f, baseVersion: null, clientUpdatedAt: nowIso() }] } });
  expect(p1.json().results[0].status).toBe("applied");
  await app.inject({ method: "POST", url: "/sync/push", headers: B, payload: { deviceId: randomUUID(), ops: [{ opId: randomUUID(), entity: "finding", action: "upsert", id: ids.finding, data: f, baseVersion: null, clientUpdatedAt: nowIso() }] } });
});
afterAll(() => app.close());

describe("raw SQL as sentinel_app", () => {
  it("RLS is enabled and forced on every Phase 2 table", async () => {
    await withClient(APP_URL, async (c) => {
      const { rows } = await c.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)", [PHASE2_TABLES]);
      expect(rows).toHaveLength(PHASE2_TABLES.length);
      for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
    });
  });

  it("tenant B has rows in every Phase 2 table, and tenant A sees none of them", async () => {
    await asAppInTenant(blueId, async (q) => {
      for (const t of PHASE2_TABLES) expect((await q(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBeGreaterThan(0);
    });
    await asAppInTenant(acmeId, async (q) => {
      for (const t of [...PHASE2_TABLES, "area"]) {
        expect((await q(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [blueId])).rows[0].n, t).toBe(0);
      }
    });
    await withClient(APP_URL, async (c) => {
      for (const t of PHASE2_TABLES) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${t} without tenant`).toBe(0);
    });
  });

  it("tenant A cannot update, delete, or insert tenant B rows", async () => {
    await asAppInTenant(acmeId, async (q) => {
      for (const t of ["finding", "photo", "asset", "answer", "ai_suggestion"]) {
        expect((await q(`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [blueId])).rowCount, t).toBe(0);
        expect((await q(`DELETE FROM ${t} WHERE tenant_id = $1`, [blueId])).rowCount, t).toBe(0);
      }
    });
    const tries: [string, unknown[]][] = [
      ["INSERT INTO finding_control (tenant_id, finding_id, control_id) VALUES ($1, $2, 'SC-PER-002')", [blueId, ids.finding]],
      ["INSERT INTO change_log (tenant_id, seq, entity, entity_id, version, deleted) VALUES ($1, 999999, 'finding', $2, 9, true)", [blueId, ids.finding]],
      ["INSERT INTO tenant_settings (tenant_id) VALUES ($1)", [blueId]],
    ];
    for (const [sql, p] of tries) await expect(asAppInTenant(acmeId, (q) => q(sql, p)), sql).rejects.toThrow(/row-level security|violates foreign key/);
    // A composite FK keeps a tenant A row from pointing at a tenant B parent.
    const acmeAssessment = (await app.inject({ url: "/assessments", headers: auth(acme) })).json()[0].id;
    await expect(asAppInTenant(acmeId, (q) => q(
      "INSERT INTO finding (id, tenant_id, assessment_id, asset_id, title, severity) VALUES ($1, $2, $3, $4, 'x', 'low')",
      [randomUUID(), acmeId, acmeAssessment, ids.asset],
    ))).rejects.toThrow(/foreign key/);
  });

  it("change_log and sync_conflict are append-only for the app role", async () => {
    for (const t of ["change_log", "sync_conflict"]) {
      await expect(asAppInTenant(blueId, (q) => q(`DELETE FROM ${t}`)), t).rejects.toThrow(/permission denied/);
      await expect(asAppInTenant(blueId, (q) => q(`UPDATE ${t} SET tenant_id = tenant_id`)), t).rejects.toThrow(/permission denied/);
    }
  });
});

describe("API: tenant A cannot reach tenant B field data", () => {
  it("reads are 404 or empty", async () => {
    const A = auth(acme);
    for (const url of [
      `/assessments/${b.assessmentId}/walkthrough`, `/assessments/${b.assessmentId}/findings`, `/sites/${b.siteId}/areas`,
      `/photos/${ids.photo}/url`, `/photos/${ids.photo}/suggestions`, `/sync/pull?assessmentId=${b.assessmentId}`,
    ]) {
      expect((await app.inject({ url, headers: A })).statusCode, url).toBe(404);
    }
    const members = (await app.inject({ url: "/members", headers: A })).json();
    expect(members.find((m: { email: string }) => m.email === "owner@bluefield.test")).toBeUndefined();
  });

  it("writes are 404 and change nothing", async () => {
    const A = auth(acme);
    const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const writes = [
      app.inject({ method: "PATCH", url: `/areas/${ids.area}`, headers: A, payload: { name: "pwned" } }),
      app.inject({ method: "DELETE", url: `/areas/${ids.area}`, headers: A }),
      app.inject({ method: "PATCH", url: `/photos/${ids.photo}`, headers: A, payload: { notes: "pwned" } }),
      app.inject({ method: "PUT", url: `/photos/${ids.photo}/content`, headers: { ...A, "content-type": "image/jpeg" }, payload: img }),
      app.inject({ method: "DELETE", url: `/photos/${ids.photo}`, headers: A }),
      app.inject({ method: "POST", url: `/photos/${ids.photo}/analyze`, headers: A, payload: {} }),
      app.inject({ method: "POST", url: `/suggestions/${ids.suggestion}/review`, headers: A, payload: { decision: "accept" } }),
      app.inject({ method: "DELETE", url: `/assessments/${b.assessmentId}/findings/${ids.finding}`, headers: A }),
      app.inject({ method: "PUT", url: `/assessments/${b.assessmentId}/assessors`, headers: A, payload: { userIds: [] } }),
      app.inject({ method: "PATCH", url: `/assessments/${b.assessmentId}`, headers: A, payload: { title: "pwned" } }),
      app.inject({ method: "PUT", url: `/assessments/${b.assessmentId}/assets/${randomUUID()}`, headers: A, payload: { assetType: "door", label: "x" } }),
    ];
    (await Promise.all(writes)).forEach((r, i) => expect(r.statusCode, `write ${i}`).toBe(404));
    const w = (await app.inject({ url: `/assessments/${b.assessmentId}/walkthrough`, headers: auth(blue) })).json();
    expect(w.areas[0].name).toBe("Blue yard");
    expect(w.photos[0].status).toBe("stored");
    expect(w.photos[0].notes).toBeUndefined();
    expect(w.findings[0].title).toBe("Blue secret finding");
    expect(w.assessors).toHaveLength(1);
  });
});
