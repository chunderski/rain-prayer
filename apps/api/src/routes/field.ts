/**
 * Phase 2 field routes: areas, members, assignment, assessment status, walkthrough, answers, assets,
 * findings, tenant settings. Writes go through the shared records engine (same path as sync).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AssignAssessors, CreateArea, Uuid } from "@sentinel/shared";
import { assessmentScope, requireAssessmentWrite, type FieldCtx } from "../field/context.js";
import { ENTITIES, applyWrite, listLive, loadRecord } from "../field/records.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { authOf } from "../lib/auth.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { sectionDefs } from "../lib/walkthrough.js";
import { reqMeta } from "./auth.js";
import { inField, type FieldRouteDeps } from "./deps.js";
import { assessmentDetail } from "./tenant.js";

const IdParams = z.object({ id: Uuid });
const ChildParams = (k: string) => z.object({ id: Uuid, [k]: Uuid });

const auditField = (ctx: FieldCtx, action: string, entityType: string, entityId: string, details?: Record<string, unknown>) =>
  audit(ctx.tx, {
    tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action, entityType, entityId,
    ip: ctx.ip, userAgent: ctx.userAgent, details,
  });

const STATUS_NEXT: Record<string, string> = { draft: "in_progress", in_progress: "in_review", in_review: "complete" };

/** Findings with the framework requirements they count toward (through the pinned crosswalk). */
export async function findingsWithFrameworks(ctx: FieldCtx, assessmentId: string) {
  const findings = await listLive(ctx, "finding", "assessment_id", assessmentId);
  const scope = await assessmentScope(ctx, assessmentId);
  const { rows } = await ctx.tx.query<{ c: string; frameworkId: string; requirementCode: string; relationship: string }>(
    `SELECT cw.shared_control_id AS c, cw.framework_id AS "frameworkId", cw.requirement_code AS "requirementCode", cw.relationship
       FROM crosswalk cw JOIN assessment_framework af ON af.framework_id = cw.framework_id AND af.version = cw.version
      WHERE af.assessment_id = $1 AND cw.library_version = $2
      ORDER BY cw.framework_id, cw.requirement_code`,
    [assessmentId, scope.libraryVersion],
  );
  return findings.map((f) => {
    const ids = new Set(f.controlIds as string[]);
    const seen = new Set<string>();
    const frameworks = rows
      .filter((r) => ids.has(r.c))
      .filter((r) => {
        const k = `${r.frameworkId}:${r.requirementCode}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(({ frameworkId, requirementCode, relationship }) => ({ frameworkId, requirementCode, relationship }));
    return { ...f, frameworks };
  });
}

export async function fieldRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters } = deps;
  const role = guard(cfg, db, limiters);
  const engine = { storage: deps.storage };
  const now = () => new Date().toISOString();

  // ---------------------------------------------------------------- areas
  app.get("/sites/:id/areas", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, async (ctx) => {
      const s = await ctx.tx.query("SELECT 1 FROM site WHERE id = $1", [id]);
      if (!s.rowCount) throw notFound("Site");
      return listLive(ctx, "area", "site_id", id, "sort_order, lower(name), id");
    });
  });

  app.post("/sites/:id/areas", role("assessor"), async (req, reply) => {
    const { id: siteId } = parse(IdParams, req.params);
    const body = parse(CreateArea, req.body);
    const id = body.id ?? randomUUID();
    const r = await inField(db, req, async (ctx) => {
      const existing = await loadRecord(ctx, ENTITIES.area, id);
      const w = await applyWrite(ctx, "area", { action: "upsert", id, data: { ...body, id, siteId }, clientUpdatedAt: now() }, engine);
      if (!existing) await auditField(ctx, "area.create", "area", id, { siteId });
      return w;
    });
    return reply.code(201).send(r.record);
  });

  app.patch("/areas/:id", role("assessor"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(CreateArea.omit({ id: true }).partial(), req.body);
    return inField(db, req, async (ctx) => {
      const existing = await loadRecord(ctx, ENTITIES.area, id);
      if (!existing || existing.meta.deleted) throw notFound("Area");
      // Only send fields the client gave: zod defaults on the partial would otherwise reset them.
      const given = Object.fromEntries(Object.keys(req.body as object).filter((k) => k in body).map((k) => [k, (body as Record<string, unknown>)[k]]));
      const w = await applyWrite(ctx, "area", { action: "upsert", id, data: given, partial: true, clientUpdatedAt: now() }, engine);
      return w.record;
    });
  });

  app.delete("/areas/:id", role("admin"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    await inField(db, req, async (ctx) => {
      const existing = await loadRecord(ctx, ENTITIES.area, id);
      if (!existing || existing.meta.deleted) throw notFound("Area");
      await applyWrite(ctx, "area", { action: "delete", id, clientUpdatedAt: now() }, engine);
      await auditField(ctx, "area.delete", "area", id);
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- members and assignment
  app.get("/members", role("admin"), async (req) =>
    db.withTenant(authOf(req).tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT m.user_id AS "userId", u.email, u.name, m.role FROM membership m JOIN app_user u ON u.id = m.user_id
          WHERE u.disabled_at IS NULL ORDER BY lower(u.name), u.id`,
      );
      return rows;
    }),
  );

  app.put("/assessments/:id/assessors", role("admin"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(AssignAssessors, req.body);
    const userIds = [...new Set(body.userIds)].sort();
    return inField(db, req, async (ctx) => {
      await assessmentScope(ctx, id);
      const m = await ctx.tx.query<{ user_id: string }>(
        "SELECT user_id FROM membership WHERE user_id = ANY($1::uuid[]) AND role IN ('owner', 'admin', 'assessor')",
        [userIds],
      );
      const ok = new Set(m.rows.map((r) => r.user_id));
      const bad = userIds.filter((u) => !ok.has(u));
      if (bad.length) throw new AppError(400, "invalid_assessor", "Every assessor must be a member of this workspace with role assessor or higher", { userIds: bad });
      await ctx.tx.query("DELETE FROM assessment_assessor WHERE assessment_id = $1 AND NOT (user_id = ANY($2::uuid[]))", [id, userIds]);
      await ctx.tx.query(
        `INSERT INTO assessment_assessor (tenant_id, assessment_id, user_id, created_by)
         SELECT $1, $2, unnest($3::uuid[]), $4 ON CONFLICT DO NOTHING`,
        [ctx.auth.tenantId, id, userIds, ctx.auth.userId],
      );
      await auditField(ctx, "assessment.assign", "assessment", id, { userIds });
      return { userIds };
    });
  });

  const PatchAssessment = z
    .object({ status: z.enum(["draft", "in_progress", "in_review", "complete"]).optional(), title: z.string().trim().min(1).max(200).optional() })
    .strict();
  app.patch("/assessments/:id", role("assessor"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(PatchAssessment, req.body ?? {});
    return inField(db, req, async (ctx) => {
      const scope = await requireAssessmentWrite(ctx, id);
      if (body.status && body.status !== scope.status && STATUS_NEXT[scope.status] !== body.status) {
        throw new AppError(409, "invalid_transition", `Status can move from ${scope.status} only to ${STATUS_NEXT[scope.status] ?? "nothing"}`);
      }
      await ctx.tx.query(
        "UPDATE assessment SET status = COALESCE($2, status), title = COALESCE($3, title), updated_at = now() WHERE id = $1",
        [id, body.status ?? null, body.title ?? null],
      );
      await auditField(ctx, "assessment.update", "assessment", id, { from: scope.status, ...body });
      return assessmentDetail(ctx.tx, id);
    });
  });

  // ---------------------------------------------------------------- walkthrough
  app.get("/assessments/:id/walkthrough", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, async (ctx) => {
      const scope = await assessmentScope(ctx, id);
      const lv = scope.libraryVersion;
      const ids = [...scope.controls.keys()];
      const ctrl = await ctx.tx.query(
        `SELECT id, domain, title, objective, default_severity AS "defaultSeverity", asset_types AS "assetTypes"
           FROM shared_control WHERE library_version = $1 AND id = ANY($2::text[]) ORDER BY id`,
        [lv, ids],
      );
      const qs = await ctx.tx.query(
        `SELECT shared_control_id AS c, id, text, answer_type AS "answerType", compliant_answer AS "compliantAnswer", options, scale, unit,
                guidance, photo_on_deficiency AS "photoOnDeficiency"
           FROM question WHERE library_version = $1 AND shared_control_id = ANY($2::text[]) ORDER BY shared_control_id, sort_order`,
        [lv, ids],
      );
      const fw = await ctx.tx.query(
        `SELECT cw.shared_control_id AS c, cw.framework_id AS "frameworkId", fv.short_name AS "shortName",
                cw.requirement_code AS "requirementCode", cw.relationship
           FROM crosswalk cw
           JOIN assessment_framework af ON af.framework_id = cw.framework_id AND af.version = cw.version
           JOIN framework_version fv ON fv.framework_id = cw.framework_id AND fv.version = cw.version
          WHERE af.assessment_id = $1 AND cw.library_version = $2
          ORDER BY fv.short_name, cw.requirement_code`,
        [id, lv],
      );
      const assessors = await ctx.tx.query(
        `SELECT aa.user_id AS "userId", u.name FROM assessment_assessor aa JOIN app_user u ON u.id = aa.user_id
          WHERE aa.assessment_id = $1 ORDER BY lower(u.name)`,
        [id],
      );
      const questions = new Map<string, unknown[]>();
      for (const { c, ...q } of qs.rows) {
        const clean = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== null));
        questions.set(c, [...(questions.get(c) ?? []), clean]);
      }
      const frameworks = new Map<string, unknown[]>();
      for (const { c, ...f } of fw.rows) frameworks.set(c, [...(frameworks.get(c) ?? []), f]);
      const controls = ctrl.rows.map((c) => ({ ...c, frameworks: frameworks.get(c.id) ?? [], questions: questions.get(c.id) ?? [] }));

      const placed = new Set<string>();
      const sections = sectionDefs(deps.walkthrough).map((s) => {
        const mine = controls.filter((c) => s.domains.includes(c.domain) && !placed.has(c.id));
        mine.forEach((c) => placed.add(c.id));
        return { ...s, controls: mine.map(({ domain: _d, ...c }) => c) };
      });
      const leftovers = controls.filter((c) => !placed.has(c.id));
      if (leftovers.length) {
        const domains = [...new Set(leftovers.map((c) => c.domain))];
        sections.push({
          id: "other", title: "Other controls", description: "Controls not placed in a walkthrough section.",
          order: sections.length ? Math.max(...sections.map((s) => s.order)) + 1 : 0, domains, controls: leftovers.map(({ domain: _d, ...c }) => c),
        });
      }
      return {
        assessmentId: id,
        libraryVersion: lv,
        sections: sections.filter((s) => s.controls.length > 0),
        areas: await listLive(ctx, "area", "site_id", scope.siteId, "sort_order, lower(name), id"),
        answers: await listLive(ctx, "answer", "assessment_id", id),
        findings: await listLive(ctx, "finding", "assessment_id", id),
        photos: await listLive(ctx, "photo_meta", "assessment_id", id, "captured_at, id"),
        assets: await listLive(ctx, "asset", "assessment_id", id),
        assessors: assessors.rows,
      };
    });
  });

  // ---------------------------------------------------------------- answers, assets, findings (online path)
  const putRoute = (path: string, param: string, entity: "answer" | "asset" | "finding") =>
    app.put(path, role("assessor"), async (req, reply) => {
      const p = parse(ChildParams(param), req.params) as { id: string } & Record<string, string>;
      const recordId = p[param]!;
      const body = req.body as Record<string, unknown> | undefined;
      if (body && typeof body === "object" && body.assessmentId !== undefined && body.assessmentId !== p.id) {
        throw new AppError(400, "validation_error", "Request validation failed", [{ path: "assessmentId", message: "must match the URL" }]);
      }
      const r = await inField(db, req, (ctx) =>
        applyWrite(ctx, entity, { action: "upsert", id: recordId, data: { ...(body ?? {}), id: recordId, assessmentId: p.id }, clientUpdatedAt: now() }, engine),
      );
      return reply.code(r.created ? 201 : 200).send(r.record);
    });
  putRoute("/assessments/:id/answers/:answerId", "answerId", "answer");
  putRoute("/assessments/:id/assets/:assetId", "assetId", "asset");
  putRoute("/assessments/:id/findings/:findingId", "findingId", "finding");

  app.delete("/assessments/:id/findings/:findingId", role("assessor"), async (req, reply) => {
    const p = parse(ChildParams("findingId"), req.params) as { id: string; findingId: string };
    await inField(db, req, async (ctx) => {
      const existing = await loadRecord(ctx, ENTITIES.finding, p.findingId);
      if (!existing || existing.meta.deleted || existing.data.assessmentId !== p.id) {
        await assessmentScope(ctx, p.id); // 404 for an invisible assessment first
        throw notFound("Finding");
      }
      await applyWrite(ctx, "finding", { action: "delete", id: p.findingId, clientUpdatedAt: now() }, engine);
      await auditField(ctx, "finding.delete", "finding", p.findingId);
    });
    return reply.code(204).send();
  });

  app.get("/assessments/:id/findings", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, async (ctx) => {
      await assessmentScope(ctx, id);
      return findingsWithFrameworks(ctx, id);
    });
  });

  // ---------------------------------------------------------------- tenant settings
  const SETTINGS_SQL = `SELECT allow_gps AS "allowGps", ai_photo_analysis AS "aiPhotoAnalysis", ai_share_context AS "aiShareContext" FROM tenant_settings`;
  const DEFAULTS = { allowGps: false, aiPhotoAnalysis: true, aiShareContext: false };
  app.get("/tenant/settings", role("viewer"), async (req) =>
    db.withTenant(authOf(req).tenantId, async (tx) => (await tx.query(SETTINGS_SQL)).rows[0] ?? DEFAULTS),
  );

  const PatchSettings = z.object({ allowGps: z.boolean(), aiPhotoAnalysis: z.boolean(), aiShareContext: z.boolean() }).partial().strict();
  app.patch("/tenant/settings", role("admin"), async (req) => {
    const a = authOf(req);
    const body = parse(PatchSettings, req.body ?? {});
    return db.withTenant(a.tenantId, async (tx) => {
      const cur = (await tx.query(SETTINGS_SQL)).rows[0] ?? DEFAULTS;
      const next = { ...cur, ...body };
      await tx.query(
        `INSERT INTO tenant_settings (tenant_id, allow_gps, ai_photo_analysis, ai_share_context, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET allow_gps = EXCLUDED.allow_gps, ai_photo_analysis = EXCLUDED.ai_photo_analysis,
           ai_share_context = EXCLUDED.ai_share_context, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [a.tenantId, next.allowGps, next.aiPhotoAnalysis, next.aiShareContext, a.userId],
      );
      await audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "tenant.settings.update", entityType: "tenant", entityId: a.tenantId, ...reqMeta(req), details: { from: cur, to: next } });
      return next;
    });
  });
}
