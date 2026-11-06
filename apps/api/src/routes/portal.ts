/**
 * Phase 4 client portal and portfolio. Portal routes admit client_viewer (always filtered by the
 * membership's client_id on top of tenant RLS, D-081) and viewer and above (any client of the tenant;
 * the list needs ?clientId=). Only complete assessments and delivered quotes are visible here.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { METHOD_VERSION } from "@sentinel/risk";
import { Uuid, type Portfolio, type PortalAssessment, type RiskResult } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import { fieldCtx } from "../field/context.js";
import { guard } from "../lib/access.js";
import { authOf } from "../lib/auth.js";
import { loadBranding, reportBrandOf } from "../lib/branding.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { clientQuoteView, loadQuote } from "../quotes/service.js";
import { loadReportData } from "../report/data.js";
import { renderHtml } from "../report/html.js";
import { buildReportDoc } from "../report/model.js";
import { sendHtml, signedDocUrls } from "../report/send.js";
import { findingsWithFrameworks } from "./field.js";
import type { ChannelDeps } from "./pricebook.js";
import { PORTAL_QUOTE_STATUSES, sendQuotePreview } from "./quotes.js";

const IdParams = z.object({ id: Uuid });
const ClientQuery = z.object({ clientId: Uuid.optional() });
const EFFECTIVE_STATUS = `CASE WHEN q.status = 'sent' AND q.valid_until < current_date THEN 'expired' ELSE q.status END`;

/** The client a request may see: always the membership's client for client_viewer, else the query (or any). */
function clientScope(req: FastifyRequest, requireForStaff: boolean): string | null {
  const a = authOf(req);
  const { clientId } = parse(ClientQuery, req.query);
  if (a.role === "client_viewer") {
    if (!a.clientId) throw new AppError(403, "forbidden", "This login is not bound to a client");
    if (clientId && clientId !== a.clientId) throw notFound("Client");
    return a.clientId;
  }
  if (requireForStaff && !clientId) throw new AppError(400, "validation_error", "Request validation failed", [{ path: "clientId", message: "required" }]);
  return clientId ?? null;
}

const openFindingsSql = (col: string) =>
  `COALESCE((SELECT jsonb_object_agg(x.severity, x.n) FROM (SELECT f.severity, count(*)::int AS n FROM finding f
     WHERE f.assessment_id = ${col} AND f.status = 'confirmed' AND f.deleted_at IS NULL GROUP BY f.severity) x), '{}')`;

async function portalAssessments(tx: Tx, clientId: string | null, assessmentId: string | null): Promise<PortalAssessment[]> {
  const { rows } = await tx.query(
    `SELECT a.id, a.title, s.name AS "siteName", snap.created_at AS "completedAt", snap.result -> 'overall' AS overall,
            ${openFindingsSql("a.id")} AS "openFindings",
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'number', q.number, 'title', q.title, 'status', ${EFFECTIVE_STATUS})
                                       ORDER BY q.created_at, q.id)
                        FROM quote q WHERE q.assessment_id = a.id AND ${EFFECTIVE_STATUS} = ANY($3::text[])), '[]') AS quotes
       FROM assessment a JOIN site s ON s.id = a.site_id
       LEFT JOIN LATERAL (SELECT r.created_at, r.result FROM risk_snapshot r WHERE r.assessment_id = a.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) snap ON true
      WHERE a.status = 'complete' AND ($1::uuid IS NULL OR s.client_id = $1) AND ($2::uuid IS NULL OR a.id = $2)
      ORDER BY snap.created_at DESC NULLS LAST, a.id`,
    [clientId, assessmentId, PORTAL_QUOTE_STATUSES],
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, siteName: r.siteName, completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    overall: r.overall ? { level: r.overall.level, residual: r.overall.residual } : null, openFindings: r.openFindings, quotes: r.quotes,
  }));
}

