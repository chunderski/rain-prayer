/**
 * QA Phase 2 review probes: upload edge cases (decompression bomb, zero-byte, truncated),
 * cross-tenant references inside sync payloads, finding provenance spoofing, area deletion
 * by assessors through sync, and future-dated clientUpdatedAt.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, fieldFixture, login, makeApp, nowIso, type FieldFixture } from "./helpers.js";

let app: FastifyInstance;
let owner: string;
let assessor: string;
let blue: string;
let fx: FieldFixture;
let blueFx: FieldFixture;
const deviceId = randomUUID();

const push = (ops: unknown[], token = assessor) => app.inject({ method: "POST", url: "/sync/push", headers: auth(token), payload: { deviceId, ops } });
const op = (entity: string, id: string, data: unknown, baseVersion: number | null, clientUpdatedAt = nowIso(), action = "upsert") => ({
  opId: randomUUID(), entity, action, id, data, baseVersion, clientUpdatedAt,
});
const finding = (id: string, over: Record<string, unknown> = {}, a = fx.assessmentId) => ({
  id, assessmentId: a, title: "Gate left open", severity: "medium", controlIds: ["SC-PER-001"], ...over,
});

beforeAll(async () => {
  app = await makeApp();
  owner = (await login(app, "owner@acme.test")).token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  blue = (await login(app, "owner@bluefield.test")).token;
  fx = await fieldFixture(app, owner, [a.body.session.user.id], "QA2");
  blueFx = await fieldFixture(app, blue, [], "QA2 blue");
});
afterAll(() => app.close());

async function newPhoto() {
  const id = randomUUID();
  const r = await app.inject({
    method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: auth(assessor),
    payload: { id, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 1000 },
  });
  expect(r.statusCode).toBe(201);
  return id;
}
const upload = (id: string, body: Buffer, type = "image/jpeg") =>
  app.inject({ method: "PUT", url: `/photos/${id}/content`, headers: { ...auth(assessor), "content-type": type }, payload: body });

describe("upload edge cases", () => {
  it("rejects a decompression bomb (PNG over 100 MP) with 415 and stores nothing", async () => {
    // 12000 x 12000 = 144 MP of one colour compresses to a few hundred KB.
    const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: "#000" }, limitInputPixels: false })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(15 * 1024 * 1024);
    const id = await newPhoto();
    const res = await upload(id, bomb, "image/png");
    expect(res.statusCode).toBe(415);
    const url = await app.inject({ url: `/photos/${id}/url`, headers: auth(assessor) });
    expect(url.statusCode).toBe(409);
  }, 30_000);

  it("rejects zero-byte and truncated JPEG uploads", async () => {
    const id = await newPhoto();
    expect((await upload(id, Buffer.alloc(0))).statusCode).toBeGreaterThanOrEqual(400);
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3a3" } }).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    const res = await upload(id, truncated);
    expect(res.statusCode).toBe(415);
  });
});

describe("sync payload references", () => {
  it("rejects another tenant's area, asset, and finding ids inside op payloads", async () => {
    // Tenant B records.
    const bArea = (await app.inject({ method: "POST", url: `/sites/${blueFx.siteId}/areas`, headers: auth(blue), payload: { id: randomUUID(), siteId: blueFx.siteId, name: "B lobby" } })).json();
    expect(bArea.id).toBeTruthy();
    const bFinding = randomUUID();
    expect((await app.inject({ method: "PUT", url: `/assessments/${blueFx.assessmentId}/findings/${bFinding}`, headers: auth(blue), payload: finding(bFinding, {}, blueFx.assessmentId) })).statusCode).toBe(201);

    const f = randomUUID();
    const p = randomUUID();
    const res = (await push([
      op("finding", f, finding(f, { areaId: bArea.id }), null),
      op("photo_meta", p, { id: p, assessmentId: fx.assessmentId, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 10, findingId: bFinding }, null),
    ])).json().results;
    expect(res.map((r: { status: string; error?: { code: string } }) => [r.status, r.error?.code])).toEqual([
      ["rejected", "invalid_reference"],
      ["rejected", "invalid_reference"],
    ]);
    const mine = (await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(assessor) })).json();
    expect(mine.some((x: { id: string }) => x.id === f)).toBe(false);
  });
});

describe("finding provenance", () => {
  it("ignores client-supplied source and suggestionId on sync and REST", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const spoof = { source: "ai_accepted", suggestionId: randomUUID() };
    const s = (await push([op("finding", a, finding(a, spoof), null)])).json().results[0];
    expect(["applied", "rejected"]).toContain(s.status);
    const r = await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${b}`, headers: auth(assessor), payload: finding(b, spoof) });
    expect([201, 400]).toContain(r.statusCode);
    const list = (await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(assessor) })).json() as { id: string; source: string; suggestionId: string | null }[];
    for (const x of list.filter((x) => x.id === a || x.id === b)) {
      expect(x.source).toBe("assessor");
      expect(x.suggestionId ?? null).toBeNull();
    }
  });
});

describe("role parity between REST and sync", () => {
  it("an assessor cannot delete an area through sync (DELETE /areas is admin only)", async () => {
    const areaId = randomUUID();
    const created = (await push([op("area", areaId, { id: areaId, siteId: fx.siteId, name: "Loading dock" }, null)])).json().results[0];
    expect(created.status).toBe("applied");
    expect((await app.inject({ method: "DELETE", url: `/areas/${areaId}`, headers: auth(assessor) })).statusCode).toBe(403);
    const del = (await push([op("area", areaId, undefined, created.version, nowIso(), "delete")])).json().results[0];
    expect(del).toMatchObject({ status: "rejected", error: { code: "forbidden" } });
    const areas = (await app.inject({ url: `/sites/${fx.siteId}/areas`, headers: auth(assessor) })).json();
    expect(areas.some((x: { id: string }) => x.id === areaId)).toBe(true);
  });
});

describe("clock skew", () => {
  it("a far-future clientUpdatedAt cannot pin fields against later edits", async () => {
    const id = randomUUID();
    const future = new Date(Date.now() + 50 * 365 * 24 * 3600 * 1000).toISOString();
    const first = (await push([op("finding", id, finding(id, { title: "Planted title" }), null, future)])).json().results[0];
    expect(first.status).toBe("applied");
    // A second device that never saw the record edits it with an honest clock a minute later.
    const later = new Date(Date.now() + 60_000).toISOString();
    const second = (await push([op("finding", id, finding(id, { title: "Honest edit" }), 0, later)])).json().results[0];
    expect(second.status).toBe("conflict");
    expect(second.server.title).toBe("Honest edit");
  });
});
