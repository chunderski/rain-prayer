/**
 * Local-disk driver (STORAGE_DRIVER=local). Signed URL token format:
 *   base64url(JSON {k: key, e: expiryEpochSeconds}) "." base64url(HMAC-SHA256(signingKey, payloadPart))
 * The token grants exactly one object until it expires. The signing key is STORAGE_SIGNING_SECRET, or
 * HMAC-SHA256(JWT_SECRET, "sentinel-assess/storage-url/v1") so it never equals the JWT key.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { assertKey, contentTypeOfKey, OBJECT_KEY, type ObjectStorage } from "./index.js";

const LABEL = "sentinel-assess/storage-url/v1";

export function storageSigningKey(cfg: Config): Buffer {
  if (cfg.STORAGE_SIGNING_SECRET) return Buffer.from(cfg.STORAGE_SIGNING_SECRET, "utf8");
  return createHmac("sha256", cfg.JWT_SECRET).update(LABEL).digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signToken(signingKey: Buffer, key: string, expiresAtSec: number): string {
  const payload = b64(JSON.stringify({ k: key, e: expiresAtSec }));
  const mac = createHmac("sha256", signingKey).update(payload).digest();
  return `${payload}.${b64(mac)}`;
}

/** Returns the object key the token grants, or null when the token is malformed, forged, or expired. */
export function verifyToken(signingKey: Buffer, token: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const m = /^([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const expected = createHmac("sha256", signingKey).update(m[1]!).digest();
  const given = Buffer.from(m[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as { k?: unknown; e?: unknown };
    if (typeof p.k !== "string" || typeof p.e !== "number" || !OBJECT_KEY.test(p.k)) return null;
    if (p.e <= nowSec) return null;
    return p.k;
  } catch {
    return null;
  }
}

export function createLocalStorage(cfg: Config): ObjectStorage & { root: string; readByToken(token: string): Promise<{ body: Buffer; contentType: string } | null> } {
  const root = resolve(cfg.LOCAL_STORAGE_DIR);
  const signingKey = storageSigningKey(cfg);
  const pathOf = (key: string) => {
    assertKey(key);
    const p = join(root, key);
    if (!p.startsWith(root + "/")) throw new Error("object key escapes storage root");
    return p;
  };
  return {
    driver: "local",
    root,
    async put(key, body) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true, mode: 0o700 });
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, p);
    },
    async get(key) {
      return readFile(pathOf(key));
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
    async signedUrl(key, ttlSeconds) {
      assertKey(key);
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return { url: `${cfg.publicUrl}/files/${signToken(signingKey, key, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
    async readByToken(token) {
      const key = verifyToken(signingKey, token);
      if (!key) return null;
      try {
        return { body: await readFile(pathOf(key)), contentType: contentTypeOfKey(key) };
      } catch {
        return null;
      }
    },
  };
}
