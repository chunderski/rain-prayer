/**
 * HTML renderer for the report preview: semantic, class-based markup with no script, no inline style
 * attribute, no <style> block, and no event handler. Every model string is HTML-escaped. Styling comes
 * from the PWA's public/report-preview.css (linked from WEB_ORIGIN), using these classes:
 *   report, report-header, report-brand, report-title, report-subtitle, report-section, report-footer,
 *   risk-table, level-very_low .. level-very_high, finding, severity-<severity>, finding-photo,
 *   notice, muted, placeholder.
 * Images are allowed by CSP only from the origins of the signed URLs used.
 */
import type { Block, ReportDoc } from "./model.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);
/** Class tokens come from fixed enums; anything else is dropped. */
const token = (s: string) => (/^[a-z_]{1,20}$/.test(s) ? s : "unknown");

export const PREVIEW_STYLESHEET = "/report-preview.css";

/** Resolved image URLs by photo id (signed, short-lived); missing ids render as a text placeholder. */
export type ImageUrls = Map<string, string>;

function block(b: Block, urls: ImageUrls): string {
  switch (b.type) {
    case "heading":
      return `<h${b.level + 1}>${escapeHtml(b.text)}</h${b.level + 1}>`;
    case "paragraph": {
      const cls = [b.tone && b.tone !== "normal" ? b.tone : null, b.level ? `level-${token(b.level)}` : null].filter(Boolean);
      return `<p${cls.length ? ` class="${cls.join(" ")}"` : ""}>${escapeHtml(b.text)}</p>`;
    }
    case "placeholder":
      return `<p class="placeholder">${escapeHtml(b.text)}</p>`;
    case "bullets":
      return `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
    case "table": {
      const rows = b.rows
        .map((r, i) => {
          const lvl = b.rowLevels?.[i];
          return `<tr${lvl ? ` class="level-${token(lvl)}"` : ""}>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
        })
        .join("");
      return `<table${b.variant === "risk" ? ' class="risk-table"' : ""}><thead><tr>${b.header.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case "image": {
      const url = urls.get(b.image.photoId);
      if (!url) return `<p class="placeholder">${escapeHtml(`Photo unavailable: ${b.image.caption || b.image.photoId}`)}</p>`;
      return `<figure class="finding-photo"><img src="${escapeHtml(url)}" alt="${escapeHtml(b.image.caption || "Finding photo")}" loading="lazy" referrerpolicy="no-referrer"><figcaption>${escapeHtml(b.image.caption)}</figcaption></figure>`;
    }
    case "finding":
      return `<article class="finding severity-${token(b.severity)}"><h4>${escapeHtml(b.title)}</h4>${b.blocks.map((x) => block(x, urls)).join("")}</article>`;
  }
}

/** Groups blocks into <section class="report-section"> elements, one per top-level heading. */
function sections(blocks: Block[], urls: ImageUrls): string {
  const out: string[] = [];
  let open = false;
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1) {
      if (open) out.push("</section>");
      out.push('<section class="report-section">');
      open = true;
    }
    out.push(block(b, urls));
  }
  if (open) out.push("</section>");
  return out.join("\n");
}

export function contentSecurityPolicy(urls: ImageUrls, styleOrigin: string, frameAncestors: string[]): string {
  const origins = [...new Set([...urls.values()].map((u) => new URL(u).origin))].sort();
  return [
    "default-src 'none'",
    `img-src ${origins.length ? origins.join(" ") : "'none'"}`,
    `style-src ${styleOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
  ].join("; ");
}

export function renderHtml(doc: ReportDoc, urls: ImageUrls, opts: { webOrigin: string; frameAncestors: string[] }): { html: string; csp: string } {
  const styleOrigin = new URL(opts.webOrigin).origin;
  const csp = contentSecurityPolicy(urls, styleOrigin, opts.frameAncestors);
  // The meta copy (without frame-ancestors, which meta cannot carry) keeps the policy when the PWA shows the HTML in a srcdoc frame.
  const metaCsp = csp.split("; ").filter((d) => !d.startsWith("frame-ancestors")).join("; ");
  const html = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp)}">`,
    `<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<title>${escapeHtml(doc.title)}</title><link rel="stylesheet" href="${escapeHtml(styleOrigin + PREVIEW_STYLESHEET)}"></head>`,
    `<body class="report"><header class="report-header"><p class="report-brand">${escapeHtml(doc.brandName)}</p><h1 class="report-title">${escapeHtml(doc.title)}</h1><p class="report-subtitle">${escapeHtml(doc.subtitle)}</p></header>`,
    `<main>${sections(doc.blocks, urls)}</main>`,
    `<footer class="report-footer">${escapeHtml(`Preview generated ${doc.generatedAt}; ${doc.templateVersion}. Photo links expire after a few minutes.`)}</footer>`,
    "</body></html>",
  ].join("\n");
  return { html, csp };
}
