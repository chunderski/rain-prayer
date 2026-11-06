/**
 * Phase 4 quotes (proposals only, D-078). Lines are suggested from confirmed findings through the price
 * book; totals come from quoteTotals (D-080). State machine:
 *   draft --submit--> approved | pending_approval (any priced tier below the tenant minimum margin)
 *   pending_approval --approve (owner)--> approved --send (admin)--> sent --accept/decline--> accepted | declined
 *   any non-draft --revise--> new draft <number>-R<n>
 * A sent quote whose validUntil has passed reads as expired (persisted when next touched); it cannot be
 * accepted or declined (409 quote_expired) but can be revised.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { GenerateQuote, hasRole, QuoteAction, QuoteInput, Uuid, type QuoteLine, type Tier } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { authOf, type AuthContext } from "../lib/auth.js";
import { loadBranding, reportBrandOf } from "../lib/branding.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { renderQuoteCsv, renderQuoteHtml } from "../quotes/render.js";
import { computeTotals, loadQuote, nextQuoteNumber, nextRevision, replaceLines, validateLineRefs, type LoadedQuote } from "../quotes/service.js";
import { sendHtml, signedDocUrls } from "../report/send.js";
import { reqMeta } from "./auth.js";
import type { ChannelDeps } from "./pricebook.js";
import { quoteSettings } from "./pricebook.js";

const IdParams = z.object({ id: Uuid });
export const PORTAL_QUOTE_STATUSES = ["sent", "accepted", "declined", "expired"];

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function auditQuote(tx: Tx, a: AuthContext, req: FastifyRequest, action: string, id: string, details: Record<string, unknown> = {}) {
  return audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action, entityType: "quote", entityId: id, ...reqMeta(req), details });
}

/**
 * Draft lines from confirmed findings: for each finding, active items whose controlIds intersect the
 * finding's controls, assetType matches first, placed in their tier (any becomes all); items in tiers the
 * quote does not present are skipped; a finding with no usable match gets one needsPricing line.
 */
export async function suggestLines(tx: Tx, assessmentId: string, tiers: Tier[], fallbackMargin: number): Promise<QuoteLine[]> {
  const findings = await tx.query<{ id: string; title: string; asset_type: string | null; controls: string[] }>(
    `SELECT f.id, f.title, a.asset_type,
            COALESCE((SELECT array_agg(fc.control_id ORDER BY fc.control_id) FROM finding_control fc WHERE fc.finding_id = f.id), '{}') AS controls
       FROM finding f LEFT JOIN asset a ON a.id = f.asset_id AND a.deleted_at IS NULL
      WHERE f.assessment_id = $1 AND f.status = 'confirmed' AND f.deleted_at IS NULL
      ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, f.created_at, f.id`,
    [assessmentId],
  );
  const items = await tx.query<{ id: string; sku: string; name: string; category: QuoteLine["category"]; unit: QuoteLine["unit"]; material_cost: number;
    labor_hours: number; default_margin_pct: number; control_ids: string[]; asset_types: string[]; tier: string }>(
    "SELECT id, sku, name, category, unit, material_cost, labor_hours, default_margin_pct, control_ids, asset_types, tier FROM price_book_item WHERE active ORDER BY sku",
  );
  const lines: QuoteLine[] = [];
  for (const f of findings.rows) {
    const controls = new Set(f.controls);
    const matches = items.rows
      .filter((i) => i.control_ids.some((c) => controls.has(c)))
      .filter((i) => i.tier === "any" || tiers.includes(i.tier as Tier))
      .map((i) => ({ i, rank: f.asset_type && i.asset_types.includes(f.asset_type) ? 0 : 1 }))
      .sort((x, y) => x.rank - y.rank || x.i.sku.localeCompare(y.i.sku));
    if (!matches.length) {
      lines.push({
        id: randomUUID(), findingId: f.id, priceBookItemId: null, description: `Remediation: ${f.title}`.slice(0, 500), category: "service", unit: "lot",
        quantity: 1, materialCost: 0, laborHours: 0, marginPct: fallbackMargin, tier: "all", optional: false, needsPricing: true, sortOrder: lines.length,
      });
      continue;
    }
    for (const { i } of matches) {
      lines.push({
        id: randomUUID(), findingId: f.id, priceBookItemId: i.id, description: `${i.name} (${f.title})`.slice(0, 500), category: i.category, unit: i.unit,
        quantity: 1, materialCost: i.material_cost, laborHours: i.labor_hours, marginPct: i.default_margin_pct,
        tier: i.tier === "any" ? "all" : (i.tier as QuoteLine["tier"]), optional: false, needsPricing: false, sortOrder: lines.length,
      });
    }
  }
  return lines;
}

