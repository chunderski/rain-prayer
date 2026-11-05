/** Tenant-scoped CRUD. Every query runs inside db.withTenant, so RLS scopes it to the caller's tenant. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateAssessment, CreateClient, CreateSite, Uuid } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Db, Tx } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { guard, type Limiters } from "../lib/access.js";
import { authOf } from "../lib/auth.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { reqMeta } from "./auth.js";
import { currentLibraryVersion } from "./library.js";

const IdParams = z.object({ id: Uuid });

const CLIENT_COLS = `id, name, industry, notes, created_at AS "createdAt"`;
const SITE_COLS = `id, client_id AS "clientId", name, address, site_type AS "siteType", created_at AS "createdAt"`;

export async function assessmentDetail(tx: Tx, id: string) {
  const { rows } = await tx.query(
    `SELECT a.id, a.title, a.status, a.site_id AS "siteId", s.name AS "siteName", s.client_id AS "clientId",
            c.name AS "clientName", a.scheduled_for AS "scheduledFor", a.library_version AS "libraryVersion",
            a.created_at AS "createdAt",
            COALESCE((SELECT jsonb_agg(jsonb_build_object('frameworkId', af.framework_id, 'version', af.version,
                                                          'shortName', fv.short_name, 'name', fv.name) ORDER BY fv.short_name)
                        FROM assessment_framework af
                        JOIN framework_version fv ON fv.framework_id = af.framework_id AND fv.version = af.version
                       WHERE af.assessment_id = a.id), '[]') AS frameworks,
            (SELECT count(DISTINCT cw.shared_control_id)::int
               FROM assessment_framework af
               JOIN crosswalk cw ON cw.framework_id = af.framework_id AND cw.version = af.version AND cw.library_version = a.library_version
              WHERE af.assessment_id = a.id) AS "controlCount",
            (SELECT count(*)::int FROM question q
              WHERE q.library_version = a.library_version
                AND q.shared_control_id IN (
                  SELECT cw.shared_control_id FROM assessment_framework af
                    JOIN crosswalk cw ON cw.framework_id = af.framework_id AND cw.version = af.version AND cw.library_version = a.library_version
                   WHERE af.assessment_id = a.id)) AS "questionCount"
       FROM assessment a
       JOIN site s ON s.id = a.site_id
       JOIN client c ON c.id = s.client_id
      WHERE a.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function tenantRoutes(app: FastifyInstance, { cfg, db, limiters }: { cfg: Config; db: Db; limiters: Limiters }) {
  const role = guard(cfg, db, limiters);

  // Clients
  app.get("/clients", role("viewer"), async (req) =>
    db.withTenant(authOf(req).tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.name, c.industry, (SELECT count(*)::int FROM site s WHERE s.client_id = c.id) AS "siteCount",
                c.created_at AS "createdAt"
           FROM client c ORDER BY lower(c.name), c.id`,
      );
      return rows;
    }),
  );

  app.post("/clients", role("admin"), async (req, reply) => {
    const a = authOf(req);
    const body = parse(CreateClient, req.body);
    const client = await db.withTenant(a.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO client (tenant_id, name, industry, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${CLIENT_COLS}`,
        [a.tenantId, body.name, body.industry || null, body.notes || null, a.userId],
      );
      const row = rows[0];
      await audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "client.create", entityType: "client", entityId: row.id, ...reqMeta(req) });
      return row;
    });
    return reply.code(201).send(client);
  });

  app.get("/clients/:id", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const c = await tx.query(`SELECT ${CLIENT_COLS} FROM client WHERE id = $1`, [id]);
      if (!c.rows[0]) throw notFound("Client");
      const s = await tx.query(`SELECT ${SITE_COLS} FROM site WHERE client_id = $1 ORDER BY lower(name), id`, [id]);
      return { ...c.rows[0], sites: s.rows };
    });
  });

  // Sites
  const SitesQuery = z.object({ clientId: Uuid.optional() });
  app.get("/sites", role("viewer"), async (req) => {
    const q = parse(SitesQuery, req.query);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${SITE_COLS} FROM site WHERE ($1::uuid IS NULL OR client_id = $1) ORDER BY lower(name), id`,
        [q.clientId ?? null],
      );
      return rows;
    });
  });

  app.post("/sites", role("admin"), async (req, reply) => {
    const a = authOf(req);
    const body = parse(CreateSite, req.body);
    const site = await db.withTenant(a.tenantId, async (tx) => {
      const parent = await tx.query("SELECT 1 FROM client WHERE id = $1", [body.clientId]);
      if (!parent.rowCount) throw notFound("Client");
      const { rows } = await tx.query(
        `INSERT INTO site (tenant_id, client_id, name, address, site_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SITE_COLS}`,
        [a.tenantId, body.clientId, body.name, body.address || null, body.siteType || null, a.userId],
      );
      const row = rows[0];
      await audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "site.create", entityType: "site", entityId: row.id, ...reqMeta(req), details: { clientId: body.clientId } });
      return row;
    });
    return reply.code(201).send(site);
  });

  // Assessments
  app.get("/assessments", role("viewer"), async (req) =>
    db.withTenant(authOf(req).tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT a.id, a.title, a.status, a.site_id AS "siteId", s.name AS "siteName", c.name AS "clientName",
                COALESCE((SELECT jsonb_agg(jsonb_build_object('frameworkId', af.framework_id, 'version', af.version,
                                                              'shortName', fv.short_name) ORDER BY fv.short_name)
                            FROM assessment_framework af
                            JOIN framework_version fv ON fv.framework_id = af.framework_id AND fv.version = af.version
                           WHERE af.assessment_id = a.id), '[]') AS frameworks,
                a.created_at AS "createdAt"
           FROM assessment a JOIN site s ON s.id = a.site_id JOIN client c ON c.id = s.client_id
          ORDER BY a.created_at DESC, a.id`,
      );
      return rows;
    }),
  );

  app.post("/assessments", role("assessor"), async (req, reply) => {
    const a = authOf(req);
    const body = parse(CreateAssessment, req.body);
    const ids = body.frameworks.map((f) => f.frameworkId);
    if (new Set(ids).size !== ids.length) {
      throw new AppError(400, "validation_error", "Request validation failed", [{ path: "frameworks", message: "Each framework may be selected once" }]);
    }
    // Pin the exact framework versions requested; reject any that are not in the library.
    const known = await db.query<{ framework_id: string; version: string }>(
      `SELECT framework_id, version FROM framework_version
        WHERE (framework_id, version) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [ids, body.frameworks.map((f) => f.version)],
    );
    const knownSet = new Set(known.rows.map((r) => `${r.framework_id}@${r.version}`));
    const unknown = body.frameworks.filter((f) => !knownSet.has(`${f.frameworkId}@${f.version}`));
    if (unknown.length) {
      throw new AppError(400, "unknown_framework_version", "One or more framework versions are not in the library", { frameworks: unknown });
    }
    const libraryVersion = await currentLibraryVersion(db);

    const detail = await db.withTenant(a.tenantId, async (tx) => {
      const site = await tx.query("SELECT 1 FROM site WHERE id = $1", [body.siteId]);
      if (!site.rowCount) throw notFound("Site");
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO assessment (tenant_id, site_id, title, scheduled_for, library_version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [a.tenantId, body.siteId, body.title, body.scheduledFor ?? null, libraryVersion, a.userId],
      );
      const id = rows[0]!.id;
      await tx.query(
        `INSERT INTO assessment_framework (tenant_id, assessment_id, framework_id, version)
         SELECT $1, $2, f, v FROM unnest($3::text[], $4::text[]) AS t(f, v)`,
        [a.tenantId, id, ids, body.frameworks.map((f) => f.version)],
      );
      // The creator is assigned, so an assessor can capture field data on what they created.
      await tx.query("INSERT INTO assessment_assessor (tenant_id, assessment_id, user_id, created_by) VALUES ($1, $2, $3, $3)", [a.tenantId, id, a.userId]);
      await audit(tx, {
        tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "assessment.create",
        entityType: "assessment", entityId: id, ...reqMeta(req), details: { siteId: body.siteId, frameworks: body.frameworks, libraryVersion },
      });
      return assessmentDetail(tx, id);
    });
    return reply.code(201).send(detail);
  });

  app.get("/assessments/:id", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const detail = await db.withTenant(authOf(req).tenantId, (tx) => assessmentDetail(tx, id));
    if (!detail) throw notFound("Assessment");
    return detail;
  });

  // Audit log
  const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
  app.get("/audit", role("admin"), async (req) => {
    const { limit } = parse(AuditQuery, req.query);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, at, actor_email AS "actorEmail", action, entity_type AS "entityType", entity_id AS "entityId", ip
           FROM audit_log ORDER BY at DESC, id LIMIT $1`,
        [limit],
      );
      return rows;
    });
  });
}
