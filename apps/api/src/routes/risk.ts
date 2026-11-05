/** Phase 3 risk routes: scenario library, inputs, results, site comparison, dashboard. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PutScenarioInputs, Uuid, type RiskResult } from "@sentinel/shared";
import type { CompareInput } from "@sentinel/risk";
import { assessmentScope, requireAssessmentWrite, type FieldCtx } from "../field/context.js";
import { listLive } from "../field/records.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { riskUnavailable } from "../risk/service.js";
import { inField, type FieldRouteDeps } from "./deps.js";

const IdParams = z.object({ id: Uuid });
export const RISK_METHOD_HEADER = "X-Risk-Method";

export async function riskRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters, risk } = deps;
  const role = guard(cfg, db, limiters);

  app.get("/risk/scenarios", role("viewer"), async (_req, reply) => {
    reply.header(RISK_METHOD_HEADER, risk.methodVersion);
    return risk.library();
  });

  const inputsOf = async (ctx: FieldCtx, id: string) => {
    const scenarios = await risk.relevant(ctx, id);
    const stored = new Map((await risk.storedInputs(ctx.tx, id)).map((i) => [i.scenarioId, i]));
    return {
      scenarios: scenarios.map((s) => {
        const i = stored.get(s.id);
        return {
          scenarioId: s.id,
          likelihood: i?.likelihood ?? null,
          impact: i?.impact ?? null,
          ...(i?.rationale ? { rationale: i.rationale } : {}),
          excluded: i?.excluded ?? false,
        };
      }),
    };
  };

  app.get("/assessments/:id/risk/inputs", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, (ctx) => inputsOf(ctx, id));
  });

  /** Upserts the scenarios in the body; scenarios not in the body keep their stored values. */
  app.put("/assessments/:id/risk/inputs", role("assessor"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(PutScenarioInputs, req.body);
    return inField(db, req, async (ctx) => {
      await requireAssessmentWrite(ctx, id);
      const relevant = new Set((await risk.relevant(ctx, id)).map((s) => s.id));
      const seen = new Set<string>();
      const problems: { path: string; message: string }[] = [];
      body.scenarios.forEach((s, i) => {
        if (!relevant.has(s.scenarioId)) problems.push({ path: `scenarios.${i}.scenarioId`, message: "not a scenario for this assessment" });
        if (seen.has(s.scenarioId)) problems.push({ path: `scenarios.${i}.scenarioId`, message: "duplicate scenario" });
        seen.add(s.scenarioId);
      });
      if (problems.length) throw new AppError(400, "unknown_scenario", "One or more scenarios are not valid for this assessment", problems);
      for (const s of body.scenarios) {
        await ctx.tx.query(
          `INSERT INTO scenario_input (tenant_id, assessment_id, scenario_id, likelihood, impact, rationale, excluded, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (assessment_id, scenario_id) DO UPDATE SET likelihood = EXCLUDED.likelihood, impact = EXCLUDED.impact,
             rationale = EXCLUDED.rationale, excluded = EXCLUDED.excluded, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [ctx.auth.tenantId, id, s.scenarioId, s.likelihood, s.impact, s.rationale ?? null, s.excluded, ctx.auth.userId],
        );
      }
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "risk.inputs.update",
        entityType: "assessment", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent, details: { scenarioIds: [...seen] },
      });
      return inputsOf(ctx, id);
    });
  });

  app.get("/assessments/:id/risk", role("viewer"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const result = await inField(db, req, (ctx) => risk.resultFor(ctx, id));
    reply.header(RISK_METHOD_HEADER, result.methodVersion);
    return result;
  });

  const CompareQuery = z.object({
    assessmentIds: z
      .string()
      .max(20 * 37 + 20)
      .transform((v) => [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))])
      .pipe(z.array(Uuid).min(1).max(20)),
  });
  app.get("/risk/compare", role("viewer"), async (req, reply) => {
    const { assessmentIds } = parse(CompareQuery, req.query);
    const inputs = await inField(db, req, async (ctx) => {
      const out: CompareInput[] = [];
      for (const id of assessmentIds) {
        const scope = await assessmentScope(ctx, id);
        const { rows } = await ctx.tx.query<{ siteName: string; clientName: string; completedAt: Date | null; frameworks: string[] }>(
          `SELECT s.name AS "siteName", c.name AS "clientName",
                  CASE WHEN a.status = 'complete' THEN (SELECT max(created_at) FROM risk_snapshot r WHERE r.assessment_id = a.id) END AS "completedAt",
                  COALESCE((SELECT array_agg(af.framework_id || '@' || af.version ORDER BY af.framework_id) FROM assessment_framework af WHERE af.assessment_id = a.id), '{}') AS frameworks
             FROM assessment a JOIN site s ON s.id = a.site_id JOIN client c ON c.id = s.client_id WHERE a.id = $1`,
          [id],
        );
        const r = rows[0];
        if (!r) throw notFound("Assessment");
        out.push({
          assessmentId: id,
          siteName: r.siteName,
          clientName: r.clientName,
          completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
          result: await risk.resultFor(ctx, id),
          findings: (await listLive(ctx, "finding", "assessment_id", id)) as never,
          frameworks: r.frameworks,
          libraryVersion: scope.libraryVersion ?? "",
        });
      }
      return out;
    });
    let comparison;
    try {
      comparison = risk.engine.compareSites(inputs);
    } catch (err) {
      throw riskUnavailable(err);
    }
    reply.header(RISK_METHOD_HEADER, comparison.methodVersion);
    return comparison;
  });

  app.get("/dashboard", role("viewer"), async (req) =>
    inField(db, req, async ({ tx }) => {
      const byStatus = await tx.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM assessment GROUP BY status");
      const bySev = await tx.query<{ severity: string; n: number }>(
        "SELECT severity, count(*)::int AS n FROM finding WHERE deleted_at IS NULL AND status <> 'resolved' GROUP BY severity",
      );
      const assessmentsByStatus = Object.fromEntries(["draft", "in_progress", "in_review", "complete", "archived"].map((s) => [s, 0]));
      for (const r of byStatus.rows) assessmentsByStatus[r.status] = r.n;
      const findingsBySeverity = Object.fromEntries(["info", "low", "medium", "high", "critical"].map((s) => [s, 0]));
      for (const r of bySev.rows) findingsBySeverity[r.severity] = r.n;
      // Top residual risks come from frozen snapshots (complete assessments), so the dashboard never recomputes.
      const snaps = await tx.query<{ assessmentId: string; siteName: string; result: RiskResult }>(
        `SELECT DISTINCT ON (r.assessment_id) r.assessment_id AS "assessmentId", s.name AS "siteName", r.result
           FROM risk_snapshot r JOIN assessment a ON a.id = r.assessment_id JOIN site s ON s.id = a.site_id
          WHERE a.status = 'complete' ORDER BY r.assessment_id, r.created_at DESC, r.id DESC`,
      );
      const topResidual = snaps.rows
        .flatMap((r) => r.result.scenarios.map((sc) => ({ assessmentId: r.assessmentId, siteName: r.siteName, scenarioName: sc.name, level: sc.residual.level, residual: sc.residual.score })))
        .sort((a, b) => b.residual - a.residual || a.siteName.localeCompare(b.siteName) || a.scenarioName.localeCompare(b.scenarioName))
        .slice(0, 10);
      const recent = await tx.query(
        `SELECT a.id, a.title, a.status, s.name AS "siteName", c.name AS "clientName", a.updated_at AS "updatedAt"
           FROM assessment a JOIN site s ON s.id = a.site_id JOIN client c ON c.id = s.client_id
          ORDER BY a.updated_at DESC, a.id LIMIT 10`,
      );
      return {
        assessmentsByStatus,
        findingsBySeverity,
        openHighFindings: (findingsBySeverity.high ?? 0) + (findingsBySeverity.critical ?? 0),
        topResidual,
        recent: recent.rows,
      };
    }),
  );
}
