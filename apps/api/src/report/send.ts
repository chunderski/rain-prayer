/** Shared response helpers for the HTML previews (report, portal report, quote). */
import type { FastifyReply } from "fastify";
import type { Config } from "../config.js";
import type { ObjectStorage } from "../storage/index.js";
import type { ImageUrls } from "./html.js";
import { docImages, LOGO_IMAGE_ID, type ReportDoc } from "./model.js";

/** Signed, short-lived URLs for every photo in the document plus the brand logo. */
export async function signedDocUrls(cfg: Config, storage: ObjectStorage, doc: Pick<ReportDoc, "blocks" | "brand">): Promise<ImageUrls> {
  const urls: ImageUrls = new Map();
  for (const img of docImages(doc as ReportDoc)) {
    if (!urls.has(img.photoId)) urls.set(img.photoId, (await storage.signedUrl(img.storageKey, cfg.SIGNED_URL_TTL_SECONDS)).url);
  }
  if (doc.brand.logoKey) urls.set(LOGO_IMAGE_ID, (await storage.signedUrl(doc.brand.logoKey, cfg.SIGNED_URL_TTL_SECONDS)).url);
  return urls;
}

/**
 * Sends preview HTML with its strict CSP. QA R3-6: X-Frame-Options (set globally by helmet) is removed
 * here so embedding follows the frame-ancestors allowlist alone; Cache-Control: no-store still comes
 * from the global onSend hook (QA R3-7).
 */
export function sendHtml(reply: FastifyReply, html: string, csp: string, headers: Record<string, string> = {}) {
  reply.removeHeader("x-frame-options");
  reply
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", csp)
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff");
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);
  return reply.send(html);
}
