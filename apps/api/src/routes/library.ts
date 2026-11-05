/** Framework library endpoints (global reference data; no tenant context needed). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ControlDomain, FrameworkId, SEMVER, SharedControlId } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { guard, type Limiters } from "../lib/access.js";
import { notFound, parse } from "../lib/errors.js";

const SEMVER_ORDER = (col: string) => `string_to_array(${col}, '.')::int[]`;

/** Latest loaded library release (controls and crosswalk version), or null if none. */
export async function currentLibraryVersion(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ version: string }>(
    `SELECT version FROM library_release ORDER BY ${SEMVER_ORDER("version")} DESC LIMIT 1`,
  );
  return rows[0]?.version ?? null;
}

const omitNull = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

export async function libraryRoutes(app: FastifyInstance, { cfg, db, limiters }: { cfg: Config; db: Db; limiters: Limiters }) {
  const viewer = guard(cfg, db, limiters)("viewer");

  app.get("/frameworks", viewer, async () => {
    const lib = await currentLibraryVersion(db);
    const { rows } = await db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (framework_id) * FROM framework_version
          ORDER BY framework_id, ${SEMVER_ORDER("version")} DESC)
       SELECT l.framework_id AS id, l.name, l.short_name AS "shortName", l.kind, l.category, l.description,
              l.publisher, l.source_edition AS "sourceEdition", l.version,
              (SELECT count(*)::int FROM requirement r WHERE r.framework_id = l.framework_id AND r.version = l.version) AS "requirementCount",
              (SELECT count(DISTINCT c.shared_control_id)::int FROM crosswalk c
                WHERE c.framework_id = l.framework_id AND c.version = l.version AND c.library_version = $1) AS "controlCount",
              (SELECT count(*)::int FROM requirement r
                WHERE r.framework_id = l.framework_id AND r.version = l.version AND r.status = 'needs_review') AS "needsReviewCount"
         FROM latest l ORDER BY l.name`,
      [lib],
    );
    return rows;
  });

  const VersionParams = z.object({ id: FrameworkId, version: z.string().regex(SEMVER, "version must be semver (x.y.z)") });
  app.get("/frameworks/:id/versions/:version", viewer, async (req) => {
    const p = parse(VersionParams, req.params);
    const fv = await db.query(
      `SELECT framework_id AS id, name, short_name AS "shortName", version, source_edition AS "sourceEdition",
              publisher, kind, category, description, sources, levels
         FROM framework_version WHERE framework_id = $1 AND version = $2`,
      [p.id, p.version],
    );
    if (!fv.rows[0]) throw notFound("Framework version");
    // Mappings come from the newest library release that maps this framework version.
    const libQ = await db.query<{ library_version: string }>(
      `SELECT library_version FROM crosswalk WHERE framework_id = $1 AND version = $2
        GROUP BY library_version ORDER BY ${SEMVER_ORDER("library_version")} DESC LIMIT 1`,
      [p.id, p.version],
    );
    const reqs = await db.query(
      `SELECT r.code, r.title, r.text, r.level, r.parent_code AS "parentCode", r.citation, r.status, r.scale,
              COALESCE((SELECT array_agg(DISTINCT c.shared_control_id ORDER BY c.shared_control_id) FROM crosswalk c
                         WHERE c.framework_id = r.framework_id AND c.version = r.version
                           AND c.requirement_code = r.code AND c.library_version = $3), '{}') AS "controlIds"
         FROM requirement r WHERE r.framework_id = $1 AND r.version = $2 ORDER BY r.sort_order`,
      [p.id, p.version, libQ.rows[0]?.library_version ?? null],
    );
    return { ...fv.rows[0], requirements: reqs.rows.map((r) => ({ ...omitNull(r), controlIds: r.controlIds })) };
  });

  const ControlsQuery = z.object({
    framework: FrameworkId.optional(),
    domain: ControlDomain.optional(),
    q: z.string().trim().max(200).optional(),
  });
  app.get("/controls", viewer, async (req) => {
    const f = parse(ControlsQuery, req.query);
    const lib = await currentLibraryVersion(db);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const { rows } = await db.query(
      `SELECT sc.id, sc.domain, sc.title, sc.objective, sc.default_severity AS "defaultSeverity",
              sc.asset_types AS "assetTypes", sc.status,
              (SELECT count(*)::int FROM question q WHERE q.shared_control_id = sc.id AND q.library_version = sc.library_version) AS "questionCount",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('frameworkId', c.framework_id, 'requirementCode', c.requirement_code,
                                                            'relationship', c.relationship) ORDER BY c.framework_id, c.requirement_code)
                          FROM crosswalk c WHERE c.shared_control_id = sc.id AND c.library_version = sc.library_version), '[]') AS mappings
         FROM shared_control sc
        WHERE sc.library_version = $1
          AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM crosswalk c WHERE c.shared_control_id = sc.id
                                              AND c.library_version = sc.library_version AND c.framework_id = $2))
          AND ($3::text IS NULL OR sc.domain = $3)
          AND ($4::text IS NULL OR sc.id ILIKE $4 OR sc.title ILIKE $4 OR sc.objective ILIKE $4)
        ORDER BY sc.id`,
      [lib, f.framework ?? null, f.domain ?? null, like],
    );
    return rows;
  });

  const ControlParams = z.object({ id: SharedControlId });
  app.get("/controls/:id", viewer, async (req) => {
    const { id } = parse(ControlParams, req.params);
    const lib = await currentLibraryVersion(db);
    const c = await db.query(
      `SELECT id, domain, title, objective, asset_types AS "assetTypes", default_severity AS "defaultSeverity",
              evidence, "references", status, library_version AS "libraryVersion"
         FROM shared_control WHERE id = $1 AND library_version = $2`,
      [id, lib],
    );
    if (!c.rows[0]) throw notFound("Control");
    const qs = await db.query(
      `SELECT id, text, answer_type AS "answerType", compliant_answer AS "compliantAnswer", options, scale, unit,
              guidance, photo_on_deficiency AS "photoOnDeficiency"
         FROM question WHERE shared_control_id = $1 AND library_version = $2 ORDER BY sort_order`,
      [id, lib],
    );
    const maps = await db.query(
      `SELECT c.framework_id AS "frameworkId", fv.short_name AS "frameworkShortName", c.version AS "frameworkVersion",
              c.requirement_code AS "requirementCode", r.title AS "requirementTitle", c.relationship, c.rationale
         FROM crosswalk c
         JOIN framework_version fv ON fv.framework_id = c.framework_id AND fv.version = c.version
         JOIN requirement r ON r.framework_id = c.framework_id AND r.version = c.version AND r.code = c.requirement_code
        WHERE c.shared_control_id = $1 AND c.library_version = $2
        ORDER BY c.framework_id, c.requirement_code`,
      [id, lib],
    );
    return { ...c.rows[0], questions: qs.rows.map(omitNull), mappings: maps.rows };
  });
}
