/**
 * Photo routes: metadata (create, tag, delete), content upload through the sanitizing pipeline,
 * signed URLs, and the local-driver file endpoint.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PhotoContentType, PhotoMeta, Uuid } from "@sentinel/shared";
import { requireAssessmentWrite } from "../field/context.js";
import { ENTITIES, applyWrite, loadRecord, toOutput } from "../field/records.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { createUserLimiter } from "../lib/ratelimit.js";
import { MAX_PHOTO_BYTES, processPhoto } from "../photos/process.js";
import { photoKeys } from "../storage/index.js";
import { inField, type FieldRouteDeps } from "./deps.js";

const IdParams = z.object({ id: Uuid });
const GPS_HEADER = "x-sentinel-gps";

export async function photoRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters, storage } = deps;
  const role = guard(cfg, db, limiters);
  const engine = { storage };
  const now = () => new Date().toISOString();

  app.post("/assessments/:id/photos", role("assessor"), async (req, reply) => {
    const { id: assessmentId } = parse(IdParams, req.params);
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.assessmentId !== undefined && body.assessmentId !== assessmentId) {
      throw new AppError(400, "validation_error", "Request validation failed", [{ path: "assessmentId", message: "must match the URL" }]);
    }
    const meta = parse(PhotoMeta, { ...(body ?? {}), assessmentId });
    const r = await inField(db, req, async (ctx) => {
      const existing = await loadRecord(ctx, ENTITIES.photo_meta, meta.id);
      if (existing) {
        // Idempotent on id: a replayed create returns the stored record unchanged.
        if (existing.data.assessmentId !== assessmentId || existing.meta.deleted) throw new AppError(409, "id_conflict", "A photo with this id already exists");
        await requireAssessmentWrite(ctx, assessmentId);
        return { record: toOutput(ENTITIES.photo_meta, existing), gpsDropped: false };
      }
      const w = await applyWrite(ctx, "photo_meta", { action: "upsert", id: meta.id, data: meta, baseVersion: undefined, clientUpdatedAt: now() }, engine);
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "photo.create",
        entityType: "photo", entityId: meta.id, ip: ctx.ip, userAgent: ctx.userAgent, details: { assessmentId, gpsDropped: w.gpsDropped },
      });
      return w;
    });
    if (r.gpsDropped) reply.header(GPS_HEADER, "dropped");
    return reply.code(201).send(r.record);
  });

  // Raw image body, parsed only inside this encapsulated context.
  await app.register(async (upload) => {
    upload.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_PHOTO_BYTES }, (_req, body, done) => done(null, body));
    upload.put("/photos/:id/content", { ...role("assessor"), bodyLimit: MAX_PHOTO_BYTES }, async (req) => {
      const { id } = parse(IdParams, req.params);
      const declared = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (!PhotoContentType.safeParse(declared).success || !Buffer.isBuffer(req.body)) {
        throw new AppError(415, "unsupported_media", "Content-Type must be image/jpeg, image/png, image/webp, or image/heic");
      }
      const tenantId = req.auth!.tenantId;
      await inField(db, req, async (ctx) => {
        const p = await loadRecord(ctx, ENTITIES.photo_meta, id);
        if (!p || p.meta.deleted) throw notFound("Photo");
        await requireAssessmentWrite(ctx, p.data.assessmentId as string);
      });
      // CPU and storage work happen outside the database transaction.
      const out = await processPhoto(req.body);
      const keys = photoKeys(tenantId, id);
      await storage.put(keys.full, out.full, "image/jpeg");
      await storage.put(keys.thumb, out.thumb, "image/jpeg");
      return inField(db, req, async (ctx) => {
        const p = await loadRecord(ctx, ENTITIES.photo_meta, id, true);
        if (!p || p.meta.deleted) {
          ctx.afterCommit.push(async () => {
            await storage.delete(keys.full);
            await storage.delete(keys.thumb);
          });
          throw notFound("Photo");
        }
        await ctx.tx.query(
          `UPDATE photo SET status = 'stored', sha256 = $2, width = $3, height = $4, storage_key = $5, thumb_key = $6,
                            stored_bytes = $7, updated_by = $8 WHERE id = $1`,
          [id, out.sha256, out.width, out.height, keys.full, keys.thumb, out.full.length, ctx.auth.userId],
        );
        await audit(ctx.tx, {
          tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "photo.upload",
          entityType: "photo", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent,
          details: { detectedType: out.detectedType, declaredType: declared, sha256: out.sha256, width: out.width, height: out.height },
        });
        return toOutput(ENTITIES.photo_meta, (await loadRecord(ctx, ENTITIES.photo_meta, id))!);
      });
    });
  });

  const UrlQuery = z.object({ variant: z.enum(["full", "thumb"]).default("full") });
  app.get("/photos/:id/url", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    const { variant } = parse(UrlQuery, req.query);
    const key = await inField(db, req, async (ctx) => {
      const { rows } = await ctx.tx.query<{ status: string; storage_key: string | null; thumb_key: string | null }>(
        "SELECT status, storage_key, thumb_key FROM photo WHERE id = $1 AND deleted_at IS NULL", [id],
      );
      const r = rows[0];
      if (!r) throw notFound("Photo");
      const k = variant === "thumb" ? r.thumb_key : r.storage_key;
      if (r.status !== "stored" || !k) throw new AppError(409, "photo_not_uploaded", "The photo content has not been uploaded yet");
      return k;
    });
    return storage.signedUrl(key, cfg.SIGNED_URL_TTL_SECONDS);
  });

  const PatchPhoto = PhotoMeta.pick({ areaId: true, assetId: true, findingId: true, controlIds: true, assetType: true, severity: true, notes: true })
    .partial()
    .strict();
  app.patch("/photos/:id", role("assessor"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    parse(PatchPhoto, req.body ?? {});
    const given = (req.body ?? {}) as Record<string, unknown>;
    const r = await inField(db, req, async (ctx) => {
      const p = await loadRecord(ctx, ENTITIES.photo_meta, id);
      if (!p || p.meta.deleted) throw notFound("Photo");
      return applyWrite(ctx, "photo_meta", { action: "upsert", id, data: given, partial: true, clientUpdatedAt: now() }, engine);
    });
    return reply.send(r.record);
  });

  app.delete("/photos/:id", role("assessor"), async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    await inField(db, req, async (ctx) => {
      const p = await loadRecord(ctx, ENTITIES.photo_meta, id);
      if (!p || p.meta.deleted) throw notFound("Photo");
      await applyWrite(ctx, "photo_meta", { action: "delete", id, clientUpdatedAt: now() }, engine);
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "photo.delete",
        entityType: "photo", entityId: id, ip: ctx.ip, userAgent: ctx.userAgent,
      });
    });
    return reply.code(204).send();
  });

  // Local driver only: the token is the whole grant (one object, until it expires).
  const local = storage as { readByToken?: (t: string) => Promise<Buffer | null> };
  if (storage.driver === "local" && local.readByToken) {
    const fileLimiter = createUserLimiter("file", cfg.DATA_RATE_LIMIT_MAX * 2, cfg.DATA_RATE_LIMIT_WINDOW_SECONDS * 1000);
    app.get("/files/:token", { preHandler: fileLimiter }, async (req, reply) => {
      const { token } = req.params as { token: string };
      const body = typeof token === "string" && token.length <= 700 ? await local.readByToken!(token) : null;
      if (!body) throw new AppError(404, "not_found", "File not found or link expired");
      return reply
        .header("content-type", "image/jpeg")
        .header("content-disposition", "inline")
        .header("cross-origin-resource-policy", "cross-origin")
        .send(body);
    });
  }
}
