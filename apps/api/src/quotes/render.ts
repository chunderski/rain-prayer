/**
 * Branded quote proposal (HTML, client facing: prices only, never cost or margin) and the internal CSV.
 * HTML follows the report preview rules: escaped text, class-based markup, strict CSP, one hashed
 * brand style block. Extra classes: quote, quote-meta, quote-tier, quote-lines, quote-optional, quote-total,
 * quote-notes, quote-terms, quote-status.
 */
import { unitPrice, type Quote } from "@sentinel/shared";
import { brandFooter, brandHeader, brandStyle, contentSecurityPolicy, escapeHtml, pageShell, type ImageUrls } from "../report/html.js";
import type { ReportBrand } from "../report/model.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TIER_LABEL: Record<string, string> = { good: "Good", better: "Better", best: "Best" };
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", pending_approval: "Pending approval", approved: "Approved", sent: "Sent", accepted: "Accepted", declined: "Declined", expired: "Expired",
};

export interface QuoteContext {
  clientName: string;
  siteName: string;
  assessmentTitle: string;
}

export function renderQuoteHtml(q: Quote, ctx: QuoteContext, brand: ReportBrand, urls: ImageUrls, opts: { webOrigin: string; frameAncestors: string[] }) {
  const styleOrigin = new URL(opts.webOrigin).origin;
  const style = brandStyle(brand);
  const csp = contentSecurityPolicy(urls, styleOrigin, opts.frameAncestors, [style.hash]);
  const e = escapeHtml;
  const tiers = q.tiers.map((tier) => {
    const lines = q.lines.filter((l) => l.tier === "all" || l.tier === tier);
    const row = (l: Quote["lines"][number]) => {
      const up = unitPrice(l, q.laborRate);
      return `<tr><td>${e(l.description)}</td><td>${e(String(l.quantity))} ${e(l.unit)}</td><td>${e(money(up))}</td><td>${e(money(Math.round(up * l.quantity * 100) / 100))}</td></tr>`;
    };
    const table = (ls: typeof lines) =>
      `<table class="quote-lines"><thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Unit price</th><th scope="col">Amount</th></tr></thead><tbody>${ls.map(row).join("")}</tbody></table>`;
    const included = lines.filter((l) => !l.optional);
    const optional = lines.filter((l) => l.optional);
    const t = q.totals.find((x) => x.tier === tier);
    return [
      `<section class="quote-tier"><h2>${e(q.tiers.length > 1 ? `Option: ${TIER_LABEL[tier] ?? tier}` : "Proposal")}</h2>`,
      included.length ? table(included) : `<p class="muted">No items.</p>`,
      `<p class="quote-total">${e(`Total: ${money(t?.price ?? 0)}`)}</p>`,
      optional.length ? `<h3>Optional items</h3><div class="quote-optional">${table(optional)}<p class="muted">${e(`Optional items total: ${money(t?.optionalPrice ?? 0)}, not included above.`)}</p></div>` : "",
      `</section>`,
    ].join("");
  });
  const status = q.status === "accepted"
    ? `Accepted${q.respondedBy ? ` by ${q.respondedBy}` : ""}${(q as { acceptedTier?: string | null }).acceptedTier ? ` (${TIER_LABEL[(q as { acceptedTier?: string }).acceptedTier!]})` : ""}`
    : q.status === "declined" ? `Declined${q.respondedBy ? ` by ${q.respondedBy}` : ""}` : STATUS_LABEL[q.status] ?? q.status;
  const body = [
    `<header class="report-header">${brandHeader(brand, urls)}<h1 class="report-title">${e(q.title)}</h1><p class="report-subtitle">${e(`${ctx.clientName}, ${ctx.siteName}`)}</p></header>`,
    `<main>`,
    `<section class="quote-meta"><p>${e(`Quote ${q.number}`)}</p><p>${e(`Prepared by ${brand.displayName} for ${ctx.clientName}`)}</p><p>${e(`Assessment: ${ctx.assessmentTitle}`)}</p><p>${e(`Valid until ${q.validUntil}. Prices in ${q.currency}; this is a proposal, not an invoice.`)}</p><p class="quote-status">${e(`Status: ${status}`)}</p></section>`,
    ...tiers,
    q.notes ? `<section class="quote-notes"><h2>Notes</h2>${q.notes.split(/\n{2,}/).map((p) => `<p>${e(p)}</p>`).join("")}</section>` : "",
    q.terms ? `<section class="quote-terms"><h2>Terms</h2>${q.terms.split(/\n{2,}/).map((p) => `<p>${e(p)}</p>`).join("")}</section>` : "",
    `</main>`,
    `<footer class="report-footer">${brandFooter(brand)}</footer>`,
  ].join("\n");
  return { html: pageShell(`${q.number} ${q.title}`, "report quote", body, csp, styleOrigin, style), csp };
}

/** Spreadsheet formula injection guard: a leading = + - @ tab or CR makes the cell literal text. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: unknown[]) => cells.map(csvCell).join(",");

/** Internal CSV (viewer and above): every line with cost inputs and unit price, then tier totals. */
export function renderQuoteCsv(q: Quote): string {
  const out = [
    row(["Quote", q.number, "Title", q.title, "Status", q.status, "Valid until", q.validUntil, "Labor rate", q.laborRate]),
    "",
    row(["Tier", "Description", "Category", "Unit", "Quantity", "Material cost", "Labor hours", "Margin %", "Unit price", "Line total", "Optional", "Needs pricing"]),
    ...q.lines.map((l) => {
      const up = unitPrice(l, q.laborRate);
      return row([l.tier, l.description, l.category, l.unit, l.quantity, l.materialCost, l.laborHours, l.marginPct, up, Math.round(up * l.quantity * 100) / 100, l.optional ? "yes" : "no", l.needsPricing ? "yes" : "no"]);
    }),
    "",
    row(["Tier", "Materials", "Labor", "Cost", "Price", "Margin", "Margin %", "Optional items"]),
    ...q.totals.map((t) => row([t.tier, t.materials, t.labor, t.cost, t.price, t.margin, t.marginPct, t.optionalPrice])),
  ];
  return out.join("\r\n") + "\r\n";
}