export async function portalRoutes(app: FastifyInstance, deps: ChannelDeps) {
  const { cfg, db, limiters, storage, risk } = deps;
  const role = guard(cfg, db, limiters);

  const requirePortalAssessment = async (tx: Tx, req: FastifyRequest, id: string) => {
    const [pa] = await portalAssessments(tx, clientScope(req, false), id);
    if (!pa) throw notFound("Assessment");
    return pa;
  };

  app.get("/portal/assessments", role("client_viewer"), async (req) => {
    const scope = clientScope(req, true);
    return db.withTenant(authOf(req).tenantId, (tx) => portalAssessments(tx, scope, null));
  });

  app.get("/portal/assessments/:id", role("client_viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const a = authOf(req);
    return db.withTenant(a.tenantId, async (tx) => {
      const assessment = await requirePortalAssessment(tx, req, id);
      const snap = await risk.latestSnapshot(tx, id);
      const all = (await findingsWithFrameworks(fieldCtx(tx, a, req), id)) as (Record<string, any> & { frameworks: unknown[] })[];
      const findings = all
        .filter((f) => f.status === "confirmed")
        .map((f) => ({
          id: f.id, title: f.title, description: f.description ?? "", recommendation: f.recommendation ?? null, severity: f.severity,
          status: f.status, controlIds: f.controlIds, frameworks: f.frameworks,
        }));
      return { assessment, risk: snap as RiskResult | null, findings };
    });
  });

  app.get("/portal/assessments/:id/report", role("client_viewer"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const a = authOf(req);
    const doc = await db.withTenant(a.tenantId, async (tx) => {
      await requirePortalAssessment(tx, req, id);
      // Export mode: approved narrative only, never edited or AI draft text.
      return buildReportDoc(await loadReportData(fieldCtx(tx, a, req), id, risk), "export");
    });
    const urls = await signedDocUrls(cfg, storage, doc);
    const { html, csp } = renderHtml(doc, urls, {
      webOrigin: cfg.WEB_ORIGIN, frameAncestors: [cfg.WEB_ORIGIN, ...cfg.embedOrigins],
      footerNote: `Generated ${doc.generatedAt.slice(0, 10)}; ${doc.templateVersion}. Photo links expire after a few minutes.`,
    });
    return sendHtml(reply, html, csp, { "x-report-template": doc.templateVersion });
  });

  const portalQuote = async (tx: Tx, req: FastifyRequest, id: string) => {
    const scope = clientScope(req, false);
    const q = await loadQuote(tx, id);
    if (!q || !PORTAL_QUOTE_STATUSES.includes(q.quote.status) || (scope && q.clientId !== scope)) throw notFound("Quote");
    return q;
  };

  app.get("/portal/quotes/:id", role("client_viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return db.withTenant(authOf(req).tenantId, async (tx) => clientQuoteView((await portalQuote(tx, req, id)).quote));
  });

  app.get("/portal/quotes/:id/preview", role("client_viewer"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const { cur, brand } = await db.withTenant(authOf(req).tenantId, async (tx) => ({ cur: await portalQuote(tx, req, id), brand: reportBrandOf(await loadBranding(tx)) }));
    return sendQuotePreview(deps, reply, cur, brand);
  });

  // ---------------------------------------------------------------- portfolio (viewer and above)
  app.get("/portfolio", role("viewer"), async (req): Promise<Portfolio> => {
    const { clientId } = parse(ClientQuery, req.query);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const sites = await tx.query<{ client_id: string; client_name: string; site_id: string; site_name: string }>(
        `SELECT c.id AS client_id, c.name AS client_name, s.id AS site_id, s.name AS site_name
           FROM client c JOIN site s ON s.client_id = c.id
          WHERE ($1::uuid IS NULL OR c.id = $1) ORDER BY lower(c.name), c.id, lower(s.name), s.id`,
        [clientId ?? null],
      );
      const hist = await tx.query<{ site_id: string; assessment_id: string; library_version: string | null; completed_at: Date; method_version: string; overall: RiskResult["overall"] }>(
        `SELECT a.site_id, a.id AS assessment_id, a.library_version, snap.created_at AS completed_at, snap.method_version, snap.result -> 'overall' AS overall
           FROM assessment a
           JOIN LATERAL (SELECT r.created_at, r.method_version, r.result FROM risk_snapshot r WHERE r.assessment_id = a.id
                          ORDER BY r.created_at DESC, r.id DESC LIMIT 1) snap ON true
          WHERE a.status = 'complete' ORDER BY snap.created_at, a.id`,
      );
      const findings = await tx.query<{ site_id: string; assessment_id: string; open: Record<string, number> }>(
        `SELECT a.site_id, a.id AS assessment_id, ${openFindingsSql("a.id")} AS open FROM assessment a WHERE a.status = 'complete'`,
      );
      const quotes = await tx.query<{ site_id: string; status: string; totals: { tier: string; price: number }[]; accepted_tier: string | null }>(
        `SELECT a.site_id, ${EFFECTIVE_STATUS} AS status, q.totals, q.accepted_tier FROM quote q JOIN assessment a ON a.id = q.assessment_id`,
      );
      const methods = new Set<string>();
      const libraries = new Set<string>();
      const clients = new Map<string, Portfolio["clients"][number]>();
      for (const s of sites.rows) {
        const c = clients.get(s.client_id) ?? { clientId: s.client_id, clientName: s.client_name, sites: [] };
        clients.set(s.client_id, c);
        const history = hist.rows.filter((h) => h.site_id === s.site_id && h.overall);
        history.forEach((h) => {
          methods.add(h.method_version);
          if (h.library_version) libraries.add(h.library_version);
        });
        const latest = history.at(-1);
        const qs = quotes.rows.filter((q) => q.site_id === s.site_id);
        const priceOf = (q: (typeof qs)[number], tier?: string | null) =>
          tier ? q.totals.find((t) => t.tier === tier)?.price ?? 0 : Math.max(0, ...q.totals.map((t) => t.price));
        c.sites.push({
          siteId: s.site_id,
          siteName: s.site_name,
          history: history.map((h) => ({
            assessmentId: h.assessment_id, completedAt: new Date(h.completed_at).toISOString(), level: h.overall.level,
            residual: h.overall.residual, inherent: h.overall.inherent,
          })),
          openFindings: latest ? findings.rows.find((f) => f.assessment_id === latest.assessment_id)?.open ?? {} : {},
          quotes: {
            sent: qs.filter((q) => PORTAL_QUOTE_STATUSES.includes(q.status)).length,
            accepted: qs.filter((q) => q.status === "accepted").length,
            acceptedValue: Math.round(qs.filter((q) => q.status === "accepted").reduce((n, q) => n + priceOf(q, q.accepted_tier), 0) * 100) / 100,
            openValue: Math.round(qs.filter((q) => q.status === "sent").reduce((n, q) => n + priceOf(q), 0) * 100) / 100,
          },
        });
      }
      const caveats: string[] = [];
      if (methods.size > 1) caveats.push(`Risk scores come from different method versions (${[...methods].sort().join(", ")}); compare trends with care.`);
      if ([...methods].some((m) => m !== METHOD_VERSION)) caveats.push(`Some scores predate the current method ${METHOD_VERSION}.`);
      if (libraries.size > 1) caveats.push(`Assessments used different control library versions (${[...libraries].sort().join(", ")}).`);
      return { methodVersion: METHOD_VERSION, clients: [...clients.values()], caveats };
    });
  });
}
