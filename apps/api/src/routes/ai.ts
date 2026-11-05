/**
 * AI photo analysis. Model output is stored as a suggestion only; findings and photo tags change
 * only through POST /suggestions/:id/review (accept or edit), in one audited transaction.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { analyzePhoto, PROMPT_VERSION, VisionError, type CandidateControl } from "@sentinel/ai";
import { ReviewSuggestion, Uuid, VisionOutput, type AssetType, type Severity } from "@sentinel/shared";
import { knownControls, requireAssessmentWrite, tenantSettings, type AssessmentScope } from "../field/context.js";
import { ENTITIES, applyWrite, loadRecord, toOutput } from "../field/records.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { inField, type FieldRouteDeps } from "./deps.js";

const IdParams = z.object({ id: Uuid });
/** Long edge of the image sent to the model (larger costs more without better results). */
export const AI_IMAGE_EDGE = 1568;
const SEVERITY_RANK: Severity[] = ["info", "low", "medium", "high", "critical"];

const SUGGESTION_SQL = `SELECT id, photo_id AS "photoId", assessment_id AS "assessmentId", status, model, prompt_version AS "promptVersion",
  output, error, created_at AS "createdAt", reviewed_at AS "reviewedAt", reviewed_by AS "reviewedBy" FROM ai_suggestion`;

const asSuggestion = (r: Record<string, unknown>) => ({
  ...r,
  createdAt: (r.createdAt as Date).toISOString(),
  reviewedAt: r.reviewedAt ? (r.reviewedAt as Date).toISOString() : null,
});

/** Candidate controls: asset-type hints from the walkthrough first, then controls listing the asset type, then the rest. */
export function candidateControls(scope: AssessmentScope, assetType: string | null, hints: Record<string, string[]> | undefined): CandidateControl[] {
  const all = [...scope.controls.values()];
  const hinted = assetType ? (hints?.[assetType] ?? []).filter((id) => scope.controls.has(id)) : [];
  const byType = assetType ? all.filter((c) => c.assetTypes.includes(assetType)).map((c) => c.id) : [];
  const order = [...new Set([...hinted, ...byType, ...all.map((c) => c.id)])];
  return order.map((id) => {
    const c = scope.controls.get(id)!;
    return { id: c.id, title: c.title, objective: c.objective, assetTypes: c.assetTypes as AssetType[] };
  });
}

/** Defense in depth: drop control ids outside the assessment scope even if the AI package already did. */
export function sanitizeOutput(output: unknown, scope: AssessmentScope) {
  const o = VisionOutput.parse(output);
  const keep = (ids: string[]) => knownControls(scope, ids);
  return VisionOutput.parse({
    ...o,
    controls: o.controls.filter((c) => scope.controls.has(c.id)),
    deficiencies: o.deficiencies.map((d) => ({ ...d, controlIds: keep(d.controlIds) })),
    draftFindings: o.draftFindings.map((f) => ({ ...f, controlIds: keep(f.controlIds) })).filter((f) => f.controlIds.length > 0),
  });
}