const out = (l: LoadedQuote) => l.quote;

/** Branded proposal HTML; shared with the portal preview. */
export async function sendQuotePreview(deps: Pick<ChannelDeps, "cfg" | "storage">, reply: FastifyReply, cur: LoadedQuote, brand: ReturnType<typeof reportBrandOf>) {
  const urls = await signedDocUrls(deps.cfg, deps.storage, { blocks: [], brand });
  const { html, csp } = renderQuoteHtml(cur.quote, cur, brand, urls, { webOrigin: deps.cfg.WEB_ORIGIN, frameAncestors: [deps.cfg.WEB_ORIGIN, ...deps.cfg.embedOrigins] });
  return sendHtml(reply, html, csp);
}

export async function quoteRoutes(app: FastifyInstance, deps: ChannelDeps) {
  const { cfg, db, limiters, storage } = deps;
  const role = guard(cfg, db, limiters);

  const requireQuote = async (tx: Tx, id: string, lock = false) => {
    const q = await loadQuote(tx, id, { lock });
    if (!q) throw notFound("Quote");
    return q;
  };

  app.get("/assessments/:id/quotes", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const a = await tx.query("SELECT 1 FROM assessment WHERE id = $1", [id]);
      if (!a.rowCount) throw notFound("Assessment");
      const ids = (await tx.query<{ id: string }>("SELECT id FROM quote WHERE assessment_id = $1 ORDER BY created_at, id", [id])).rows;
      const list = [];
      for (const r of ids) list.push(out((await loadQuote(tx, r.id))!));
      return list;
    });
  });

  app.post("/assessments/:id/quotes", role("assessor"), async (req, reply) => {
    const a = authOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(GenerateQuote, req.body ?? {});
    if (new Set(body.tiers).size !== body.tiers.length) throw new AppError(400, "validation_error", "Request validation failed", [{ path: "tiers", message: "each tier once" }]);
    const quote = await db.withTenant(a.tenantId, async (tx) => {
      // Quotes are allowed on complete assessments: the field lock does not apply here.
      const as = (await tx.query<{ title: string }>("SELECT title FROM assessment WHERE id = $1", [id])).rows[0];
      if (!as) throw notFound("Assessment");
      const settings = await quoteSettings(tx);
      const lines = await suggestLines(tx, id, body.tiers, settings.minMarginPct);
      const input = { laborRate: settings.defaultLaborRate, tiers: body.tiers, lines };
      const { totals, below } = computeTotals(input, settings.minMarginPct);
      const number = await nextQuoteNumber(tx, a.tenantId);
      const qid = randomUUID();
      await tx.query(
        `INSERT INTO quote (id, tenant_id, assessment_id, number, base_number, title, labor_rate, valid_until, tiers, terms, totals,
                            min_margin_pct, below_min_margin, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [qid, a.tenantId, id, number, (body.title ?? `Remediation proposal: ${as.title}`).slice(0, 200), settings.defaultLaborRate, addDays(settings.validDays),
          body.tiers, settings.defaultTerms, JSON.stringify(totals), settings.minMarginPct, below, a.userId],
      );
      await replaceLines(tx, a.tenantId, qid, lines);
      await auditQuote(tx, a, req, "quote.create", qid, { assessmentId: id, number, lines: lines.length, needsPricing: lines.filter((l) => l.needsPricing).length });
      return out((await loadQuote(tx, qid))!);
    });
    return reply.code(201).send(quote);
  });

  app.get("/quotes/:id", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return db.withTenant(authOf(req).tenantId, async (tx) => out(await requireQuote(tx, id)));
  });

  app.put("/quotes/:id", role("assessor"), async (req) => {
    const a = authOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(QuoteInput, req.body);
    if (new Set(body.tiers).size !== body.tiers.length) throw new AppError(400, "validation_error", "Request validation failed", [{ path: "tiers", message: "each tier once" }]);
    return db.withTenant(a.tenantId, async (tx) => {
      const cur = await requireQuote(tx, id, true);
      if (cur.storedStatus !== "draft") throw new AppError(409, "quote_locked", "Only a draft quote can be edited; revise it to make changes");
      await validateLineRefs(tx, cur.quote.assessmentId, body.lines);
      const min = (await quoteSettings(tx)).minMarginPct;
      const { totals, below } = computeTotals(body, min);
      await tx.query(
        `UPDATE quote SET title = $2, labor_rate = $3, valid_until = $4, tiers = $5, notes = $6, terms = $7, totals = $8, min_margin_pct = $9,
                          below_min_margin = $10, updated_by = $11, updated_at = now() WHERE id = $1`,
        [id, body.title, body.laborRate, body.validUntil, body.tiers, body.notes, body.terms, JSON.stringify(totals), min, below, a.userId],
      );
      await replaceLines(tx, a.tenantId, id, body.lines);
      await auditQuote(tx, a, req, "quote.update", id, { lines: body.lines.length, belowMinMargin: below });
      return out((await loadQuote(tx, id))!);
    });
  });

  // Min role client_viewer: accept and decline are open to the client's own logins; each action checks its role below.
  app.post("/quotes/:id/actions", role("client_viewer"), async (req) => {
    const a = authOf(req);
    const { id } = parse(IdParams, req.params);
    return db.withTenant(a.tenantId, async (tx) => {
      const cur = await requireQuote(tx, id, true);
      if (a.role === "client_viewer") {
        // Client logins see only their client's delivered quotes; anything else does not exist for them.
        if (cur.clientId !== a.clientId || !PORTAL_QUOTE_STATUSES.includes(cur.quote.status)) throw notFound("Quote");
      }
      // Parsed after the visibility check so a client login learns nothing about quotes it cannot see.
      const body = parse(QuoteAction, req.body);
      if (a.role === "client_viewer") {
        if (body.action !== "accept" && body.action !== "decline") throw new AppError(403, "forbidden", "Client logins may only accept or decline a quote");
      }
      // Persist a lapsed validity the first time the quote is touched after it.
      if (cur.quote.status === "expired" && cur.storedStatus !== "expired") {
        await tx.query("UPDATE quote SET status = 'expired', updated_at = now() WHERE id = $1", [id]);
        await auditQuote(tx, a, req, "quote.expire", id, { validUntil: cur.quote.validUntil });
      }
      const status = cur.quote.status;
      const need = (r: "assessor" | "admin" | "owner") => {
        if (!hasRole(a.role, r) || (r === "owner" && a.role !== "owner")) throw new AppError(403, "forbidden", `Requires role ${r}${r === "owner" ? "" : " or higher"}`);
      };
      const transition = (from: string[]) => {
        if (!from.includes(status)) throw new AppError(409, "invalid_transition", `The ${body.action} action is not available on a ${status.replace("_", " ")} quote`);
      };
      switch (body.action) {
        case "submit": {
          need("assessor");
          transition(["draft"]);
          const blocked = cur.quote.lines.filter((l) => l.needsPricing);
          if (blocked.length) throw new AppError(422, "lines_need_pricing", "Price every line marked as needing pricing before submitting", { lineIds: blocked.map((l) => l.id) });
          // Re-evaluated against the tenant minimum in force now.
          const min = (await quoteSettings(tx)).minMarginPct;
          const { totals, below } = computeTotals(cur.quote, min);
          const next = below ? "pending_approval" : "approved";
          await tx.query(
            `UPDATE quote SET status = $2, totals = $3, min_margin_pct = $4, below_min_margin = $5, submitted_by = $6, submitted_at = now(),
                              approved_by = CASE WHEN $2 = 'approved' THEN $6::uuid END, approved_at = CASE WHEN $2 = 'approved' THEN now() END,
                              updated_by = $6, updated_at = now() WHERE id = $1`,
            [id, next, JSON.stringify(totals), min, below, a.userId],
          );
          await auditQuote(tx, a, req, "quote.submit", id, { to: next, minMarginPct: min, tierMargins: totals.map((t) => ({ tier: t.tier, marginPct: t.marginPct })) });
          break;
        }
        case "approve":
          need("owner");
          transition(["pending_approval"]);
          await tx.query("UPDATE quote SET status = 'approved', approved_by = $2, approved_at = now(), updated_by = $2, updated_at = now() WHERE id = $1", [id, a.userId]);
          await auditQuote(tx, a, req, "quote.approve", id, { belowMinMargin: cur.quote.belowMinMargin });
          break;
        case "send":
          need("admin");
          transition(["approved"]);
          await tx.query("UPDATE quote SET status = 'sent', sent_by = $2, sent_at = now(), updated_by = $2, updated_at = now() WHERE id = $1", [id, a.userId]);
          await auditQuote(tx, a, req, "quote.send", id);
          break;
        case "revise": {
          need("assessor");
          if (status === "draft") throw new AppError(409, "invalid_transition", "A draft can be edited directly; revise applies to submitted quotes");
          const rev = await nextRevision(tx, a.tenantId, cur.baseNumber);
          const number = `${cur.baseNumber}-R${rev}`;
          const qid = randomUUID();
          const settings = await quoteSettings(tx);
          const lines = cur.quote.lines.map((l) => ({ ...l, id: randomUUID() }));
          const { totals, below } = computeTotals({ ...cur.quote, lines }, settings.minMarginPct);
          const validUntil = cur.quote.validUntil < today() ? addDays(settings.validDays) : cur.quote.validUntil;
          await tx.query(
            `INSERT INTO quote (id, tenant_id, assessment_id, number, base_number, revision, revised_from, title, labor_rate, valid_until, tiers,
                                notes, terms, totals, min_margin_pct, below_min_margin, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
            [qid, a.tenantId, cur.quote.assessmentId, number, cur.baseNumber, rev, id, cur.quote.title, cur.quote.laborRate, validUntil, cur.quote.tiers,
              cur.quote.notes, cur.quote.terms, JSON.stringify(totals), settings.minMarginPct, below, a.userId],
          );
          await replaceLines(tx, a.tenantId, qid, lines);
          await auditQuote(tx, a, req, "quote.revise", qid, { from: id, fromNumber: cur.quote.number, number });
          return out((await loadQuote(tx, qid))!);
        }
        case "accept":
        case "decline": {
          if (a.role !== "client_viewer") need("admin");
          if (status === "expired") throw new AppError(409, "quote_expired", "This quote has expired; ask for a revised quote");
          transition(["sent"]);
          if (body.action === "accept" && !cur.quote.tiers.includes(body.tier)) {
            throw new AppError(400, "validation_error", "Request validation failed", [{ path: "tier", message: "must be one of the quote's tiers" }]);
          }
          await tx.query(
            `UPDATE quote SET status = $2, responded_at = now(), responded_by = $3, responded_user_id = $4, accepted_tier = $5, decline_reason = $6,
                              updated_at = now() WHERE id = $1`,
            [id, body.action === "accept" ? "accepted" : "declined", body.name, a.userId, body.action === "accept" ? body.tier : null,
              body.action === "decline" ? body.reason ?? null : null],
          );
          await auditQuote(tx, a, req, `quote.${body.action}`, id, { name: body.name, tier: body.action === "accept" ? body.tier : null, byRole: a.role });
          break;
        }
      }
      return out((await loadQuote(tx, id))!);
    });
  });

  app.get("/quotes/:id/preview", role("viewer"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const { cur, brand } = await db.withTenant(authOf(req).tenantId, async (tx) => ({ cur: await requireQuote(tx, id), brand: reportBrandOf(await loadBranding(tx)) }));
    return sendQuotePreview(deps, reply, cur, brand);
  });

  app.get("/quotes/:id/csv", role("viewer"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const cur = await db.withTenant(authOf(req).tenantId, (tx) => requireQuote(tx, id));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${cur.quote.number.replace(/[^A-Za-z0-9-]/g, "")}.csv"`)
      .header("x-content-type-options", "nosniff")
      .send(renderQuoteCsv(cur.quote));
  });
}

