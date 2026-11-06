/** Phase 3: assessment lock and reopen, risk routes (real @sentinel/risk engine), report preview, narrative. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TextClient } from "@sentinel/ai";
import { METHOD_VERSION } from "@sentinel/risk";
import { Narrative, RiskResult, SiteComparison } from "@sentinel/shared";
import { FIXTURE_SCENARIOS } from "./fixtures/scenarios.js";
import { asAppInTenant, auth, fieldFixture, login, makeApp, nowIso, tenantId, type FieldFixture } from "./helpers.js";

const HOSTILE = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
const DRAFT_TEXT = "SECRET-UNREVIEWED-DRAFT the site has open findings that need attention.";
const textCalls: { userText: string }[] = [];
const fakeText: TextClient = {
  async complete(req) {
    textCalls.push({ userText: req.userText });
    return { text: DRAFT_TEXT };
  },
};

let app: FastifyInstance;
let owner: string;
let assessor: string;
let viewer: string;
let fx: FieldFixture;
const H = (t: string) => auth(t);

beforeAll(async () => {
  app = await makeApp({}, { risk: { scenarios: FIXTURE_SCENARIOS }, text: fakeText, walkthrough: null });
  owner = (await login(app, "owner@acme.test")).token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  viewer = (await login(app, "viewer@acme.test")).token;
  fx = await fieldFixture(app, owner, [a.body.session.user.id], "Phase 3 site");
});
afterAll(() => app.close());

const putAnswer = (token: string, value: string) => {
  const id = randomUUID();
  return app.inject({
    method: "PUT", url: `/assessments/${fx.assessmentId}/answers/${id}`, headers: H(token),
    payload: { id, assessmentId: fx.assessmentId, questionId: "Q-PER-002-01", areaId: null, value: { kind: "choice", value }, answeredAt: nowIso() },
  });
};

describe("risk inputs and results (real engine)", () => {
  it("lists the scenario library with the method version header", async () => {
    const res = await app.inject({ url: "/risk/scenarios", headers: H(viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-risk-method"]).toBe(METHOD_VERSION);
    expect(res.json().map((s: { id: string }) => s.id)).toEqual(FIXTURE_SCENARIOS.map((s) => s.id));
  });

  it("defaults inputs to every relevant scenario with null likelihood and impact", async () => {
    const res = await app.inject({ url: `/assessments/${fx.assessmentId}/risk/inputs`, headers: H(viewer) });
    expect(res.json()).toEqual({
      scenarios: [
        { scenarioId: "fixture-intrusion", likelihood: null, impact: null, excluded: false },
        { scenarioId: "fixture-crypto", likelihood: null, impact: null, excluded: false },
      ],
    });
  });

  it("validates inputs", async () => {
    const url = `/assessments/${fx.assessmentId}/risk/inputs`;
    const bad = [
      { scenarios: [{ scenarioId: "fixture-unrelated", likelihood: 2, impact: 2 }] },
      { scenarios: [{ scenarioId: "fixture-intrusion", likelihood: 6, impact: 2 }] },
      { scenarios: [{ scenarioId: "fixture-intrusion", likelihood: 2.5, impact: 2 }] },
      { scenarios: [{ scenarioId: "fixture-intrusion", likelihood: 2, impact: 2 }, { scenarioId: "fixture-intrusion", likelihood: 3, impact: 2 }] },
      { scenarios: [{ scenarioId: "fixture-intrusion", likelihood: 2, impact: 2, rationale: "x".repeat(2001) }] },
      { nope: true },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: "PUT", url, headers: H(assessor), payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect((await app.inject({ method: "PUT", url, headers: H(viewer), payload: { scenarios: [] } })).statusCode).toBe(403);
  });

  it("reports null likelihood and impact for excluded scenarios", async () => {
    const url = `/assessments/${fx.assessmentId}/risk/inputs`;
    const put = await app.inject({ method: "PUT", url, headers: H(assessor), payload: { scenarios: [{ scenarioId: "fixture-crypto", likelihood: 1, impact: 1, excluded: true }] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().scenarios[1]).toEqual({ scenarioId: "fixture-crypto", likelihood: null, impact: null, excluded: true });
    const r = RiskResult.parse((await app.inject({ url: `/assessments/${fx.assessmentId}/risk`, headers: H(viewer) })).json());
    expect(r.scenarios.map((s) => s.scenarioId)).not.toContain("fixture-crypto");
  });

  it("stores inputs and scores with the real engine", async () => {
    expect((await putAnswer(assessor, "no")).statusCode).toBe(201);
    const put = await app.inject({
      method: "PUT", url: `/assessments/${fx.assessmentId}/risk/inputs`, headers: H(assessor),
      payload: { scenarios: [{ scenarioId: "fixture-intrusion", likelihood: 4, impact: 5, rationale: "Open yard" }, { scenarioId: "fixture-crypto", likelihood: 3, impact: 3 }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().scenarios[0]).toEqual({ scenarioId: "fixture-intrusion", likelihood: 4, impact: 5, rationale: "Open yard", excluded: false });
    const res = await app.inject({ url: `/assessments/${fx.assessmentId}/risk`, headers: H(viewer) });
    expect(res.statusCode).toBe(200);
    const r = RiskResult.parse(res.json());
    expect(r.methodVersion).toBe(METHOD_VERSION);
    expect(r.scenarios.map((s) => s.scenarioId).sort()).toEqual(["fixture-crypto", "fixture-intrusion"]);
    const intrusion = r.scenarios.find((s) => s.scenarioId === "fixture-intrusion")!;
    expect(intrusion.inherent.score).toBe(20);
    expect(intrusion.residual.score).toBeLessThanOrEqual(20);
    expect(intrusion.explanation.length).toBeGreaterThan(0);
  });
});

describe("report preview and narrative", () => {
  let findingId: string;
  it("drafts a narrative as ai_draft from confirmed facts only", async () => {
    findingId = randomUUID();
    const f = await app.inject({
      method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${findingId}`, headers: H(assessor),
      payload: { id: findingId, assessmentId: fx.assessmentId, title: `Gate ${HOSTILE}`, description: `Desc ${HOSTILE}`, recommendation: "Fix =HYPERLINK(1)", severity: "high", status: "confirmed", controlIds: ["SC-PER-001"] },
    });
    expect(f.statusCode).toBe(201);
    const draftOnly = randomUUID();
    await app.inject({
      method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${draftOnly}`, headers: H(assessor),
      payload: { id: draftOnly, assessmentId: fx.assessmentId, title: "DRAFT-FINDING-NOT-CONFIRMED", severity: "low", controlIds: ["SC-PER-001"] },
    });
    const res = await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/narrative/draft`, headers: H(assessor), payload: { section: "executive_summary" } });
    expect(res.statusCode, res.body).toBe(200);
    const n = Narrative.parse(res.json());
    expect(n.status).toBe("ai_draft");
    expect(n.text).toContain("SECRET-UNREVIEWED-DRAFT");
    expect(textCalls.at(-1)!.userText).not.toContain("DRAFT-FINDING-NOT-CONFIRMED");
    expect((await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/narrative/draft`, headers: H(viewer), payload: { section: "methodology" } })).statusCode).toBe(403);
  });


  it("maps an ungrounded draft to 422 and a model failure to 502, storing nothing", async () => {
    const cases: [TextClient, number, string][] = [
      [{ complete: async () => ({ text: "Measured against ISO 27001 and SOC 2, the site is fine." }) }, 422, "ai_draft_rejected"],
      [{ complete: async () => { throw new Error("socket hang up"); } }, 502, "ai_failed"],
    ];
    for (const [client, status, code] of cases) {
      const other = await makeApp({}, { risk: { scenarios: FIXTURE_SCENARIOS }, text: client });
      const res = await other.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/narrative/draft`, headers: H(owner), payload: { section: "key_findings" } });
      expect(res.statusCode, res.body).toBe(status);
      expect(res.json().error.code).toBe(code);
      expect(res.body).not.toContain("socket hang up");
      await other.close();
    }
    const list = (await app.inject({ url: `/assessments/${fx.assessmentId}/narrative`, headers: H(viewer) })).json();
    expect(list.find((n: { section: string }) => n.section === "key_findings")).toBeUndefined();
  });

  it("answers 503 ai_not_configured without a text client", async () => {
    const plain = await makeApp({}, { risk: { scenarios: FIXTURE_SCENARIOS }, text: null });
    const res = await plain.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/narrative/draft`, headers: H(owner), payload: { section: "methodology" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("ai_not_configured");
    await plain.close();
  });

  it("preview escapes hostile text, omits unapproved AI text, and sends a strict CSP", async () => {
    const pid = randomUUID();
    await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: H(assessor), payload: { id: pid, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 10, findingId, controlIds: ["SC-PER-001"] } });
    const img = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#333" } }).jpeg().toBuffer();
    expect((await app.inject({ method: "PUT", url: `/photos/${pid}/content`, headers: { ...H(assessor), "content-type": "image/jpeg" }, payload: img })).statusCode).toBe(200);

    const res = await app.inject({ url: `/assessments/${fx.assessmentId}/report/preview`, headers: H(viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img src=x/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("SECRET-UNREVIEWED-DRAFT");
    expect(html).toContain("has not been reviewed");
    expect(html).not.toContain("DRAFT-FINDING-NOT-CONFIRMED");
    expect(html).toContain("pending expert review");
    expect(html).toMatch(/<img src="http:\/\/api\.test\/files\/[A-Za-z0-9_.-]+"/);
    // Phase 4: one <style> block holding only the validated brand custom properties, allowed by its CSP hash.
    expect(html).not.toMatch(/style=/i);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).toMatch(/<style>:root\{--brand-primary:#[0-9a-f]{6};--brand-accent:#[0-9a-f]{6};--brand-on-primary:#ffffff\}<\/style>/);
    expect(html).toContain('<link rel="stylesheet" href="http://localhost:5173/report-preview.css">');
    for (const cls of ["report-title", "report-section", "risk-table", "class=\"finding severity-high\"", "finding-photo", "notice", "level-"]) expect(html, cls).toContain(cls);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src http://localhost:5173");
    expect(csp).toContain("img-src http://api.test");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("script-src");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("approved text appears in the preview; approval is audited", async () => {
    const res = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/narrative/executive_summary`, headers: H(assessor), payload: { text: `Reviewed summary ${HOSTILE}`, approve: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "approved", model: expect.any(String) });
    const html = (await app.inject({ url: `/assessments/${fx.assessmentId}/report/preview`, headers: H(viewer) })).body;
    expect(html).toContain("Reviewed summary &lt;script&gt;");
    const list = (await app.inject({ url: `/assessments/${fx.assessmentId}/narrative`, headers: H(viewer) })).json();
    expect(list.map((n: unknown) => Narrative.parse(n).section)).toEqual(["executive_summary"]);
    const log = (await app.inject({ url: "/audit?limit=50", headers: H(owner) })).json();
    expect(log.find((r: { action: string }) => r.action === "narrative.approve")).toBeTruthy();
  });

  it("never replaces approved or edited text with a new AI draft unless replace is confirmed", async () => {
    const url = `/assessments/${fx.assessmentId}/narrative`;
    const put = await app.inject({ method: "PUT", url: `${url}/recommendations`, headers: H(assessor), payload: { text: "Assessor approved text", approve: true } });
    expect(put.statusCode, put.body).toBe(200);
    const refused = await app.inject({ method: "POST", url: `${url}/draft`, headers: H(assessor), payload: { section: "recommendations" } });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe("narrative_exists");
    const kept = (await app.inject({ method: "GET", url, headers: H(assessor) })).json() as { section: string; text: string; status: string }[];
    expect(kept.find((n) => n.section === "recommendations")).toMatchObject({ text: "Assessor approved text", status: "approved" });
    const replaced = await app.inject({ method: "POST", url: `${url}/draft`, headers: H(assessor), payload: { section: "recommendations", replace: true } });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().status).toBe("ai_draft");
  });
});

describe("assessment lock and reopen", () => {
  it("completing freezes a snapshot and locks REST, sync, risk input, and narrative writes", async () => {
    for (const status of ["in_progress", "in_review", "complete"]) {
      const r = await app.inject({ method: "PATCH", url: `/assessments/${fx.assessmentId}`, headers: H(assessor), payload: { status } });
      expect(r.statusCode, `${status}: ${r.body}`).toBe(200);
    }
    const first = RiskResult.parse((await app.inject({ url: `/assessments/${fx.assessmentId}/risk`, headers: H(viewer) })).json());
    await new Promise((r) => setTimeout(r, 15));
    const second = RiskResult.parse((await app.inject({ url: `/assessments/${fx.assessmentId}/risk`, headers: H(viewer) })).json());
    expect(second.computedAt).toBe(first.computedAt); // frozen snapshot, not recomputed

    const locked = async (p: Promise<{ statusCode: number; json: () => { error: { code: string } } }>) => {
      const r = await p;
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("assessment_locked");
    };
    await locked(putAnswer(assessor, "yes"));
    await locked(putAnswer(owner, "yes"));
    await locked(app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/risk/inputs`, headers: H(assessor), payload: { scenarios: [{ scenarioId: "fixture-crypto", likelihood: 1, impact: 1 }] } }));
    await locked(app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/narrative/methodology`, headers: H(assessor), payload: { text: "x" } }));
    await locked(app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/narrative/draft`, headers: H(assessor), payload: { section: "methodology" } }));
    await locked(app.inject({ method: "PATCH", url: `/assessments/${fx.assessmentId}`, headers: H(owner), payload: { title: "Renamed" } }));
    await locked(app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: H(assessor), payload: { id: randomUUID(), capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 10 } }));

    const id = randomUUID();
    const push = await app.inject({
      method: "POST", url: "/sync/push", headers: H(assessor),
      payload: { deviceId: randomUUID(), ops: [{ opId: randomUUID(), entity: "finding", action: "upsert", id, baseVersion: null, clientUpdatedAt: nowIso(), data: { id, assessmentId: fx.assessmentId, title: "Offline finding", severity: "low", controlIds: ["SC-PER-001"] } }] },
    });
    expect(push.json().results[0]).toMatchObject({ status: "rejected", error: { code: "assessment_locked" } });
  });

  it("only admins reopen, with a reason; reopen restores writes and is audited", async () => {
    const url = `/assessments/${fx.assessmentId}/reopen`;
    expect((await app.inject({ method: "POST", url, headers: H(assessor), payload: { reason: "fix typo" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: H(owner), payload: {} })).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url, headers: H(owner), payload: { reason: "Client asked for a correction" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("in_review");
    expect((await app.inject({ method: "POST", url, headers: H(owner), payload: { reason: "again please" } })).statusCode).toBe(409);
    const fid = randomUUID();
    const put = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${fid}`, headers: H(assessor), payload: { id: fid, assessmentId: fx.assessmentId, title: "After reopen", severity: "low", controlIds: ["SC-PER-001"] } });
    expect(put.statusCode).toBe(201);
    const id = randomUUID();
    const push = await app.inject({
      method: "POST", url: "/sync/push", headers: H(assessor),
      payload: { deviceId: randomUUID(), ops: [{ opId: randomUUID(), entity: "finding", action: "upsert", id, baseVersion: null, clientUpdatedAt: nowIso(), data: { id, assessmentId: fx.assessmentId, title: "Offline finding", severity: "low", controlIds: ["SC-PER-001"] } }] },
    });
    expect(push.json().results[0].status).toBe("applied");
    const rows = await asAppInTenant(await tenantId("acme-integrators"), async (q) =>
      (await q("SELECT action, details FROM audit_log WHERE entity_id = $1 AND action LIKE 'assessment.%' ORDER BY at", [fx.assessmentId])).rows);
    expect(rows.find((e) => e.action === "assessment.lock")).toBeTruthy();
    expect(rows.find((e) => e.action === "assessment.reopen")?.details.reason).toBe("Client asked for a correction");
  });
});

describe("comparison and dashboard", () => {
  it("compares sites and validates the id list", async () => {
    const other = await fieldFixture(app, owner, [], "Phase 3 other");
    const res = await app.inject({ url: `/risk/compare?assessmentIds=${fx.assessmentId},${other.assessmentId}`, headers: H(viewer) });
    expect(res.statusCode, res.body).toBe(200);
    const c = SiteComparison.parse(res.json());
    expect(c.sites.map((s) => s.assessmentId).sort()).toEqual([fx.assessmentId, other.assessmentId].sort());
    const many = Array.from({ length: 21 }, () => randomUUID()).join(",");
    expect((await app.inject({ url: `/risk/compare?assessmentIds=${many}`, headers: H(viewer) })).statusCode).toBe(400);
    expect((await app.inject({ url: `/risk/compare?assessmentIds=not-a-uuid`, headers: H(viewer) })).statusCode).toBe(400);
    expect((await app.inject({ url: `/risk/compare?assessmentIds=${randomUUID()}`, headers: H(viewer) })).statusCode).toBe(404);
  });

  it("dashboard summarizes status, severity, and top residual risks from snapshots", async () => {
    const a = await fieldFixture(app, owner, [], "Phase 3 dash");
    await app.inject({ method: "PUT", url: `/assessments/${a.assessmentId}/risk/inputs`, headers: H(owner), payload: { scenarios: [{ scenarioId: "fixture-intrusion", likelihood: 5, impact: 5 }] } });
    for (const status of ["in_progress", "in_review", "complete"]) {
      expect((await app.inject({ method: "PATCH", url: `/assessments/${a.assessmentId}`, headers: H(owner), payload: { status } })).statusCode).toBe(200);
    }
    const res = await app.inject({ url: "/dashboard", headers: H(viewer) });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.assessmentsByStatus.complete).toBeGreaterThanOrEqual(1);
    expect(d.findingsBySeverity.high).toBeGreaterThanOrEqual(1);
    expect(d.openHighFindings).toBe(d.findingsBySeverity.high + d.findingsBySeverity.critical);
    expect(d.topResidual[0]).toMatchObject({ assessmentId: a.assessmentId, siteName: "Site Phase 3 dash", scenarioName: "Fixture intrusion" });
    expect(d.recent.length).toBeGreaterThan(0);
  });
});