export async function aiRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters, storage } = deps;
  const role = guard(cfg, db, limiters);
  const engine = { storage };

  app.post("/photos/:id/analyze", role("assessor", limiters.data, limiters.analyze), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const prep = await inField(db, req, async (ctx) => {
      const p = await loadRecord(ctx, ENTITIES.photo_meta, id);
      if (!p || p.meta.deleted) throw notFound("Photo");
      const scope = await requireAssessmentWrite(ctx, p.data.assessmentId as string);
      const settings = await tenantSettings(ctx);
      if (!settings.aiPhotoAnalysis) throw new AppError(409, "ai_disabled", "AI photo analysis is turned off for this workspace");
      if (p.row.status !== "stored" || !p.row.storage_key) throw new AppError(409, "photo_not_uploaded", "Upload the photo content before analysis");
      let areaName: string | null = null;
      if (p.data.areaId) areaName = (await ctx.tx.query<{ name: string }>("SELECT name FROM area WHERE id = $1", [p.data.areaId])).rows[0]?.name ?? null;
      return { p, scope, settings, areaName };
    });
    const client = deps.vision();
    if (!client) throw new AppError(503, "ai_not_configured", "AI photo analysis is not configured on this server (ANTHROPIC_API_KEY)");

    let status: "suggested" | "failed" = "failed";
    let output: unknown = null;
    let error: string | null = null;
    let model = cfg.ANTHROPIC_VISION_MODEL;
    let promptVersion = PROMPT_VERSION;
    let usage: unknown = null;
    try {
      const stored = await storage.get(prep.p.row.storage_key as string);
      const image = await sharp(stored)
        .resize({ width: AI_IMAGE_EDGE, height: AI_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const r = await analyzePhoto(
        {
          image: new Uint8Array(image),
          mediaType: "image/jpeg",
          context: {
            candidateControls: candidateControls(prep.scope, prep.p.data.assetType as string | null, deps.walkthrough?.assetTypeControls as Record<string, string[]> | undefined),
            assetTypeHint: (prep.p.data.assetType as AssetType | null) ?? null,
            areaName: prep.settings.aiShareContext ? prep.areaName : null,
            assessorNotes: prep.settings.aiShareContext ? ((prep.p.data.notes as string | null) ?? null) : null,
          },
        },
        { client, model: cfg.ANTHROPIC_VISION_MODEL },
      );
      model = r.model || model;
      promptVersion = r.promptVersion || promptVersion;
      usage = r.usage ?? null;
      output = sanitizeOutput(r.output, prep.scope);
      status = "suggested";
    } catch (err) {
      // Stored code only; provider details are logged, never returned (they may echo request data).
      error = err instanceof VisionError ? err.code : err instanceof z.ZodError ? "invalid_output" : "model_error";
      req.log.warn({ err: { message: (err as Error).message, code: error } }, "photo analysis failed");
    }

    const suggestion = await inField(db, req, async (ctx) => {
      const { rows } = await ctx.tx.query(
        `INSERT INTO ai_suggestion (tenant_id, assessment_id, photo_id, status, model, prompt_version, output, error, usage, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [ctx.auth.tenantId, prep.p.data.assessmentId, id, status, model, promptVersion, output ? JSON.stringify(output) : null, error, usage ? JSON.stringify(usage) : null, ctx.auth.userId],
      );
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "ai.analyze",
        entityType: "photo", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent, details: { suggestionId: rows[0].id, status, error, model, promptVersion },
      });
      return asSuggestion((await ctx.tx.query(`${SUGGESTION_SQL} WHERE id = $1`, [rows[0].id])).rows[0]);
    });
    return reply.code(201).send(suggestion);
  });

  app.get("/photos/:id/suggestions", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, async (ctx) => {
      const p = await ctx.tx.query("SELECT 1 FROM photo WHERE id = $1", [id]);
      if (!p.rowCount) throw notFound("Photo");
      const { rows } = await ctx.tx.query(`${SUGGESTION_SQL} WHERE photo_id = $1 ORDER BY created_at DESC, id`, [id]);
      return rows.map(asSuggestion);
    });
  });

  app.post("/suggestions/:id/review", role("assessor"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(ReviewSuggestion, req.body);
    return inField(db, req, async (ctx) => {
      const s = (await ctx.tx.query(`${SUGGESTION_SQL} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!s) throw notFound("Suggestion");
      const scope = await requireAssessmentWrite(ctx, s.assessmentId);
      if (s.status !== "suggested") throw new AppError(409, "not_reviewable", `This suggestion is ${s.status} and cannot be reviewed`);
      const photo = await loadRecord(ctx, ENTITIES.photo_meta, s.photoId);
      if (!photo || photo.meta.deleted) throw new AppError(409, "photo_deleted", "The photo was deleted");
      const output = s.output ? sanitizeOutput(s.output, scope) : null;
      if (!output) throw new AppError(409, "not_reviewable", "This suggestion has no output");

      const findings: Record<string, unknown>[] = [];
      let tags: { assetType?: string | null; severity?: string | null; controlIds?: string[] } | null = null;
      const now = new Date().toISOString();

      const createFinding = async (f: { title: string; description: string; recommendation?: string; severity: Severity; controlIds: string[] }, source: "ai_accepted" | "ai_edited") => {
        const controlIds = knownControls(scope, f.controlIds);
        if (!controlIds.length) throw new AppError(400, "unknown_control", "Each finding needs at least one control from this assessment's frameworks");
        const fid = randomUUID();
        const w = await applyWrite(ctx, "finding", {
          action: "upsert", id: fid, clientUpdatedAt: now, provenance: { source, suggestionId: id },
          data: {
            id: fid, assessmentId: s.assessmentId, areaId: photo.data.areaId, assetId: photo.data.assetId, title: f.title,
            description: f.description, recommendation: f.recommendation || undefined, severity: f.severity, status: "draft", controlIds,
          },
        }, engine);
        findings.push(w.record!);
      };

      if (body.decision === "accept") {
        const idx = body.findingIndexes ?? output.draftFindings.map((_, i) => i);
        for (const i of idx) if (!output.draftFindings[i]) throw new AppError(400, "validation_error", "Request validation failed", [{ path: "findingIndexes", message: `no draft finding ${i}` }]);
        for (const i of [...new Set(idx)]) await createFinding(output.draftFindings[i]!, "ai_accepted");
        if (body.applyTags) {
          const sev = findings.map((f) => f.severity as Severity);
          tags = {
            assetType: output.assetType.value,
            controlIds: knownControls(scope, [...(photo.data.controlIds as string[]), ...output.controls.map((c) => c.id), ...findings.flatMap((f) => f.controlIds as string[])]),
            ...(sev.length ? { severity: sev.sort((a, b) => SEVERITY_RANK.indexOf(b) - SEVERITY_RANK.indexOf(a))[0] } : {}),
          };
        }
      } else if (body.decision === "edit") {
        for (const f of body.findings) await createFinding(f, "ai_edited");
        if (body.tags) {
          tags = { ...body.tags };
          if (body.tags.controlIds) tags.controlIds = knownControls(scope, [...(photo.data.controlIds as string[]), ...body.tags.controlIds]);
        }
      }

      if (body.decision !== "reject") {
        const patch: Record<string, unknown> = { ...(tags ?? {}) };
        if (!photo.data.findingId && findings.length === 1) patch.findingId = findings[0]!.id;
        if (Object.keys(patch).length) {
          await applyWrite(ctx, "photo_meta", { action: "upsert", id: photo.data.id as string, data: patch, partial: true, clientUpdatedAt: now }, engine);
        }
      }
      const newStatus = body.decision === "accept" ? "accepted" : body.decision === "edit" ? "edited" : "rejected";
      await ctx.tx.query(
        "UPDATE ai_suggestion SET status = $2, reviewed_at = now(), reviewed_by = $3, review_reason = $4 WHERE id = $1",
        [id, newStatus, ctx.auth.userId, body.decision === "reject" ? (body.reason ?? null) : null],
      );
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: `ai.suggestion.${body.decision}`,
        entityType: "ai_suggestion", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent,
        details: { photoId: s.photoId, findingIds: findings.map((f) => f.id), tags, reason: body.decision === "reject" ? body.reason ?? null : undefined },
      });
      const after = (await ctx.tx.query(`${SUGGESTION_SQL} WHERE id = $1`, [id])).rows[0];
      const photoAfter = await loadRecord(ctx, ENTITIES.photo_meta, s.photoId);
      return { suggestion: asSuggestion(after), findings, photo: toOutput(ENTITIES.photo_meta, photoAfter!) };
    });
  });
}
