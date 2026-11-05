/**
 * HTML renderer for the report preview. Every model string is HTML-escaped; there is no script, no
 * inline event handler, and no inline style attribute. The single <style> block is allowed by hash in
 * the Content-Security-Policy, and images are allowed only from the origins of the signed URLs used.
 */
import { createHash } from "node:crypto";
import type { Block, ReportDoc } from "./model.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);

const STYLE = [
  "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2933;max-width:860px;margin:0 auto;padding:24px;line-height:1.5}",
  "header{border-bottom:2px solid #1f2933;margin-bottom:24px}",
  ".brand{text-transform:uppercase;letter-spacing:.08em;font-size:.8rem;color:#52606d}",
  "table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #cbd2d9;padding:6px 8px;text-align:left;vertical-align:top}",
  "th{background:#f0f4f8}.muted{color:#616e7c;font-size:.9rem}.notice{background:#fffbea;border-left:4px solid #f0b429;padding:8px 12px}",
  ".placeholder{border:1px dashed #9aa5b1;color:#616e7c;padding:8px 12px;font-style:italic}",
  "figure{margin:12px 0}figure img{max-width:100%;height:auto;border:1px solid #cbd2d9}figcaption{font-size:.85rem;color:#616e7c}",
  "footer{margin-top:32px;font-size:.8rem;color:#616e7c}",
].join("");
const STYLE_HASH = `sha256-${createHash("sha256").update(STYLE).digest("base64")}`;

/** Resolved image URLs by photo id (signed, short-lived); missing ids render as a text placeholder. */
export type ImageUrls = Map<string, string>;

function block(b: Block, urls: ImageUrls): string {
  switch (b.type) {
    case "heading":
      return `<h${b.level + 1}>${escapeHtml(b.text)}</h${b.level + 1}>`;
    case "paragraph":
      return `<p${b.tone && b.tone !== "normal" ? ` class="${b.tone}"` : ""}>${escapeHtml(b.text)}</p>`;
    case "placeholder":
      return `<p class="placeholder">${escapeHtml(b.text)}</p>`;
    case "bullets":
      return `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
    case "table":
      return `<table><thead><tr>${b.header.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "image": {
      const url = urls.get(b.image.photoId);
      if (!url) return `<p class="placeholder">${escapeHtml(`Photo unavailable: ${b.image.caption || b.image.photoId}`)}</p>`;
      return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(b.image.caption || "Finding photo")}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${escapeHtml(b.image.caption)}</figcaption></figure>`;
    }
  }
}

export function contentSecurityPolicy(urls: ImageUrls, frameAncestors: string[]): string {
  const origins = [...new Set([...urls.values()].map((u) => new URL(u).origin))].sort();
  return [
    "default-src 'none'",
    `img-src ${origins.length ? origins.join(" ") : "'none'"}`,
    `style-src '${STYLE_HASH}'`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
  ].join("; ");
}

export function renderHtml(doc: ReportDoc, urls: ImageUrls, frameAncestors: string[]): { html: string; csp: string } {
  const csp = contentSecurityPolicy(urls, frameAncestors);
  // The meta copy (without frame-ancestors, which meta cannot carry) keeps the policy when the PWA shows the HTML in a srcdoc frame.
  const metaCsp = csp.split("; ").filter((d) => !d.startsWith("frame-ancestors")).join("; ");
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp)}">`,
    `<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(doc.title)}</title><style>${STYLE}</style></head><body>`,
    `<header><div class="brand">${escapeHtml(doc.brandName)}</div><h1>${escapeHtml(doc.title)}</h1><p class="muted">${escapeHtml(doc.subtitle)}</p></header>`,
    `<main>${doc.blocks.map((b) => block(b, urls)).join("\n")}</main>`,
    `<footer>${escapeHtml(`Preview generated ${doc.generatedAt}; ${doc.templateVersion}. Photo links expire after a few minutes.`)}</footer>`,
    "</body></html>",
  ].join("\n");
  return { html, csp };
}
