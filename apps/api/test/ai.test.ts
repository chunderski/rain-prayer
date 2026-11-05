/** AI photo analysis with a fake vision client: suggestions only; findings and tags only through review. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VisionError, type VisionClient } from "@sentinel/ai";
import { sanitizeOutput } from "../src/routes/ai.js";
import { auth, fieldFixture, login, makeApp, nowIso, type FieldFixture } from "./helpers.js";

const MODEL_OUTPUT = {
  imageQuality: "ok",
  assetType: { value: "fence", confidence: 0.9 },
  condition: { rating: "poor", summary: "Chain-link fence with a cut section.", confidence: 0.8 },
  deficiencies: [{ description: "Cut in fence fabric near post", severity: "high", confidence: 0.8, controlIds: ["SC-PER-001", "SC-ZZZ-999"] }],
  controls: [
    { id: "SC-PER-001", confidence: 0.9, rationale: "Perimeter fence visible" },
    { id: "SC-ABC-123", confidence: 0.4, rationale: "Not a real control" },
  ],
  draftFindings: [
    { title: "Perimeter fence breach", description: "The fence fabric is cut.", recommendation: "Repair the fabric.", severity: "high", controlIds: ["SC-PER-001", "SC-ZZZ-001"], confidence: 0.8 },
    { title: "Only bogus controls", description: "x", recommendation: "y", severity: "low", controlIds: ["SC-ZZZ-002"], confidence: 0.3 },
  ],
  cautions: [],
};

const calls: { model: string; image: Uint8Array; userText: string }[] = [];
let mode: "ok" | "refuse" = "ok";
const fake: VisionClient = {
  async analyze(req) {
    calls.push(req);
    if (mode === "refuse") throw new VisionError("refused", "model refused");
    return { text: JSON.stringify(MODEL_OUTPUT), usage: { inputTokens: 10, outputTokens: 20 } };
  },
};

let app: FastifyInstance;
let owner: string;
let assessor: string;
let viewer: string;
let fx: FieldFixture;

async function storedPhoto(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await app.inject({
    method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: auth(assessor),
    payload: { id, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 100, notes: "SECRET NOTE", ...over },
  });
  const img = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#777" } }).jpeg().toBuffer();
  const up = await app.inject({ method: "PUT", url: `/photos/${id}/content`, headers: { ...auth(assessor), "content-type": "image/jpeg" }, payload: img });
  expect(up.statusCode).toBe(200);
  return id;
}
const analyze = (id: string, token = assessor, a = app) => a.inject({ method: "POST", url: `/photos/${id}/analyze`, headers: auth(token), payload: {} });
const review = (id: string, body: object) => app.inject({ method: "POST", url: `/suggestions/${id}/review`, headers: auth(assessor), payload: body });

beforeAll(async () => {
  app = await makeApp({ ANTHROPIC_VISION_MODEL: "test-vision-model" }, { vision: fake });
  owner = (await login(app, "owner@acme.test")).token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  viewer = (await login(app, "viewer@acme.test")).token;
  fx = await fieldFixture(app, owner, [a.body.session.user.id], "AI");
});
afterAll(() => app.close());

describe("analyze", () => {
  it("stores a suggested AiSuggestion with unknown control ids dropped and changes nothing else", async () => {
    const id = await storedPhoto({ assetType: "fence" });
    const res = await analyze(id);
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ photoId: id, assessmentId: fx.assessmentId, status: "suggested", error: null, reviewedAt: null });
    expect(s.output.controls.map((c: { id: string }) => c.id)).toEqual(["SC-PER-001"]);
    expect(s.output.deficiencies[0].controlIds).toEqual(["SC-PER-001"]);
    expect(s.output.draftFindings).toHaveLength(1);
    expect(s.output.draftFindings[0].controlIds).toEqual(["SC-PER-001"]);
    // The model got the configured model id, a downscaled image, and no notes (aiShareContext is off).
    const call = calls.at(-1)!;
    expect(call.model).toBe("test-vision-model");
    const sent = await sharp(Buffer.from(call.image)).metadata();
    expect(Math.max(sent.width!, sent.height!)).toBe(1568);
    expect(call.userText).not.toContain("SECRET NOTE");
    // Nothing became a finding or a tag.
    expect((await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(viewer) })).json()).toEqual([]);
    const list = (await app.inject({ url: `/photos/${id}/suggestions`, headers: auth(viewer) })).json();
    expect(list).toHaveLength(1);
  });

  it("passes notes only when the tenant allows sharing context", async () => {
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { aiShareContext: true } });
    const id = await storedPhoto();
    await analyze(id);
    expect(calls.at(-1)!.userText).toContain("SECRET NOTE");
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { aiShareContext: false } });
  });

  it("records a refusal as a failed suggestion", async () => {
    mode = "refuse";
    const id = await storedPhoto();
    const res = await analyze(id);
    mode = "ok";
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "failed", error: "refused", output: null });
  });

  it("409 ai_disabled, 409 before upload, 503 without a key, viewer 403", async () => {
    const id = await storedPhoto();
    expect((await analyze(id, viewer)).statusCode).toBe(403);
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { aiPhotoAnalysis: false } });
    expect((await analyze(id)).json().error.code).toBe("ai_disabled");
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { aiPhotoAnalysis: true } });
    const pending = randomUUID();
    await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: auth(assessor), payload: { id: pending, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 1 } });
    expect((await analyze(pending)).json().error.code).toBe("photo_not_uploaded");
    const noKey = await makeApp({ ANTHROPIC_API_KEY: "sk-ant-replace-me" });
    const r = await analyze(id, (await login(noKey, "assessor@acme.test")).token, noKey);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("ai_not_configured");
    await noKey.close();
  });

  it("rate limits analyses per user", async () => {
    const limited = await makeApp({ AI_ANALYZE_RATE_LIMIT_PER_HOUR: "1" }, { vision: fake });
    const t = (await login(limited, "assessor@acme.test")).token;
    const id = await storedPhoto();
    expect((await analyze(id, t, limited)).statusCode).toBe(201);
    const second = await analyze(id, t, limited);
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    await limited.close();
  });
});

describe("review", () => {
  it("accept creates findings (ai_accepted) and applies tags in one step; cannot review twice", async () => {
    const id = await storedPhoto();
    const s = (await analyze(id)).json();
    const res = await review(s.id, { decision: "accept" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestion).toMatchObject({ status: "accepted" });
    expect(body.suggestion.reviewedBy).toBeTruthy();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ source: "ai_accepted", suggestionId: s.id, title: "Perimeter fence breach", controlIds: ["SC-PER-001"], status: "draft" });
    expect(body.photo).toMatchObject({ assetType: "fence", severity: "high", controlIds: ["SC-PER-001"], findingId: body.findings[0].id });
    expect((await review(s.id, { decision: "accept" })).json().error.code).toBe("not_reviewable");
    const log = (await app.inject({ url: "/audit?limit=20", headers: auth(owner) })).json();
    expect(log.find((r: { action: string; entityId: string }) => r.action === "ai.suggestion.accept" && r.entityId === s.id)).toBeTruthy();
  });

  it("edit creates ai_edited findings with unknown controls dropped server-side", async () => {
    const id = await storedPhoto();
    const s = (await analyze(id)).json();
    const res = await review(s.id, {
      decision: "edit",
      findings: [{ title: "Edited title", description: "Edited", severity: "medium", controlIds: ["SC-PER-001", "SC-ZZZ-777"] }],
      tags: { assetType: "gate", controlIds: ["SC-PER-002", "SC-ZZZ-888"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().findings[0]).toMatchObject({ source: "ai_edited", controlIds: ["SC-PER-001"], severity: "medium" });
    expect(res.json().photo).toMatchObject({ assetType: "gate", controlIds: ["SC-PER-002"] });
    const onlyUnknown = (await analyze(await storedPhoto())).json();
    const bad = await review(onlyUnknown.id, { decision: "edit", findings: [{ title: "Bad", description: "", severity: "low", controlIds: ["SC-ZZZ-001"] }] });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: `/photos/${id}/suggestions`, headers: auth(viewer) })).json()[0].status).toBe("edited");
  });

  it("reject records the reason and creates nothing", async () => {
    const id = await storedPhoto();
    const before = (await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(viewer) })).json().length;
    const s = (await analyze(id)).json();
    const res = await review(s.id, { decision: "reject", reason: "Wrong fence" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ suggestion: { status: "rejected" }, findings: [] });
    expect(res.json().photo).toMatchObject({ assetType: null, controlIds: [], version: 2 });
    expect((await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(viewer) })).json().length).toBe(before);
  });
});

describe("sanitizeOutput (defense in depth)", () => {
  it("drops controls outside the scope even if the AI package let them through", () => {
    const scope = { controls: new Map([["SC-PER-001", {}]]) } as never;
    const out = sanitizeOutput(MODEL_OUTPUT, scope);
    expect(out.controls.map((c) => c.id)).toEqual(["SC-PER-001"]);
    expect(out.draftFindings).toHaveLength(1);
  });
});
