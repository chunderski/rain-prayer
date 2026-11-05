/**
 * Refresh token encryption at rest: AES-256-GCM with GOOGLE_TOKEN_KEY, a random 96-bit IV per write,
 * and the tenant id as additional authenticated data, so a ciphertext copied to another tenant's row
 * fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function sealToken(key: Buffer, tenantId: string, token: string): Sealed {
  if (key.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`sentinel-google-token:${tenantId}`));
  const ciphertext = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

export function openToken(key: Buffer, tenantId: string, s: Sealed): string {
  const d = createDecipheriv("aes-256-gcm", key, s.iv);
  d.setAAD(Buffer.from(`sentinel-google-token:${tenantId}`));
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.ciphertext), d.final()]).toString("utf8");
}
