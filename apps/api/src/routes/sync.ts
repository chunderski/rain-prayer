/**
 * Offline sync. Push: each op in its own savepoint, idempotent on opId (sync_operation), conflicts
 * resolved by the records engine (field-level last writer wins, losing copy in sync_conflict).
 * Pull: change_log after an opaque cursor, current record data or a tombstone per changed record.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SyncPushRequest, Uuid, type SyncEntity, type SyncOpResult } from "@sentinel/shared";
import { assessmentScope } from "../field/context.js";
import { ENTITIES, applyWrite, loadMany, toOutput } from "../field/records.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { AppError, parse } from "../lib/errors.js";
import { inField, type FieldRouteDeps } from "./deps.js";

export const encodeCursor = (seq: number | string) => Buffer.from(`s${seq}`).toString("base64url");
export function decodeCursor(c: string | undefined): string {
  if (!c) return "0";
  const m = /^s(\d{1,18})$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  if (!m) throw new AppError(400, "invalid_cursor", "Unknown sync cursor; pull again without since");
  return m[1]!;
}

function rejection(err: unknown): { result: SyncOpResult & { opId: string }; store: boolean; forbidden: boolean } | null {
  if (!(err instanceof AppError) || err.statusCode >= 500) return null;
  const forbidden = err.statusCode === 403 || err.statusCode === 404;
  const details = err.details as { server?: unknown } | undefined;
  return {
    result: {
      opId: "",
      status: "rejected",
      version: null,
      ...(details && typeof details === "object" && "server" in details && details.server ? { server: details.server } : {}),
      error: forbidden ? { code: "forbidden", message: "You cannot write to this record" } : { code: err.code, message: err.message },
    },
    store: true,
    forbidden,
  };
}

export async function syncRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters, storage } = deps;
  const role = guard(cfg, db, limiters);
  const engine = { storage };

  app.post("/sync/push", { ...role("assessor", limiters.sync), bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const body = parse(SyncPushRequest, req.body);
    const results = await inField(db, req, async (ctx) => {
      const { tx } = ctx;
      const out: SyncOpResult[] = [];
      for (const op of body.ops) {
        await tx.query("SAVEPOINT sync_op");
        const ins = await tx.query(
          `INSERT INTO sync_operation (tenant_id, op_id, user_id, device_id, entity, entity_id, action, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') ON CONFLICT DO NOTHING RETURNING op_id`,
          [ctx.auth.tenantId, op.opId, ctx.auth.userId, body.deviceId, op.entity, op.id, op.action],
        );
        if (!ins.rowCount) {
          const prev = (await tx.query<{ user_id: string; result: SyncOpResult | null }>("SELECT user_id, result FROM sync_operation WHERE op_id = $1", [op.opId])).rows[0];
          await tx.query("RELEASE SAVEPOINT sync_op");
          if (prev && prev.user_id !== ctx.auth.userId) {
            out.push({ opId: op.opId, status: "rejected", version: null, error: { code: "forbidden", message: "This operation id belongs to another user" } });
          } else {
            out.push({ ...(prev?.result ?? { version: null }), opId: op.opId, status: "duplicate" });
          }
          continue;
        }
        const pendingAfterCommit = ctx.afterCommit.length;
        try {
          const w = await applyWrite(ctx, op.entity, {
            action: op.action, id: op.id, data: op.data, baseVersion: op.baseVersion, clientUpdatedAt: op.clientUpdatedAt,
            opId: op.opId, deviceId: body.deviceId,
          }, engine);
          const result: SyncOpResult = { opId: op.opId, status: w.status, version: w.version, ...(w.status === "conflict" ? { server: w.record } : {}) };
          await tx.query("UPDATE sync_operation SET status = $2, result = $3 WHERE tenant_id = $1 AND op_id = $4", [
            ctx.auth.tenantId, w.status, JSON.stringify(result), op.opId,
          ]);
          await tx.query("RELEASE SAVEPOINT sync_op");
          out.push(result);
        } catch (err) {
          await tx.query("ROLLBACK TO SAVEPOINT sync_op");
          ctx.afterCommit.length = pendingAfterCommit;
          ctx.cache.scopes.clear();
          const r = rejection(err);
          if (!r) {
            req.log.error({ err, opId: op.opId }, "sync op failed");
            await tx.query("RELEASE SAVEPOINT sync_op");
            out.push({ opId: op.opId, status: "rejected", version: null, error: { code: "internal_error", message: "The server could not apply this operation; retry later" } });
            continue;
          }
          const result = { ...r.result, opId: op.opId };
          await tx.query(
            `INSERT INTO sync_operation (tenant_id, op_id, user_id, device_id, entity, entity_id, action, status, result)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected', $8)`,
            [ctx.auth.tenantId, op.opId, ctx.auth.userId, body.deviceId, op.entity, op.id, op.action, JSON.stringify(result)],
          );
          if (r.forbidden) {
            await audit(tx, {
              tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "access.denied",
              entityType: op.entity, entityId: op.id, ip: ctx.ip, userAgent: ctx.userAgent,
              details: { route: "POST /sync/push", opId: op.opId, reason: (err as AppError).code },
            });
          }
          await tx.query("RELEASE SAVEPOINT sync_op");
          out.push(result);
        }
      }
      return out;
    });
    return { results };
  });

  const PullQuery = z.object({
    assessmentId: Uuid,
    since: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  });
  app.get("/sync/pull", role("viewer", limiters.sync), async (req) => {
    const q = parse(PullQuery, req.query);
    const since = decodeCursor(q.since);
    return inField(db, req, async (ctx) => {
      const scope = await assessmentScope(ctx, q.assessmentId);
      const { rows } = await ctx.tx.query<{ seq: string; entity: SyncEntity; entity_id: string }>(
        `SELECT seq, entity, entity_id FROM change_log
          WHERE seq > $1::bigint AND (assessment_id = $2 OR (entity = 'area' AND site_id = $3))
          ORDER BY seq LIMIT $4`,
        [since, q.assessmentId, scope.siteId, q.limit + 1],
      );
      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      // One entry per record, at its latest position in this page.
      const last = new Map<string, { entity: SyncEntity; id: string; seq: number }>();
      for (const r of page) {
        const k = `${r.entity}:${r.entity_id}`;
        last.delete(k);
        last.set(k, { entity: r.entity, id: r.entity_id, seq: Number(r.seq) });
      }
      const byEntity = new Map<SyncEntity, string[]>();
      for (const v of last.values()) byEntity.set(v.entity, [...(byEntity.get(v.entity) ?? []), v.id]);
      const loaded = new Map<string, Awaited<ReturnType<typeof loadMany>> extends Map<string, infer L> ? L : never>();
      for (const [entity, ids] of byEntity) {
        for (const [id, l] of await loadMany(ctx, ENTITIES[entity], ids)) loaded.set(`${entity}:${id}`, l);
      }
      const changes = [...last.values()].map((v) => {
        const l = loaded.get(`${v.entity}:${v.id}`);
        const deleted = !l || l.meta.deleted;
        return { entity: v.entity, id: v.id, version: l?.meta.version ?? 0, deleted, data: deleted ? null : toOutput(ENTITIES[v.entity], l!) };
      });
      return { cursor: page.length ? encodeCursor(page.at(-1)!.seq) : encodeCursor(since), changes, hasMore };
    });
  });
}
