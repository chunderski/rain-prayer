/** Phase 2 field routes: areas, assignment, walkthrough, answers, assets, findings, settings. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAppInTenant, auth, createUser, fieldFixture, login, makeApp, nowIso, tenantId, type FieldFixture } from "./helpers.js";

let app: FastifyInstance;
let owner: string;
let assessor: string; // assigned
let other: string; // assessor, not assigned
let viewer: string;
let assessorId: string;
let fx: FieldFixture;
let acmeId: string;

beforeAll(async () => {
  app = await makeApp({}, { walkthrough: null });
  await createUser("assessor2@acme.test", [{ slug: "acme-integrators", role: "assessor" }]);
  const o = await login(app, "owner@acme.test");
  owner = o.token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  assessorId = a.body.session.user.id;
  other = (await login(app, "assessor2@acme.test")).token;
  viewer = (await login(app, "viewer@acme.test")).token;
  fx = await fieldFixture(app, owner, [assessorId], "Field routes");
  acmeId = await tenantId("acme-integrators");
});
afterAll(() => app.close());

const answer = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(), assessmentId: fx.assessmentId, questionId: "Q-PER-001-01", areaId: null,
  value: { kind: "choice", value: "no" }, answeredAt: nowIso(), ...over,
});

describe("members and assignment", () => {
  it("lists members for admins only", async () => {
    const res = await app.inject({ url: "/members", headers: auth(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((m: { email: string }) => m.email)).toContain("assessor@acme.test");
    expect((await app.inject({ url: "/members", headers: auth(assessor) })).statusCode).toBe(403);
  });

  it("assigns assessors; rejects viewers and non-members", async () => {
    const members = (await app.inject({ url: "/members", headers: auth(owner) })).json();
    const viewerId = members.find((m: { email: string }) => m.email === "viewer@acme.test").userId;
    const bad = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/assessors`, headers: auth(owner), payload: { userIds: [viewerId] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_assessor");
    const res = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/assessors`, headers: auth(owner), payload: { userIds: [assessorId] } });
    expect(res.json()).toEqual({ userIds: [assessorId] });
  });

  it("an assessor who creates an assessment is assigned to it", async () => {
    const own = await fieldFixture(app, owner, [], "Separate site");
    const site = { id: own.siteId };
    const created = await app.inject({ method: "POST", url: "/assessments", headers: auth(other), payload: { siteId: site.id, title: "Mine", frameworks: [{ frameworkId: "test-fw", version: "1.0.0" }] } });
    expect(created.statusCode).toBe(201);
    const put = await app.inject({ method: "PUT", url: `/assessments/${created.json().id}/answers/${randomUUID()}`, headers: auth(other), payload: answer({ assessmentId: created.json().id }) });
    expect(put.statusCode).toBe(201);
  });
});

describe("assessors write only to assigned assessments", () => {
  it("unassigned assessor gets 403 on every field write, and the 403 is audited", async () => {
    const id = randomUUID();
    const writes = [
      { method: "PUT" as const, url: `/assessments/${fx.assessmentId}/answers/${id}`, payload: answer({ id }) },
      { method: "PUT" as const, url: `/assessments/${fx.assessmentId}/assets/${id}`, payload: { id, assessmentId: fx.assessmentId, assetType: "fence", label: "North fence" } },
      { method: "PUT" as const, url: `/assessments/${fx.assessmentId}/findings/${id}`, payload: { id, assessmentId: fx.assessmentId, title: "Gap", severity: "high", controlIds: ["SC-PER-001"] } },
      { method: "POST" as const, url: `/assessments/${fx.assessmentId}/photos`, payload: { id, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 10 } },
      { method: "PATCH" as const, url: `/assessments/${fx.assessmentId}`, payload: { title: "x" } },
      { method: "POST" as const, url: `/sites/${fx.siteId}/areas`, payload: { name: "Lobby" } },
    ];
    for (const w of writes) {
      const res = await app.inject({ ...w, headers: auth(other) });
      expect(res.statusCode, w.url).toBe(403);
    }
    const log = (await app.inject({ url: "/audit?limit=50", headers: auth(owner) })).json();
    expect(log.filter((r: { action: string; actorEmail: string }) => r.action === "access.denied" && r.actorEmail === "assessor2@acme.test").length).toBeGreaterThanOrEqual(writes.length);
  });

  it("viewer cannot write; role 403s are audited too", async () => {
    const res = await app.inject({ method: "POST", url: `/sites/${fx.siteId}/areas`, headers: auth(viewer), payload: { name: "Lobby" } });
    expect(res.statusCode).toBe(403);
    const log = (await app.inject({ url: "/audit?limit=20", headers: auth(owner) })).json();
    expect(log.find((r: { action: string; actorEmail: string }) => r.action === "access.denied" && r.actorEmail === "viewer@acme.test")).toBeTruthy();
  });

  it("admins may write to any assessment", async () => {
    const id = randomUUID();
    const res = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/assets/${id}`, headers: auth(owner), payload: { id, assessmentId: fx.assessmentId, assetType: "gate", label: "Main gate" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(1);
  });
});

describe("areas", () => {
  let areaId: string;
  it("creates, lists in order, and patches", async () => {
    const b = await app.inject({ method: "POST", url: `/sites/${fx.siteId}/areas`, headers: auth(assessor), payload: { name: "B yard", kind: "exterior", sortOrder: 2 } });
    expect(b.statusCode).toBe(201);
    const a = await app.inject({ method: "POST", url: `/sites/${fx.siteId}/areas`, headers: auth(assessor), payload: { name: "A gate", kind: "entrance", sortOrder: 1 } });
    areaId = a.json().id;
    const list = (await app.inject({ url: `/sites/${fx.siteId}/areas`, headers: auth(viewer) })).json();
    expect(list.map((x: { name: string }) => x.name)).toEqual(["A gate", "B yard"]);
    expect(list[0]).toMatchObject({ siteId: fx.siteId, kind: "entrance", sortOrder: 1, version: 1 });
    const p = await app.inject({ method: "PATCH", url: `/areas/${areaId}`, headers: auth(assessor), payload: { name: "Main gate" } });
    expect(p.json()).toMatchObject({ name: "Main gate", kind: "entrance", sortOrder: 1, version: 2 });
  });

  it("delete is admin only and 409 while referenced", async () => {
    expect((await app.inject({ method: "DELETE", url: `/areas/${areaId}`, headers: auth(assessor) })).statusCode).toBe(403);
    const ans = answer({ areaId });
    expect((await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${ans.id}`, headers: auth(assessor), payload: ans })).statusCode).toBe(201);
    const del = await app.inject({ method: "DELETE", url: `/areas/${areaId}`, headers: auth(owner) });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("area_in_use");
    const free = (await app.inject({ method: "POST", url: `/sites/${fx.siteId}/areas`, headers: auth(owner), payload: { name: "Temp" } })).json();
    expect((await app.inject({ method: "DELETE", url: `/areas/${free.id}`, headers: auth(owner) })).statusCode).toBe(204);
    const list = (await app.inject({ url: `/sites/${fx.siteId}/areas`, headers: auth(viewer) })).json();
    expect(list.find((x: { id: string }) => x.id === free.id)).toBeUndefined();
  });
});

describe("answers, assets, findings", () => {
  it("validates answers against the pinned question type", async () => {
    const bad = answer({ value: { kind: "choice", value: "partial" } });
    const r1 = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${bad.id}`, headers: auth(assessor), payload: bad });
    expect(r1.statusCode).toBe(400);
    const unknownQ = answer({ questionId: "Q-ZZZ-001-01" });
    const r2 = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${unknownQ.id}`, headers: auth(assessor), payload: unknownQ });
    expect(r2.json().error.code).toBe("unknown_question");
    const num = answer({ questionId: "Q-PER-001-02", value: { kind: "number", value: 2.4, unit: "m" } });
    const r3 = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${num.id}`, headers: auth(assessor), payload: num });
    expect(r3.statusCode).toBe(201);
    const again = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${num.id}`, headers: auth(assessor), payload: { ...num, value: { kind: "number", value: 2.5, unit: "m" } } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ version: 2, value: { value: 2.5 } });
  });

  it("one answer per question and area: a second id gets 409 answer_exists", async () => {
    const first = answer({ questionId: "Q-PER-002-01", value: { kind: "choice", value: "yes" } });
    await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${first.id}`, headers: auth(assessor), payload: first });
    const dup = answer({ questionId: "Q-PER-002-01" });
    const res = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${dup.id}`, headers: auth(assessor), payload: dup });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "answer_exists", details: { id: first.id } });
  });

  it("findings: unknown controls rejected, AI provenance is server-controlled, frameworks listed, delete tombstones", async () => {
    const id = randomUUID();
    const base = { id, assessmentId: fx.assessmentId, title: "Fence gap", severity: "high", controlIds: ["SC-PER-001"] };
    const unknown = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor), payload: { ...base, controlIds: ["SC-ZZZ-001"] } });
    expect(unknown.json().error.code).toBe("unknown_control");
    const res = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor), payload: { ...base, source: "ai_accepted", suggestionId: randomUUID() } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: "assessor", suggestionId: null, status: "draft", controlIds: ["SC-PER-001"] });
    const list = (await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(viewer) })).json();
    const f = list.find((x: { id: string }) => x.id === id);
    expect(f.frameworks).toEqual([{ frameworkId: "test-fw", requirementCode: "TF-01", relationship: "satisfies" }]);
    expect((await app.inject({ method: "DELETE", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor) })).statusCode).toBe(204);
    const after = (await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(viewer) })).json();
    expect(after.find((x: { id: string }) => x.id === id)).toBeUndefined();
  });

  it("rejects a body whose assessmentId differs from the URL", async () => {
    const id = randomUUID();
    const res = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/assets/${id}`, headers: auth(assessor), payload: { id, assessmentId: randomUUID(), assetType: "door", label: "x" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("assessment status", () => {
  it("moves forward one step at a time", async () => {
    const skip = await app.inject({ method: "PATCH", url: `/assessments/${fx.assessmentId}`, headers: auth(assessor), payload: { status: "complete" } });
    expect(skip.statusCode).toBe(409);
    for (const status of ["in_progress", "in_review", "complete"]) {
      const r = await app.inject({ method: "PATCH", url: `/assessments/${fx.assessmentId}`, headers: auth(assessor), payload: { status } });
      expect(r.statusCode, status).toBe(200);
      expect(r.json().status).toBe(status);
    }
  });
});

describe("walkthrough", () => {
  it("falls back to one section per domain and includes field records", async () => {
    const res = await app.inject({ url: `/assessments/${fx.assessmentId}/walkthrough`, headers: auth(viewer) });
    expect(res.statusCode).toBe(200);
    const w = res.json();
    expect(w.libraryVersion).toBe("0.1.0");
    expect(w.sections.map((s: { id: string }) => s.id)).toEqual(["per"]);
    const ctrl = w.sections[0].controls;
    expect(ctrl.map((c: { id: string }) => c.id)).toEqual(["SC-PER-001", "SC-PER-002"]);
    expect(ctrl[0].frameworks[0]).toEqual({ frameworkId: "test-fw", shortName: "TESTFW", requirementCode: "TF-01", relationship: "satisfies" });
    expect(ctrl[0].questions[1]).toMatchObject({ id: "Q-PER-001-02", answerType: "number", unit: "m" });
    expect(ctrl[0].questions[0].unit).toBeUndefined();
    expect(w.answers.length).toBeGreaterThan(0);
    expect(w.areas.length).toBeGreaterThan(0);
    expect(w.assessors).toEqual([{ userId: assessorId, name: "Sam Assessor" }]);
  });

  it("uses walkthrough.json sections when present; a control appears once, in the first section claiming its domain", async () => {
    const app2 = await makeApp({}, {
      walkthrough: {
        libraryVersion: "0.1.0",
        sections: [
          { id: "second", title: "Second", description: "Second section text.", order: 2, domains: ["PER"] },
          { id: "first", title: "First", description: "First section text.", order: 1, domains: ["PER", "ACC"] },
        ],
        assetTypeControls: {} as never,
      },
    });
    const w = (await app2.inject({ url: `/assessments/${fx.assessmentId}/walkthrough`, headers: auth(viewer) })).json();
    expect(w.sections.map((s: { id: string }) => s.id)).toEqual(["first"]);
    expect(w.sections[0].controls).toHaveLength(2);
    await app2.close();
  });
});

describe("tenant settings", () => {
  it("defaults, admin-only patch, viewer read", async () => {
    expect((await app.inject({ url: "/tenant/settings", headers: auth(viewer) })).json()).toEqual({ allowGps: false, aiPhotoAnalysis: true, aiShareContext: false });
    expect((await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(assessor), payload: { allowGps: true } })).statusCode).toBe(403);
    const r = await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { allowGps: true } });
    expect(r.json()).toEqual({ allowGps: true, aiPhotoAnalysis: true, aiShareContext: false });
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { allowGps: false } });
  });

  it("is stored per tenant (raw SQL)", async () => {
    await asAppInTenant(acmeId, async (q) => {
      expect((await q("SELECT count(*)::int AS n FROM tenant_settings")).rows[0].n).toBe(1);
    });
  });
});
