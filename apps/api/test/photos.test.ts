/** Photo pipeline: content checks, re-encoding without metadata, signed URLs, GPS policy. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken, storageSigningKey, verifyToken } from "../src/storage/local.js";
import { auth, fieldFixture, login, makeApp, nowIso, testConfig, TEST_STORAGE_DIR, type FieldFixture } from "./helpers.js";

let app: FastifyInstance;
let owner: string;
let assessor: string;
let viewer: string;
let fx: FieldFixture;
let tid: string;

const GPS_IFD = Buffer.from([0x25, 0x88]); // EXIF tag 0x8825 (GPS IFD pointer), little endian

async function jpegWithGps(width = 640, height = 480) {
  return sharp({ create: { width, height, channels: 3, background: "#a33" } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Make: "SecretCam", Copyright: "Owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" } } })
    .toBuffer();
}

async function createPhoto(over: Record<string, unknown> = {}, token = assessor) {
  const id = randomUUID();
  const res = await app.inject({
    method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: auth(token),
    payload: { id, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 1000, ...over },
  });
  return { id, res };
}

const upload = (id: string, body: Buffer, type = "image/jpeg", token = assessor) =>
  app.inject({ method: "PUT", url: `/photos/${id}/content`, headers: { ...auth(token), "content-type": type }, payload: body });

const storedPath = (id: string, thumb = false) => join(TEST_STORAGE_DIR, "tenants", tid, "photos", `${id}${thumb ? ".thumb" : ""}.jpg`);

beforeAll(async () => {
  app = await makeApp();
  owner = (await login(app, "owner@acme.test")).token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  tid = a.body.session.tenant.id;
  viewer = (await login(app, "viewer@acme.test")).token;
  fx = await fieldFixture(app, owner, [a.body.session.user.id], "Photos");
});
afterAll(() => app.close());

describe("photo metadata", () => {
  it("creates pending_upload, idempotent on id; viewer cannot create", async () => {
    const { id, res } = await createPhoto({ controlIds: ["SC-PER-001"], assetType: "fence" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id, status: "pending_upload", sha256: null, width: null, controlIds: ["SC-PER-001"], version: 1 });
    const again = await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: auth(assessor), payload: { id, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 5 } });
    expect(again.statusCode).toBe(201);
    expect(again.json().byteSize).toBe(1000);
    expect((await createPhoto({}, viewer)).res.statusCode).toBe(403);
  });

  it("drops GPS unless the tenant allows it, and says so", async () => {
    const gps = { lat: 51.5, lon: -0.12, accuracyM: 5 };
    const { res } = await createPhoto({ gps });
    expect(res.headers["x-sentinel-gps"]).toBe("dropped");
    expect(res.json().gps).toBeNull();
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { allowGps: true } });
    const ok = await createPhoto({ gps });
    expect(ok.res.headers["x-sentinel-gps"]).toBeUndefined();
    expect(ok.res.json().gps).toEqual(gps);
    await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(owner), payload: { allowGps: false } });
  });

  it("patches tags and rejects unknown controls", async () => {
    const { id } = await createPhoto();
    const r = await app.inject({ method: "PATCH", url: `/photos/${id}`, headers: auth(assessor), payload: { severity: "high", notes: "Gap at post 4" } });
    expect(r.json()).toMatchObject({ severity: "high", notes: "Gap at post 4", version: 2 });
    const bad = await app.inject({ method: "PATCH", url: `/photos/${id}`, headers: auth(assessor), payload: { controlIds: ["SC-ZZZ-001"] } });
    expect(bad.json().error.code).toBe("unknown_control");
  });
});

describe("photo content", () => {
  it("re-encodes a JPEG with EXIF GPS into a JPEG with no metadata", async () => {
    const input = await jpegWithGps();
    const before = await sharp(input).metadata();
    expect(before.exif?.includes(GPS_IFD)).toBe(true);
    const { id } = await createPhoto();
    const res = await upload(id, input);
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ status: "stored", width: 640, height: 480 });
    expect(p.sha256).toMatch(/^[a-f0-9]{64}$/);
    const stored = readFileSync(storedPath(id));
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(stored.includes(Buffer.from("SecretCam"))).toBe(false);
    expect(stored.includes(Buffer.from("Exif\0\0"))).toBe(false);
    const thumb = await sharp(readFileSync(storedPath(id, true))).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBe(512);
  });

  it("accepts PNG (re-encoded to JPEG) and caps the long edge at 4096", async () => {
    const png = await sharp({ create: { width: 5000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer();
    const { id } = await createPhoto({ contentType: "image/png" });
    const res = await upload(id, png, "image/png");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 4096, height: 819 });
    expect((await sharp(readFileSync(storedPath(id))).metadata()).format).toBe("jpeg");
  });

  it("checks magic bytes, not the header: a PNG labelled image/jpeg is still decoded as PNG", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer();
    const { id } = await createPhoto();
    expect((await upload(id, png, "image/jpeg")).statusCode).toBe(200);
  });

  it("rejects non-images and polyglots with 415 unsupported_media", async () => {
    const { id } = await createPhoto();
    const cases: [string, Buffer][] = [
      ["text as jpeg", Buffer.from("<html><script>alert(1)</script></html>")],
      ["pdf", Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF")],
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["gif polyglot", Buffer.concat([Buffer.from("GIF89a"), Buffer.from("/*<script>alert(1)</script>*/")])],
      ["jpeg magic then html", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0<html><script>alert(1)</script>")])],
      ["fake heic", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(12), Buffer.from("garbage")])],
    ];
    for (const [name, body] of cases) {
      const res = await upload(id, body);
      expect(res.statusCode, name).toBe(415);
      expect(res.json().error.code, name).toBe("unsupported_media");
    }
    expect((await upload(id, cases[5]![1], "image/heic")).json().error.message).toMatch(/HEIC/);
    const wrongType = await upload(id, await jpegWithGps(), "application/octet-stream");
    expect(wrongType.statusCode).toBe(415);
  });

  it("drops data appended after a valid image (polyglot payload never stored)", async () => {
    const poly = Buffer.concat([await jpegWithGps(32, 32), Buffer.from("<script>alert('pwn')</script>")]);
    const { id } = await createPhoto();
    expect((await upload(id, poly)).statusCode).toBe(200);
    expect(readFileSync(storedPath(id)).includes(Buffer.from("<script>"))).toBe(false);
  });

  it("rejects bodies over 15 MB with 413", async () => {
    const { id } = await createPhoto();
    const res = await upload(id, Buffer.alloc(15 * 1024 * 1024 + 10, 0xff));
    expect(res.statusCode).toBe(413);
  });
});

