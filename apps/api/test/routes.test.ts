import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, login, makeApp } from "./helpers.js";

let app: FastifyInstance;
let owner: string;
let assessor: string;
let viewer: string;
let siteId: string;
let clientId: string;

beforeAll(async () => {
  app = await makeApp();
  owner = (await login(app, "owner@acme.test")).token;
  assessor = (await login(app, "assessor@acme.test")).token;
  viewer = (await login(app, "viewer@acme.test")).token;
  const c = await app.inject({ method: "POST", url: "/clients", headers: auth(owner), payload: { name: "Harbor Logistics", industry: "Logistics" } });
  clientId = c.json().id;
  siteId = (await app.inject({ method: "POST", url: "/sites", headers: auth(owner), payload: { clientId, name: "Pier 4", siteType: "warehouse" } })).json().id;
});
afterAll(() => app.close());

const tf = [{ frameworkId: "test-fw", version: "1.0.0" }];

describe("health and errors", () => {
  it("health is public", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("unknown routes use the error envelope", async () => {
    const res = await app.inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
  });

  it("malformed JSON is a 400 without internals", async () => {
    const res = await app.inject({ method: "POST", url: "/clients", headers: { ...auth(owner), "content-type": "application/json" }, payload: "{bad" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
    expect(res.body).not.toMatch(/at .*\.ts/);
  });

  it("CORS allows only WEB_ORIGIN, with credentials", async () => {
    const ok = await app.inject({ method: "OPTIONS", url: "/auth/login", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await app.inject({ method: "OPTIONS", url: "/auth/login", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("role enforcement", () => {
  it("viewer cannot POST /clients or /sites", async () => {
    const res = await app.inject({ method: "POST", url: "/clients", headers: auth(viewer), payload: { name: "Nope" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect((await app.inject({ method: "POST", url: "/sites", headers: auth(viewer), payload: { clientId, name: "x" } })).statusCode).toBe(403);
  });

  it("assessor cannot POST /clients but can POST /assessments", async () => {
    expect((await app.inject({ method: "POST", url: "/clients", headers: auth(assessor), payload: { name: "Nope" } })).statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/assessments", headers: auth(assessor), payload: { siteId, title: "Q1 walk", frameworks: tf } });
    expect(res.statusCode).toBe(201);
  });

  it("viewer cannot POST /assessments or GET /audit; viewer can read", async () => {
    expect((await app.inject({ method: "POST", url: "/assessments", headers: auth(viewer), payload: { siteId, title: "x", frameworks: tf } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/audit", headers: auth(viewer) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/audit", headers: auth(assessor) })).statusCode).toBe(403);
    for (const url of ["/clients", "/sites", "/assessments", "/frameworks", "/controls", `/clients/${clientId}`]) {
      expect((await app.inject({ url, headers: auth(viewer) })).statusCode, url).toBe(200);
    }
  });

  it("every non-public route requires a token", async () => {
    for (const [method, url] of [["GET", "/clients"], ["POST", "/clients"], ["GET", "/frameworks"], ["GET", "/controls"], ["GET", "/audit"], ["POST", "/assessments"]] as const) {
      expect((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, url).toBe(401);
    }
  });
});

describe("validation", () => {
  it("rejects bad bodies with 400 validation_error and field details", async () => {
    const res = await app.inject({ method: "POST", url: "/clients", headers: auth(owner), payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect(res.json().error.details[0].path).toBe("name");
    const site = await app.inject({ method: "POST", url: "/sites", headers: auth(owner), payload: { clientId: "not-a-uuid", name: "x" } });
    expect(site.json().error.details[0].path).toBe("clientId");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "nope", password: "" } });
    expect(login.statusCode).toBe(400);
  });

  it("rejects bad params and queries", async () => {
    expect((await app.inject({ url: "/clients/123", headers: auth(owner) })).json().error.code).toBe("validation_error");
    expect((await app.inject({ url: "/sites?clientId=zzz", headers: auth(owner) })).statusCode).toBe(400);
    expect((await app.inject({ url: "/audit?limit=100000", headers: auth(owner) })).statusCode).toBe(400);
    expect((await app.inject({ url: "/controls/not-an-id", headers: auth(owner) })).statusCode).toBe(400);
    expect((await app.inject({ url: "/frameworks/test-fw/versions/latest", headers: auth(owner) })).statusCode).toBe(400);
  });

  it("requires at least one framework, no duplicates", async () => {
    const none = await app.inject({ method: "POST", url: "/assessments", headers: auth(owner), payload: { siteId, title: "x", frameworks: [] } });
    expect(none.json().error.code).toBe("validation_error");
    const dup = await app.inject({ method: "POST", url: "/assessments", headers: auth(owner), payload: { siteId, title: "x", frameworks: [...tf, ...tf] } });
    expect(dup.statusCode).toBe(400);
  });
});

describe("clients and sites", () => {
  it("creates and reads clients with site counts", async () => {
    const list = (await app.inject({ url: "/clients", headers: auth(viewer) })).json();
    expect(list.find((c: { id: string }) => c.id === clientId)).toMatchObject({ name: "Harbor Logistics", industry: "Logistics", siteCount: 1 });
    const one = (await app.inject({ url: `/clients/${clientId}`, headers: auth(viewer) })).json();
    expect(one.sites).toEqual([expect.objectContaining({ id: siteId, clientId, name: "Pier 4", siteType: "warehouse" })]);
    const sites = (await app.inject({ url: `/sites?clientId=${clientId}`, headers: auth(viewer) })).json();
    expect(sites).toHaveLength(1);
  });
});

describe("assessments", () => {
  it("pins framework versions and reports deduplicated counts", async () => {
    const res = await app.inject({
      method: "POST", url: "/assessments", headers: auth(assessor),
      payload: { siteId, title: "Annual review", frameworks: tf, scheduledFor: "2026-12-01" },
    });
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({
      title: "Annual review", status: "draft", siteId, siteName: "Pier 4", clientName: "Harbor Logistics",
      scheduledFor: "2026-12-01", libraryVersion: "0.1.0",
      frameworks: [{ frameworkId: "test-fw", version: "1.0.0", shortName: "TESTFW" }],
      controlCount: 2, questionCount: 3,
    });
    const again = (await app.inject({ url: `/assessments/${a.id}`, headers: auth(viewer) })).json();
    expect(again).toEqual(a);
    const list = (await app.inject({ url: "/assessments", headers: auth(viewer) })).json();
    expect(list.find((x: { id: string }) => x.id === a.id)).toMatchObject({ siteName: "Pier 4", clientName: "Harbor Logistics", frameworks: [{ frameworkId: "test-fw", version: "1.0.0", shortName: "TESTFW" }] });
  });

  it("rejects unknown frameworks and versions", async () => {
    for (const f of [{ frameworkId: "test-fw", version: "9.9.9" }, { frameworkId: "nist-csf-3", version: "1.0.0" }]) {
      const res = await app.inject({ method: "POST", url: "/assessments", headers: auth(owner), payload: { siteId, title: "x", frameworks: [f] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: "unknown_framework_version", details: { frameworks: [f] } });
    }
  });

  it("404s for an unknown site", async () => {
    const res = await app.inject({ method: "POST", url: "/assessments", headers: auth(owner), payload: { siteId: "00000000-0000-4000-8000-000000000000", title: "x", frameworks: tf } });
    expect(res.statusCode).toBe(404);
  });
});

describe("framework library", () => {
  it("lists frameworks with counts", async () => {
    const list = (await app.inject({ url: "/frameworks", headers: auth(viewer) })).json();
    expect(list).toEqual([
      expect.objectContaining({ id: "test-fw", shortName: "TESTFW", version: "1.0.0", kind: "control_framework", category: "hybrid",
        publisher: "Sentinel test suite", sourceEdition: "Fixture edition 1", requirementCount: 3, controlCount: 2, needsReviewCount: 2 }),
    ]);
  });

  it("returns a framework version with requirement control ids", async () => {
    const fv = (await app.inject({ url: "/frameworks/test-fw/versions/1.0.0", headers: auth(viewer) })).json();
    expect(fv.levels).toEqual(["function", "requirement"]);
    expect(fv.requirements.map((r: { code: string; controlIds: string[] }) => [r.code, r.controlIds])).toEqual([["TF", []], ["TF-01", ["SC-PER-001"]], ["TF-02", ["SC-PER-002"]]]);
    expect(fv.requirements[1]).toMatchObject({ parentCode: "TF", citation: { section: "TF-01", verified: false } });
    expect((await app.inject({ url: "/frameworks/test-fw/versions/2.0.0", headers: auth(viewer) })).statusCode).toBe(404);
  });

  it("lists and filters controls", async () => {
    const all = (await app.inject({ url: "/controls", headers: auth(viewer) })).json();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: "SC-PER-001", questionCount: 2, assetTypes: ["fence"], mappings: [{ frameworkId: "test-fw", requirementCode: "TF-01", relationship: "satisfies" }] });
    expect((await app.inject({ url: "/controls?q=crypto", headers: auth(viewer) })).json().map((c: { id: string }) => c.id)).toEqual(["SC-PER-002"]);
    expect((await app.inject({ url: "/controls?q=%25", headers: auth(viewer) })).json()).toEqual([]);
    expect((await app.inject({ url: "/controls?domain=CRY", headers: auth(viewer) })).json()).toEqual([]);
    expect((await app.inject({ url: "/controls?framework=test-fw&domain=PER", headers: auth(viewer) })).json()).toHaveLength(2);
  });

  it("returns a control with questions and mappings", async () => {
    const c = (await app.inject({ url: "/controls/SC-PER-001", headers: auth(viewer) })).json();
    expect(c.questions.map((q: { id: string }) => q.id)).toEqual(["Q-PER-001-01", "Q-PER-001-02"]);
    expect(c.questions[1]).toMatchObject({ answerType: "number", unit: "m" });
    expect(c.mappings).toEqual([{ frameworkId: "test-fw", frameworkShortName: "TESTFW", frameworkVersion: "1.0.0", requirementCode: "TF-01", requirementTitle: "Perimeter is fenced", relationship: "satisfies", rationale: "Fence satisfies the fixture requirement." }]);
    expect((await app.inject({ url: "/controls/SC-PER-999", headers: auth(viewer) })).statusCode).toBe(404);
  });
});

describe("audit", () => {
  it("records every create with actor and entity", async () => {
    const rows = (await app.inject({ url: "/audit?limit=200", headers: auth(owner) })).json();
    const has = (action: string, entityId?: string) => rows.some((r: { action: string; entityId: string }) => r.action === action && (!entityId || r.entityId === entityId));
    expect(has("client.create", clientId)).toBe(true);
    expect(has("site.create", siteId)).toBe(true);
    expect(has("assessment.create")).toBe(true);
    expect(rows[0]).toEqual({ id: expect.any(String), at: expect.any(String), actorEmail: expect.any(String), action: expect.any(String), entityType: expect.anything(), entityId: expect.anything(), ip: expect.any(String) });
    expect((await app.inject({ url: "/audit?limit=1", headers: auth(owner) })).json()).toHaveLength(1);
  });
});
