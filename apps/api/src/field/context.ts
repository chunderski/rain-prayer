/**
 * Per-request field context: access checks (assignment), the pinned library scope of an
 * assessment, and tenant settings. Shared by the REST routes and sync so both validate the same way.
 */
import type { FastifyRequest } from "fastify";
import { hasRole } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import type { AuthContext } from "../lib/auth.js";
import { AppError, notFound } from "../lib/errors.js";

export interface TenantSettings {
  allowGps: boolean;
  aiPhotoAnalysis: boolean;
  aiShareContext: boolean;
}
export const DEFAULT_SETTINGS: TenantSettings = { allowGps: false, aiPhotoAnalysis: true, aiShareContext: false };

export interface QuestionInfo {
  id: string;
  controlId: string;
  answerType: string;
  options: { value: string }[] | null;
  scale: { min: number; max: number } | null;
}

export interface AssessmentScope {
  id: string;
  siteId: string;
  libraryVersion: string | null;
  status: string;
  /** Shared controls reachable through the assessment's pinned frameworks in its pinned library release. */
  controls: Map<string, { id: string; title: string; objective: string; assetTypes: string[]; domain: string }>;
  questions: Map<string, QuestionInfo>;
}

export interface FieldCtx {
  tx: Tx;
  auth: AuthContext;
  ip?: string;
  userAgent?: string;
  /** Actions to run after COMMIT (object deletions). */
  afterCommit: (() => Promise<void>)[];
  cache: { scopes: Map<string, AssessmentScope>; settings?: TenantSettings; assigned: Map<string, boolean> };
}

export function fieldCtx(tx: Tx, auth: AuthContext, req?: FastifyRequest): FieldCtx {
  return {
    tx, auth, ip: req?.ip, userAgent: req?.headers["user-agent"], afterCommit: [],
    cache: { scopes: new Map(), assigned: new Map() },
  };
}

export async function runAfterCommit(ctx: FieldCtx, log?: (err: unknown) => void) {
  for (const fn of ctx.afterCommit) await fn().catch((err) => log?.(err));
}

export async function tenantSettings(ctx: FieldCtx): Promise<TenantSettings> {
  if (ctx.cache.settings) return ctx.cache.settings;
  const { rows } = await ctx.tx.query(
    `SELECT allow_gps AS "allowGps", ai_photo_analysis AS "aiPhotoAnalysis", ai_share_context AS "aiShareContext" FROM tenant_settings`,
  );
  ctx.cache.settings = rows[0] ?? { ...DEFAULT_SETTINGS };
  return ctx.cache.settings!;
}

export async function assessmentScope(ctx: FieldCtx, assessmentId: string): Promise<AssessmentScope> {
  const cached = ctx.cache.scopes.get(assessmentId);
  if (cached) return cached;
  const a = await ctx.tx.query<{ id: string; site_id: string; library_version: string | null; status: string }>(
    "SELECT id, site_id, library_version, status FROM assessment WHERE id = $1",
    [assessmentId],
  );
  const row = a.rows[0];
  if (!row) throw notFound("Assessment");
  const c = await ctx.tx.query<{ id: string; title: string; objective: string; asset_types: string[]; domain: string }>(
    `SELECT sc.id, sc.title, sc.objective, sc.asset_types, sc.domain FROM shared_control sc
      WHERE sc.library_version = $2 AND sc.id IN (
        SELECT cw.shared_control_id FROM assessment_framework af
          JOIN crosswalk cw ON cw.framework_id = af.framework_id AND cw.version = af.version AND cw.library_version = $2
         WHERE af.assessment_id = $1)
      ORDER BY sc.id`,
    [assessmentId, row.library_version],
  );
  const q = await ctx.tx.query<{ id: string; shared_control_id: string; answer_type: string; options: { value: string }[] | null; scale: { min: number; max: number } | null }>(
    `SELECT id, shared_control_id, answer_type, options, scale FROM question
      WHERE library_version = $1 AND shared_control_id = ANY($2::text[])`,
    [row.library_version, c.rows.map((r) => r.id)],
  );
  const scope: AssessmentScope = {
    id: row.id,
    siteId: row.site_id,
    libraryVersion: row.library_version,
    status: row.status,
    controls: new Map(c.rows.map((r) => [r.id, { id: r.id, title: r.title, objective: r.objective, assetTypes: r.asset_types, domain: r.domain }])),
    questions: new Map(q.rows.map((r) => [r.id, { id: r.id, controlId: r.shared_control_id, answerType: r.answer_type, options: r.options, scale: r.scale }])),
  };
  ctx.cache.scopes.set(assessmentId, scope);
  return scope;
}

export const notAssigned = () => new AppError(403, "forbidden", "You are not assigned to this assessment");

/** Throws 404 when the assessment is not visible, 403 when an assessor is not assigned to it. */
export async function requireAssessmentWrite(ctx: FieldCtx, assessmentId: string): Promise<AssessmentScope> {
  const scope = await assessmentScope(ctx, assessmentId);
  if (!hasRole(ctx.auth.role, "assessor")) throw new AppError(403, "forbidden", "Requires role assessor or higher");
  if (hasRole(ctx.auth.role, "admin")) return scope;
  let ok = ctx.cache.assigned.get(assessmentId);
  if (ok === undefined) {
    const r = await ctx.tx.query("SELECT 1 FROM assessment_assessor WHERE assessment_id = $1 AND user_id = $2", [assessmentId, ctx.auth.userId]);
    ok = !!r.rowCount;
    ctx.cache.assigned.set(assessmentId, ok);
  }
  if (!ok) throw notAssigned();
  return scope;
}

/** Areas belong to a site: assessors may write them when assigned to any assessment at that site. */
export async function requireSiteWrite(ctx: FieldCtx, siteId: string): Promise<void> {
  const s = await ctx.tx.query("SELECT 1 FROM site WHERE id = $1", [siteId]);
  if (!s.rowCount) throw notFound("Site");
  if (!hasRole(ctx.auth.role, "assessor")) throw new AppError(403, "forbidden", "Requires role assessor or higher");
  if (hasRole(ctx.auth.role, "admin")) return;
  const r = await ctx.tx.query(
    `SELECT 1 FROM assessment_assessor aa JOIN assessment a ON a.id = aa.assessment_id
      WHERE a.site_id = $1 AND aa.user_id = $2 LIMIT 1`,
    [siteId, ctx.auth.userId],
  );
  if (!r.rowCount) throw new AppError(403, "forbidden", "You are not assigned to an assessment at this site");
}

/** Drops control ids that are not in the assessment's pinned scope (used for AI output). */
export const knownControls = (scope: AssessmentScope, ids: readonly string[]) => [...new Set(ids.filter((id) => scope.controls.has(id)))];

/** Rejects control ids that are not in the assessment's pinned scope (used for human input). */
export function requireKnownControls(scope: AssessmentScope, ids: readonly string[]): string[] {
  const unknown = ids.filter((id) => !scope.controls.has(id));
  if (unknown.length) throw new AppError(400, "unknown_control", "One or more controls are not part of this assessment's frameworks", { controlIds: unknown });
  return [...new Set(ids)].sort();
}