describe("signed URLs (local driver)", () => {
  let id: string;
  beforeAll(async () => {
    id = (await createPhoto()).id;
    await upload(id, await jpegWithGps());
  });

  it("409 before upload; viewer gets a working URL for full and thumb", async () => {
    const pending = (await createPhoto()).id;
    expect((await app.inject({ url: `/photos/${pending}/url`, headers: auth(viewer) })).statusCode).toBe(409);
    for (const variant of ["full", "thumb"]) {
      const r = await app.inject({ url: `/photos/${id}/url?variant=${variant}`, headers: auth(viewer) });
      expect(r.statusCode).toBe(200);
      const { url, expiresAt } = r.json();
      expect(url.startsWith("http://api.test/files/")).toBe(true);
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(290_000);
      const file = await app.inject({ url: new URL(url).pathname });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toBe("image/jpeg");
      expect(file.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect((await sharp(file.rawPayload).metadata()).exif).toBeUndefined();
    }
  });

  it("expires", async () => {
    const key = storageSigningKey(testConfig());
    const objectKey = `tenants/${tid}/photos/${id}.jpg`;
    const expired = signToken(key, objectKey, Math.floor(Date.now() / 1000) - 1);
    expect((await app.inject({ url: `/files/${expired}` })).statusCode).toBe(404);
    const live = signToken(key, objectKey, Math.floor(Date.now() / 1000) + 60);
    expect(verifyToken(key, live)).toBe(objectKey);
    expect(verifyToken(key, live, Math.floor(Date.now() / 1000) + 61)).toBeNull();
  });

  it("cannot be reused for another object, forged, or signed with the JWT secret", async () => {
    const { url } = (await app.inject({ url: `/photos/${id}/url`, headers: auth(viewer) })).json();
    const token = new URL(url).pathname.split("/").pop()!;
    const [payload, mac] = token.split(".");
    const other = (await createPhoto()).id;
    await upload(other, await jpegWithGps(16, 16));
    const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), k: `tenants/${tid}/photos/${other}.jpg` })).toString("base64url");
    expect((await app.inject({ url: `/files/${swapped}.${mac}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/files/${payload}.${"A".repeat(43)}` })).statusCode).toBe(404);
    const withJwtKey = signToken(Buffer.from(testConfig().JWT_SECRET), `tenants/${tid}/photos/${other}.jpg`, Math.floor(Date.now() / 1000) + 60);
    expect((await app.inject({ url: `/files/${withJwtKey}` })).statusCode).toBe(404);
    const traversal = signToken(storageSigningKey(testConfig()), "../../etc/passwd", Math.floor(Date.now() / 1000) + 60);
    expect((await app.inject({ url: `/files/${traversal}` })).statusCode).toBe(404);
  });

  it("delete removes the objects and the URL stops working", async () => {
    const { url } = (await app.inject({ url: `/photos/${id}/url`, headers: auth(viewer) })).json();
    expect((await app.inject({ method: "DELETE", url: `/photos/${id}`, headers: auth(assessor) })).statusCode).toBe(204);
    expect((await app.inject({ url: new URL(url).pathname })).statusCode).toBe(404);
    expect((await app.inject({ url: `/photos/${id}/url`, headers: auth(viewer) })).statusCode).toBe(404);
  });
});
