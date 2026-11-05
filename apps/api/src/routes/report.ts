/** Phase 3 report routes: HTML preview and narrative sections (AI drafted, human approved, D-060). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { draftNarrative, NarrativeError, VisionError, type DraftNarrativeInput, type TextClient } from "@sentinel/ai";
import { NarrativeSection, PutNarrative, Uuid } from "@sentinel/shared";
import { assessmentScope, requireAssessmentWrite, type FieldCtx } from "../field/context.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { AppError, parse } from "../lib/errors.js";
import { loadReportData } from "../report/data.js";
import { renderHtml } from "../report/html.js";
import { buildReportDoc, docImages } from "../report/model.js";
import { inField, type FieldRouteDeps } from "./deps.js";

const IdParams = z.object({ id: Uuid });
const SectionParams = z.object({ id: Uuid, section: NarrativeSection });

export interface ReportRouteDeps extends FieldRouteDeps {
  /** Text client for narrative drafts, or null when AI is not configured. */
  text: () => TextClient | null;
}

const NARRATIVE_SQL = `SELECT assessment_id AS "assessmentId", section, text, status, model, updated_at AS "updatedAt", approved_by AS "approvedBy"
  FROM narrative WHERE assessment_id = $1`;
const narrativeOut = (r: Record<string, unknown>) => ({ ...r, updatedAt: new Date(r.updatedAt as string).toISOString() });

export async function reportRoutes(app: FastifyInstance, deps: ReportRouteDeps) {
  const { cfg, db, limiters, storage, risk } = deps;
  const role = guard(cfg, db, limiters);

  app.get("/assessments/:id/report/preview", role("viewer"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const doc = await inField(db, req, async (ctx) => buildReportDoc(await loadReportData(ctx, id, risk), "preview"));
    const urls = new Map<string, string>();
    for (const img of docImages(doc)) {
      if (!urls.has(img.photoId)) urls.set(img.photoId, (await storage.signedUrl(img.storageKey, cfg.SIGNED_URL_TTL_SECONDS)).url);
    }
    const { html, csp } = renderHtml(doc, urls, { webOrigin: cfg.WEB_ORIGIN, frameAncestors: [cfg.WEB_ORIGIN, ...cfg.embedOrigins] });
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", csp)
      .header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("x-report-template", doc.templateVersion)
      .send(html);
  });

  app.get("/assessments/:id/narrative", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, async (ctx) => {
      await assessmentScope(ctx, id);
      return (await ctx.tx.query(`${NARRATIVE_SQL} ORDER BY section`, [id])).rows.map(narrativeOut);
    });
  });

  const write = async (ctx: FieldCtx, id: string, section: string, text: string, status: "ai_draft" | "edited" | "approved", model: string | null, promptVersion: string | null) => {
    await ctx.tx.query(
      `INSERT INTO narrative (tenant_id, assessment_id, section, text, status, model, prompt_version, updated_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $5 = 'approved' THEN now() END)
       ON CONFLICT (assessment_id, section) DO UPDATE SET text = EXCLUDED.text, status = EXCLUDED.status, model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version, updated_by = EXCLUDED.updated_by, updated_at = now(),
         approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
      [ctx.auth.tenantId, id, section, text, status, model, promptVersion, ctx.auth.userId, status === "approved" ? ctx.auth.userId : null],
    );
    return narrativeOut((await ctx.tx.query(`${NARRATIVE_SQL} AND section = $2`, [id, section])).rows[0]);
  };

  const DraftBody = z.object({ section: NarrativeSection }).strict();
  app.post("/assessments/:id/narrative/draft", role("assessor", limiters.narrative), async (req) => {
    const { id } = parse(IdParams, req.params);
    const { section } = parse(DraftBody, req.body);
    const client = deps.text();
    if (!client) throw new AppError(503, "ai_not_configured", "AI narrative drafting is not configured on this server (ANTHROPIC_API_KEY)");
    // Facts only from confirmed findings and the risk result; AI drafts never feed AI drafts.
    const facts = await inField(db, req, async (ctx): Promise<DraftNarrativeInput["facts"]> => {
      await requireAssessmentWrite(ctx, id);
      const data = await loadReportData(ctx, id, risk);
      if (!data.risk) throw new AppError(503, "risk_unavailable", "Risk scores are needed for a narrative draft and are not available");
      return {
        clientName: data.assessment.clientName,
        siteName: data.assessment.siteName,
        assessmentTitle: data.assessment.title,
        frameworks: data.assessment.frameworks.map((f) => ({ shortName: f.shortName, version: f.version })),
        risk: data.risk,
        findings: data.findings
          .filter((f) => f.status === "confirmed")
          .map((f) => ({
            title: f.title, severity: f.severity, description: f.description,
            ...(f.recommendation ? { recommendation: f.recommendation } : {}),
            frameworks: [...new Set(f.frameworks.map((x) => `${x.frameworkId} ${x.requirementCode}`))],
          })),
      };
    });
    let draft;
    try {
      draft = await draftNarrative({ section, facts, styleNotes: null }, { client, model: cfg.ANTHROPIC_TEXT_MODEL });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "narrative draft failed");
      if (err instanceof NarrativeError) {
        // The model output did not match the facts twice (for example a framework or risk level not in the assessment).
        throw new AppError(422, "ai_draft_rejected", "The AI draft did not match the assessment facts and was discarded; try again or write the section by hand", { reason: err.reason });
      }
      const code = err instanceof VisionError ? err.code : "model_error";
      throw new AppError(502, "ai_failed", code === "timeout" ? "The AI service timed out; try again in a moment" : "The AI draft could not be produced; try again or write the section by hand", { reason: code });
    }
    return inField(db, req, async (ctx) => {
      await requireAssessmentWrite(ctx, id); // the assessment may have been completed meanwhile
      const out = await write(ctx, id, section, draft.text.slice(0, 20_000), "ai_draft", draft.model, draft.promptVersion);
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "narrative.draft",
        entityType: "assessment", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent, details: { section, model: draft.model, promptVersion: draft.promptVersion },
      });
      return out;
    });
  });

  app.put("/assessments/:id/narrative/:section", role("assessor"), async (req) => {
    const { id, section } = parse(SectionParams, req.params);
    const body = parse(PutNarrative, req.body);
    return inField(db, req, async (ctx) => {
      await requireAssessmentWrite(ctx, id);
      const prev = (await ctx.tx.query<{ model: string | null; prompt_version: string | null; status: string; text: string }>(
        "SELECT model, prompt_version, status, text FROM narrative WHERE assessment_id = $1 AND section = $2", [id, section],
      )).rows[0];
      const status = body.approve ? "approved" : "edited";
      // Model provenance is kept while the text still derives from an AI draft.
      const out = await write(ctx, id, section, body.text, status, prev?.model ?? null, prev?.prompt_version ?? null);
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email,
        action: body.approve ? "narrative.approve" : "narrative.update", entityType: "assessment", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent,
        details: { section, from: prev?.status ?? null, to: status, changed: prev ? prev.text !== body.text : true },
      });
      return out;
    });
  });
}
