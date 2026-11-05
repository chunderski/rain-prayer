/** Loads everything the report template needs for one assessment, inside the caller's tenant transaction. */
import type { FieldCtx } from "../field/context.js";
import { assessmentScope } from "../field/context.js";
import { AppError, notFound } from "../lib/errors.js";
import type { RiskService } from "../risk/service.js";
import { findingsWithFrameworks } from "../routes/field.js";
import type { NarrativeSection, ReportData, ReportFinding, ReportImage } from "./model.js";

const MAX_PHOTOS_PER_FINDING = 6;
const MAX_PHOTOS_TOTAL = 200;

export interface StoredPhoto {
  id: string;
  storageKey: string;
  findingId: string | null;
  areaName: string | null;
  assetType: string | null;
  notes: string | null;
  capturedAt: string;
}

export async function storedPhotos(ctx: FieldCtx, assessmentId: string): Promise<StoredPhoto[]> {
  const { rows } = await ctx.tx.query<StoredPhoto>(
    `SELECT p.id, p.storage_key AS "storageKey", p.finding_id AS "findingId", ar.name AS "areaName", p.asset_type AS "assetType",
            p.notes, p.captured_at AS "capturedAt"
       FROM photo p LEFT JOIN area ar ON ar.id = p.area_id
      WHERE p.assessment_id = $1 AND p.deleted_at IS NULL AND p.status = 'stored' AND p.storage_key IS NOT NULL
      ORDER BY p.captured_at, p.id`,
    [assessmentId],
  );
  return rows;
}

export async function loadReportData(ctx: FieldCtx, assessmentId: string, risk: RiskService): Promise<ReportData> {
  const scope = await assessmentScope(ctx, assessmentId);
  const { rows } = await ctx.tx.query(
    `SELECT a.id, a.title, a.status, c.name AS "clientName", s.name AS "siteName", s.address AS "siteAddress",
            a.library_version AS "libraryVersion", t.name AS "tenantName",
            COALESCE((SELECT jsonb_agg(jsonb_build_object('frameworkId', af.framework_id, 'version', af.version,
                                                          'shortName', fv.short_name, 'name', fv.name) ORDER BY fv.short_name)
                        FROM assessment_framework af
                        JOIN framework_version fv ON fv.framework_id = af.framework_id AND fv.version = af.version
                       WHERE af.assessment_id = a.id), '[]') AS frameworks
       FROM assessment a JOIN site s ON s.id = a.site_id JOIN client c ON c.id = s.client_id JOIN tenant t ON t.id = a.tenant_id
      WHERE a.id = $1`,
    [assessmentId],
  );
  const a = rows[0];
  if (!a) throw notFound("Assessment");

  let riskResult = null;
  let riskError: string | null = null;
  try {
    riskResult = await risk.resultFor(ctx, assessmentId);
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode !== 503) throw err;
    riskError = "the scoring engine is unavailable";
  }

  type F = Record<string, unknown> & { frameworks: ReportFinding["frameworks"] };
  const all = (await findingsWithFrameworks(ctx, assessmentId)) as F[];
  const areas = new Map(
    (await ctx.tx.query<{ id: string; name: string }>("SELECT id, name FROM area WHERE site_id = $1", [scope.siteId])).rows.map((r) => [r.id, r.name]),
  );
  const photos = await storedPhotos(ctx, assessmentId);
  let budget = MAX_PHOTOS_TOTAL;
  const included = all.filter((f) => f.status === "confirmed" || f.status === "resolved");
  const findings: ReportFinding[] = included.map((f) => {
    const mine: ReportImage[] = photos
      .filter((p) => p.findingId === f.id)
      .slice(0, Math.min(MAX_PHOTOS_PER_FINDING, budget))
      .map((p) => ({ photoId: p.id, storageKey: p.storageKey, caption: [p.areaName, p.assetType?.replace(/_/g, " "), p.notes].filter(Boolean).join(", ") }));
    budget -= mine.length;
    return {
      id: f.id as string,
      title: f.title as string,
      description: (f.description as string) ?? "",
      ...(f.recommendation ? { recommendation: f.recommendation as string } : {}),
      severity: f.severity as ReportFinding["severity"],
      status: f.status as string,
      areaName: f.areaId ? areas.get(f.areaId as string) ?? null : null,
      controlIds: f.controlIds as string[],
      frameworks: f.frameworks,
      photos: mine,
    };
  });

  const n = await ctx.tx.query<{ section: NarrativeSection; text: string; status: "ai_draft" | "edited" | "approved" }>(
    "SELECT section, text, status FROM narrative WHERE assessment_id = $1",
    [assessmentId],
  );
  const review = await ctx.tx.query<{ requirements: number; controls: number }>(
    `SELECT (SELECT count(*)::int FROM requirement r JOIN assessment_framework af ON af.framework_id = r.framework_id AND af.version = r.version
              WHERE af.assessment_id = $1 AND r.status = 'needs_review') AS requirements,
            (SELECT count(*)::int FROM shared_control sc WHERE sc.library_version = $2 AND sc.id = ANY($3::text[]) AND sc.status <> 'approved') AS controls`,
    [assessmentId, scope.libraryVersion, [...scope.controls.keys()]],
  );

  return {
    tenantName: a.tenantName,
    assessment: {
      id: a.id, title: a.title, status: a.status, clientName: a.clientName, siteName: a.siteName, siteAddress: a.siteAddress,
      libraryVersion: a.libraryVersion, frameworks: a.frameworks,
    },
    generatedAt: new Date().toISOString(),
    risk: riskResult,
    riskError,
    findings,
    draftFindingCount: all.filter((f) => f.status === "draft").length,
    narratives: Object.fromEntries(n.rows.map((r) => [r.section, { text: r.text, status: r.status }])),
    review: { requirementsPending: review.rows[0]?.requirements ?? 0, controlsPending: review.rows[0]?.controls ?? 0 },
  };
}
