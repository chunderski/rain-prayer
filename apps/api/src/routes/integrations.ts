/**
 * Google Drive connection (per tenant) and export jobs.
 *
 * Connect flow: an admin calls GET /integrations/google/connect (with the bearer token, so the PWA uses
 * fetch with `Accept: application/json` and gets `{url}`; other callers get the 302). The API stores a
 * single-use state row bound to that admin, sets an HttpOnly browser-binding cookie, and seals
 * {tenant, nonce, PKCE verifier, binding hash} into the encrypted `state`. The callback accepts only a
 * state that decrypts, matches the cookie, matches an unexpired row for the same admin (deleted on use),
 * and whose admin still holds the admin role.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { CreateExport, Uuid, hasRole, type Role } from "@sentinel/shared";
import type { Config, GoogleExportConfig } from "../config.js";
import { assessmentScope } from "../field/context.js";
import { DRIVE_FILE_SCOPE, type GoogleClient } from "../google/client.js";
import { EXPORT_COLS, exportJobOut, type ExportQueue } from "../google/exports.js";
import { openToken, sealToken } from "../google/tokens.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { authOf } from "../lib/auth.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { TEMPLATE_VERSION } from "../report/model.js";
import { reqMeta } from "./auth.js";
import { inField, type FieldRouteDeps } from "./deps.js";

export const CONNECT_COOKIE = "sa_gconn";
const COOKIE_PATH = "/integrations/google";
const STATE_TTL_SECONDS = 600;
const IdParams = z.object({ id: Uuid });
const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const googleNotConfigured = () =>
  new AppError(503, "google_not_configured", "Google export is not configured on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_KEY)");

export interface IntegrationDeps extends FieldRouteDeps {
  google: GoogleClient | null;
  exportQueue: ExportQueue | null;
}

const StateClaims = z.object({ tid: Uuid, n: z.string().min(20), v: z.string().min(43), b: z.string().regex(/^[0-9a-f]{64}$/) });
const CallbackQuery = z.object({ code: z.string().max(2048).optional(), state: z.string().max(4096).optional(), error: z.string().max(256).optional() });

export async function integrationRoutes(app: FastifyInstance, deps: IntegrationDeps) {
  const { cfg, db, limiters } = deps;
  const role = guard(cfg, db, limiters);
  const configured = (): { g: GoogleExportConfig; client: GoogleClient; queue: ExportQueue } => {
    if (!cfg.googleExport || !deps.google || !deps.exportQueue) throw googleNotConfigured();
    return { g: cfg.googleExport, client: deps.google, queue: deps.exportQueue };
  };
  const stateKey = cfg.googleExport ? createHmac("sha256", cfg.googleExport.tokenKey).update("sentinel-google-connect-state/v1").digest() : null;
  const cookieOpts = { httpOnly: true, secure: cfg.NODE_ENV !== "development", sameSite: "lax" as const, path: COOKIE_PATH };
  const authRateLimit = { rateLimit: { max: cfg.AUTH_RATE_LIMIT_MAX, timeWindow: cfg.AUTH_RATE_LIMIT_WINDOW } };

  app.get("/integrations/google", role("admin"), async (req) => {
    configured();
    const a = authOf(req);
    return db.withTenant(a.tenantId, async (tx) => {
      const { rows } = await tx.query<{ email: string | null; scopes: string[]; connected_at: Date }>("SELECT email, scopes, connected_at FROM google_connection");
      const r = rows[0];
      return r
        ? { connected: true, email: r.email, scopes: r.scopes, connectedAt: r.connected_at.toISOString() }
        : { connected: false, email: null, scopes: [], connectedAt: null };
    });
  });

  app.get("/integrations/google/connect", role("admin"), async (req, reply) => {
    const { client } = configured();
    const a = authOf(req);
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const binding = b64url(randomBytes(32));
    const state = await new EncryptJWT({ tid: a.tenantId, n: nonce, v: verifier, b: sha256(binding) })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime(`${STATE_TTL_SECONDS}s`)
      .encrypt(stateKey!);
    await db.withTenant(a.tenantId, async (tx) => {
      await tx.query("DELETE FROM google_oauth_state WHERE expires_at < now() OR user_id = $1", [a.userId]);
      await tx.query(
        "INSERT INTO google_oauth_state (tenant_id, state_hash, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
        [a.tenantId, sha256(nonce), a.userId, STATE_TTL_SECONDS],
      );
    });
    reply.setCookie(CONNECT_COOKIE, binding, { ...cookieOpts, maxAge: STATE_TTL_SECONDS });
    const url = client.authorizeUrl(state, b64url(createHash("sha256").update(verifier).digest()));
    if (String(req.headers.accept ?? "").includes("application/json")) return { url };
    return reply.redirect(url, 302);
  });

  app.get("/integrations/google/callback", { config: authRateLimit }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { g, client } = configured();
    const done = (outcome: "connected" | "error", reason?: string) => {
      const to = new URL("/settings/integrations", cfg.WEB_ORIGIN);
      to.searchParams.set("google", outcome);
      if (reason) to.searchParams.set("reason", reason);
      return reply.redirect(to.toString(), 302);
    };
    const binding = req.cookies[CONNECT_COOKIE];
    reply.clearCookie(CONNECT_COOKIE, cookieOpts);
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return done("error", "invalid_request");
    if (q.data.error) return done("error", "google_denied");
    if (!q.data.state || !q.data.code || !binding) return done("error", "invalid_state");
    let claims: z.infer<typeof StateClaims>;
    try {
      const { payload } = await jwtDecrypt(q.data.state, stateKey!);
      claims = StateClaims.parse(payload);
    } catch {
      return done("error", "invalid_state");
    }
    if (!safeEqual(claims.b, sha256(binding))) return done("error", "invalid_state");

    const meta = reqMeta(req);
    const userId = await db.withTenant(claims.tid, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; role: Role }>(
        `DELETE FROM google_oauth_state s USING membership m
          WHERE s.state_hash = $1 AND s.expires_at > now() AND m.user_id = s.user_id
          RETURNING s.user_id, m.role`,
        [sha256(claims.n)],
      );
      const r = rows[0];
      return r && hasRole(r.role, "admin") ? r.user_id : null;
    });
    if (!userId) return done("error", "invalid_state");

    let tokens;
    let email: string | null = null;
    try {
      tokens = await client.exchangeCode(q.data.code, claims.v);
      if (!tokens.scopes.includes(DRIVE_FILE_SCOPE)) return done("error", "scope_denied");
      if (!tokens.refreshToken) return done("error", "no_refresh_token");
      email = await client.api(tokens.accessToken).aboutEmail().catch(() => null);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "google connect: token exchange failed");
      return done("error", "google_failed");
    }
    const sealed = sealToken(g.tokenKey, claims.tid, tokens.refreshToken);
    const scopes = tokens.scopes.filter((s) => s === DRIVE_FILE_SCOPE);
    await db.withTenant(claims.tid, async (tx) => {
      await tx.query(
        `INSERT INTO google_connection (tenant_id, refresh_token, iv, tag, email, scopes, connected_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id) DO UPDATE SET refresh_token = EXCLUDED.refresh_token, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
           email = EXCLUDED.email, scopes = EXCLUDED.scopes, connected_by = EXCLUDED.connected_by, connected_at = now()`,
        [claims.tid, sealed.ciphertext, sealed.iv, sealed.tag, email, scopes, userId],
      );
      // Folder ids belong to the previous account's Drive.
      await tx.query("DELETE FROM google_folder");
      await audit(tx, { tenantId: claims.tid, actorUserId: userId, action: "google.connect", entityType: "google_connection", entityId: claims.tid, ...meta, details: { email, scopes } });
    });
    return done("connected");
  });

  app.delete("/integrations/google", role("admin"), async (req, reply) => {
    const { g, client } = configured();
    const a = authOf(req);
    const row = await db.withTenant(a.tenantId, async (tx) =>
      (await tx.query<{ refresh_token: Buffer; iv: Buffer; tag: Buffer }>("SELECT refresh_token, iv, tag FROM google_connection")).rows[0],
    );
    let revoked = false;
    if (row) {
      try {
        await client.revoke(openToken(g.tokenKey, a.tenantId, { ciphertext: row.refresh_token, iv: row.iv, tag: row.tag }));
        revoked = true;
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "google disconnect: revoke failed; deleting the stored token anyway");
      }
    }
    await db.withTenant(a.tenantId, async (tx) => {
      await tx.query("DELETE FROM google_connection");
      await tx.query("DELETE FROM google_folder");
      if (row) {
        await audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "google.disconnect", entityType: "google_connection", entityId: a.tenantId, ...reqMeta(req), details: { revoked } });
      }
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- exports

  app.post("/assessments/:id/exports", role("assessor", limiters.exports), async (req, reply) => {
    const { queue } = configured();
    const { id } = parse(IdParams, req.params);
    const body = parse(CreateExport, req.body);
    const targets = [...new Set(body.targets)].sort();
    const job = await inField(db, req, async (ctx) => {
      await assessmentScope(ctx, id);
      const c = await ctx.tx.query("SELECT 1 FROM google_connection");
      if (!c.rowCount) throw new AppError(409, "google_not_connected", "Connect Google in settings before exporting");
      const { rows } = await ctx.tx.query(
        `INSERT INTO export_job (tenant_id, assessment_id, targets, results, template_version, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${EXPORT_COLS}`,
        [ctx.auth.tenantId, id, targets, JSON.stringify(targets.map((t) => ({ target: t, status: "pending", url: null, error: null }))), TEMPLATE_VERSION, ctx.auth.userId],
      );
      await audit(ctx.tx, {
        tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "export.create", entityType: "export_job",
        entityId: rows[0].id, ip: ctx.ip, userAgent: ctx.userAgent, details: { assessmentId: id, targets, templateVersion: TEMPLATE_VERSION },
      });
      return rows[0];
    });
    await queue.add(authOf(req).tenantId, job.id);
    return reply.code(202).send(exportJobOut(job));
  });

  app.get("/exports/:id", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const { rows } = await tx.query(`SELECT ${EXPORT_COLS} FROM export_job WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound("Export");
      return exportJobOut(rows[0]);
    });
  });

  app.get("/assessments/:id/exports", role("viewer"), async (req) => {
    const { id } = parse(IdParams, req.params);
    return inField(db, req, async (ctx) => {
      await assessmentScope(ctx, id);
      const { rows } = await ctx.tx.query(`SELECT ${EXPORT_COLS} FROM export_job WHERE assessment_id = $1 ORDER BY created_at DESC, id LIMIT 50`, [id]);
      return rows.map(exportJobOut);
    });
  });
}

export type { Config };
