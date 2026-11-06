/**
 * Quote persistence. Totals always come from quoteTotals in packages/shared (D-080); this file never
 * does quote arithmetic of its own beyond comparing a tier's marginPct with the tenant minimum.
 */
import { quoteTotals, type Quote, type QuoteInput, type QuoteLine, type TierTotals } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import { AppError } from "../lib/errors.js";

export interface LoadedQuote {
  quote: Quote & { acceptedTier: string | null; declineReason: string | null };
  /** Status as stored (a sent quote past validUntil reads as expired but may still be stored as sent). */
  storedStatus: string;
  clientId: string;
  clientName: string;
  siteName: string;
  assessmentTitle: string;
  baseNumber: string;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

/** Reads one quote with lines; RLS scopes it to the current tenant. */
export async function loadQuote(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<LoadedQuote | null> {
  if (opts.lock) await tx.query("SELECT 1 FROM quote WHERE id = $1 FOR UPDATE", [id]);
  const { rows } = await tx.query(
    `SELECT q.*, CASE WHEN q.status = 'sent' AND q.valid_until < current_date THEN 'expired' ELSE q.status END AS effective_status,
            s.client_id, c.name AS client_name, s.name AS site_name, a.title AS assessment_title
       FROM quote q JOIN assessment a ON a.id = q.assessment_id JOIN site s ON s.id = a.site_id JOIN client c ON c.id = s.client_id
      WHERE q.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const lines = await tx.query<QuoteLine>(
    `SELECT id, finding_id AS "findingId", price_book_item_id AS "priceBookItemId", description, category, unit, quantity,
            material_cost AS "materialCost", labor_hours AS "laborHours", margin_pct AS "marginPct", tier, optional,
            needs_pricing AS "needsPricing", sort_order AS "sortOrder"
       FROM quote_line WHERE quote_id = $1 ORDER BY sort_order, id`,
    [id],
  );
  return {
    quote: {
      id: r.id, assessmentId: r.assessment_id, number: r.number, status: r.effective_status, currency: "USD",
      title: r.title, laborRate: r.labor_rate, validUntil: r.valid_until, tiers: r.tiers, notes: r.notes, terms: r.terms,
      lines: lines.rows, totals: r.totals as TierTotals[], minMarginPct: r.min_margin_pct, belowMinMargin: r.below_min_margin,
      createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, approvedBy: r.approved_by, sentAt: iso(r.sent_at),
      respondedAt: iso(r.responded_at), respondedBy: r.responded_by, acceptedTier: r.accepted_tier, declineReason: r.decline_reason,
    },
    storedStatus: r.status,
    clientId: r.client_id,
    clientName: r.client_name,
    siteName: r.site_name,
    assessmentTitle: r.assessment_title,
    baseNumber: r.base_number,
  };
}

/** quoteTotals output plus the minimum-margin flag (only tiers with a price can fall below the minimum). */
export function computeTotals(input: Pick<QuoteInput, "laborRate" | "tiers" | "lines">, minMarginPct: number): { totals: TierTotals[]; below: boolean } {
  const totals = quoteTotals(input);
  return { totals, below: totals.some((t) => t.price > 0 && t.marginPct < minMarginPct) };
}

/** Replaces the quote's lines (client-generated line ids are scoped to the quote). */
export async function replaceLines(tx: Tx, tenantId: string, quoteId: string, lines: QuoteLine[]) {
  await tx.query("DELETE FROM quote_line WHERE quote_id = $1", [quoteId]);
  if (!lines.length) return;
  await tx.query(
    `INSERT INTO quote_line (id, tenant_id, quote_id, finding_id, price_book_item_id, description, category, unit, quantity, material_cost,
                             labor_hours, margin_pct, tier, optional, needs_pricing, sort_order)
     SELECT x.id, $1, $2, x."findingId", x."priceBookItemId", x.description, x.category, x.unit, x.quantity, x."materialCost",
            x."laborHours", x."marginPct", x.tier, x.optional, x."needsPricing", x."sortOrder"
       FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, "findingId" uuid, "priceBookItemId" uuid, description text, category text, unit text,
            quantity float8, "materialCost" float8, "laborHours" float8, "marginPct" float8, tier text, optional boolean,
            "needsPricing" boolean, "sortOrder" int)`,
    [tenantId, quoteId, JSON.stringify(lines)],
  );
}

/** Checks that referenced findings belong to the quote's assessment and price book items to this tenant. */
export async function validateLineRefs(tx: Tx, assessmentId: string, lines: QuoteLine[]) {
  const ids = lines.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "validation_error", "Request validation failed", [{ path: "lines", message: "line ids must be unique" }]);
  const findingIds = [...new Set(lines.map((l) => l.findingId).filter((x): x is string => !!x))];
  if (findingIds.length) {
    const f = await tx.query<{ id: string }>("SELECT id FROM finding WHERE assessment_id = $1 AND id = ANY($2::uuid[])", [assessmentId, findingIds]);
    if (f.rowCount !== findingIds.length) throw new AppError(400, "unknown_finding", "One or more lines reference a finding outside this assessment");
  }
  const itemIds = [...new Set(lines.map((l) => l.priceBookItemId).filter((x): x is string => !!x))];
  if (itemIds.length) {
    const p = await tx.query("SELECT id FROM price_book_item WHERE id = ANY($1::uuid[])", [itemIds]);
    if (p.rowCount !== itemIds.length) throw new AppError(400, "unknown_price_book_item", "One or more lines reference an unknown price book item");
  }
}

/** Next Q-<year>-<NNNN> for the tenant; a transaction-scoped advisory lock serializes numbering. */
export async function nextQuoteNumber(tx: Tx, tenantId: string): Promise<string> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('sentinel-quote-number:' || $1, 0))", [tenantId]);
  const year = new Date().getUTCFullYear();
  const { rows } = await tx.query<{ n: number | null }>(
    "SELECT max(substring(base_number FROM '^Q-\\d{4}-(\\d+)$')::int) AS n FROM quote WHERE base_number LIKE $1",
    [`Q-${year}-%`],
  );
  return `Q-${year}-${String((rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
}

/** Next revision number for a base quote number (R2, R3, ...). */
export async function nextRevision(tx: Tx, tenantId: string, baseNumber: string): Promise<number> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('sentinel-quote-number:' || $1, 0))", [tenantId]);
  const { rows } = await tx.query<{ r: number }>("SELECT max(revision) AS r FROM quote WHERE base_number = $1", [baseNumber]);
  return (rows[0]?.r ?? 1) + 1;
}
