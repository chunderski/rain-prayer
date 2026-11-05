import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LoginRequest, type Role, type SessionInfo } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import {
  REFRESH_COOKIE,
  authOf,
  clearRefreshCookie,
  createRefreshToken,
  loadSession,
  requireRole,
  setRefreshCookie,
  sha256,
  signAccessToken,
  verifyPassword,
} from "../lib/auth.js";
import { AppError, parse } from "../lib/errors.js";

export interface Membership {
  tenantId: string;
  slug: string;
  name: string;
  role: Role;
}

export interface UserRecord {
  user_id: string;
  email: string;
  name: string;
  password_hash: string | null;
  google_sub: string | null;
  locked_until: Date | null;
  memberships: Membership[];
}

export async function findUser(db: Db, email: string): Promise<UserRecord | null> {
  const { rows } = await db.query<UserRecord>("SELECT * FROM auth_find_user($1)", [email]);
  return rows[0] ?? null;
}

export const reqMeta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

/** Unscoped (tenant-less) auth audit event via the SECURITY DEFINER function. */
export async function logUnscoped(db: Db, req: FastifyRequest, action: string, userId: string | null, email: string, details: object = {}) {
  const m = reqMeta(req);
  await db.query("SELECT auth_log_unscoped_event($1, $2, $3, $4, $5, $6)", [action, userId, email, m.ip, m.userAgent ?? null, JSON.stringify(details)]);
}

/** Picks the tenant for a sign-in, or throws tenant_required / no_tenant_access. */
export function resolveTenant(memberships: Membership[], slug?: string): Membership {
  if (slug) {
    const m = memberships.find((x) => x.slug === slug);
    if (!m) throw new AppError(403, "no_tenant_access", "You do not have access to that workspace");
    return m;
  }
  if (memberships.length === 0) throw new AppError(403, "no_tenant_access", "No workspace found; ask your administrator for an invite");
  if (memberships.length > 1) {
    throw new AppError(409, "tenant_required", "Choose a workspace", { tenants: memberships.map((m) => ({ slug: m.slug, name: m.name })) });
  }
  return memberships[0]!;
}

/** Creates a session (refresh token row, audit entry) and returns tokens. */
export async function startSession(
  cfg: Config,
  db: Db,
  req: FastifyRequest,
  userId: string,
  tenantId: string,
  method: "password" | "google",
): Promise<{ accessToken: string; refreshToken: string; session: SessionInfo }> {
  const m = reqMeta(req);
  return db.withTenant(tenantId, async (tx) => {
    const session = await loadSession(tx, userId);
    if (!session) throw new AppError(403, "no_tenant_access", "You do not have access to that workspace");
    const refreshToken = await createRefreshToken(cfg, tx, { tenantId, userId, ...m });
    await audit(tx, {
      tenantId, actorUserId: userId, actorEmail: session.user.email, action: "auth.login.success",
      entityType: "user", entityId: userId, ...m, details: { method },
    });
    const accessToken = await signAccessToken(cfg, { userId, tenantId, role: session.role });
    return { accessToken, refreshToken, session };
  });
}

/** Rejects cookie-authenticated requests from a foreign Origin (defense in depth beyond SameSite). */
function checkOrigin(cfg: Config, req: FastifyRequest) {
  const origin = req.headers.origin;
  if (origin && origin !== cfg.WEB_ORIGIN && !cfg.embedOrigins.includes(origin)) throw new AppError(403, "forbidden_origin", "Origin not allowed");
}

export async function authRoutes(app: FastifyInstance, { cfg, db }: { cfg: Config; db: Db }) {
  const strict = { rateLimit: { max: cfg.AUTH_RATE_LIMIT_MAX, timeWindow: cfg.AUTH_RATE_LIMIT_WINDOW } };
  const relaxed = { rateLimit: { max: cfg.AUTH_RATE_LIMIT_MAX * 6, timeWindow: cfg.AUTH_RATE_LIMIT_WINDOW } };

  app.post("/auth/login", { config: strict }, async (req, reply) => {
    const body = parse(LoginRequest, req.body);
    const email = body.email.toLowerCase();
    const user = await findUser(db, email);
    const invalid = new AppError(401, "invalid_credentials", "Email or password is incorrect");

    if (!user) {
      await verifyPassword(null, body.password);
      await logUnscoped(db, req, "auth.login.failure", null, email, { reason: "unknown_user" });
      throw invalid;
    }
    // Audit failures in the tenant when it is unambiguous, otherwise unscoped.
    const failTenant =
      (body.tenantSlug && user.memberships.find((m) => m.slug === body.tenantSlug)) ||
      (user.memberships.length === 1 ? user.memberships[0] : undefined);
    const logFailure = async (reason: string) => {
      if (failTenant) {
        await db.withTenant(failTenant.tenantId, (tx) =>
          audit(tx, { tenantId: failTenant.tenantId, actorUserId: user.user_id, actorEmail: user.email, action: "auth.login.failure", entityType: "user", entityId: user.user_id, ...reqMeta(req), details: { reason } }),
        );
      } else {
        await logUnscoped(db, req, "auth.login.failure", user.user_id, email, { reason });
      }
    };

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await logFailure("locked");
      await verifyPassword(null, body.password); // equalize timing with the unknown-user path (QA R-2)
      throw new AppError(429, "account_locked", "Too many failed sign-in attempts. Try again later.");
    }
    if (!(await verifyPassword(user.password_hash, body.password))) {
      const { rows } = await db.query<{ locked: Date | null }>("SELECT auth_register_login_failure($1, $2, $3) AS locked", [
        user.user_id, cfg.LOGIN_MAX_FAILURES, cfg.LOGIN_LOCKOUT_SECONDS,
      ]);
      await logFailure(rows[0]?.locked ? "bad_password_locked" : "bad_password");
      throw invalid;
    }
    await db.query("SELECT auth_register_login_success($1)", [user.user_id]);
    const tenant = resolveTenant(user.memberships, body.tenantSlug);
    const { accessToken, refreshToken, session } = await startSession(cfg, db, req, user.user_id, tenant.tenantId, "password");
    setRefreshCookie(cfg, reply, refreshToken);
    return { accessToken, session };
  });

  app.post("/auth/refresh", { config: relaxed }, async (req, reply) => {
    checkOrigin(cfg, req);
    const presented = req.cookies[REFRESH_COOKIE];
    const reject = (msg = "Sign in again") => {
      clearRefreshCookie(cfg, reply);
      return new AppError(401, "invalid_refresh_token", msg);
    };
    if (!presented) throw reject("No refresh token");
    const { rows } = await db.query<{ id: string; tenant_id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null }>(
      "SELECT * FROM auth_find_refresh_token($1)", [sha256(presented)],
    );
    const row = rows[0];
    if (!row) {
      await logUnscoped(db, req, "auth.refresh.failure", null, "", { reason: "unknown_token" }); // QA R-6
      throw reject();
    }
    const m = reqMeta(req);
    const failure = (reason: string) =>
      db.withTenant(row.tenant_id, (tx) =>
        audit(tx, { tenantId: row.tenant_id, actorUserId: row.user_id, action: "auth.refresh.failure", entityType: "user", entityId: row.user_id, ...m, details: { reason } }),
      );

    const revokeFamily = (reason: string) =>
      db.withTenant(row.tenant_id, async (tx) => {
        await tx.query("UPDATE refresh_token SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
        await audit(tx, { tenantId: row.tenant_id, actorUserId: row.user_id, action: "auth.refresh.reuse_detected", entityType: "user", entityId: row.user_id, ...m, details: { reason } });
      });

    if (row.revoked_at) {
      // A rotated token was presented again: assume theft and end the whole session family.
      await revokeFamily("revoked_token_reused");
      throw reject();
    }
    if (new Date(row.expires_at) <= new Date()) {
      await failure("expired");
      throw reject("Session expired");
    }

    const newId = randomUUID();
    const result = await db.withTenant(row.tenant_id, async (tx) => {
      // Absolute session cap (QA R-5): no rotation past SESSION_ABSOLUTE_TTL_SECONDS after the original sign-in.
      const started = (await tx.query<{ s: Date; capped: boolean }>(
        "SELECT session_started_at AS s, session_started_at + make_interval(secs => $2) <= now() AS capped FROM refresh_token WHERE id = $1",
        [row.id, cfg.SESSION_ABSOLUTE_TTL_SECONDS],
      )).rows[0];
      if (!started || started.capped) return "capped" as const;
      const upd = await tx.query("UPDATE refresh_token SET revoked_at = now(), replaced_by = $2 WHERE id = $1 AND revoked_at IS NULL", [row.id, newId]);
      if (upd.rowCount !== 1) return null; // lost a race with another use of the same token
      const session = await loadSession(tx, row.user_id);
      if (!session) return null;
      const refreshToken = await createRefreshToken(cfg, tx, {
        id: newId, tenantId: row.tenant_id, userId: row.user_id, familyId: row.family_id, sessionStartedAt: started.s, ...m,
      });
      const accessToken = await signAccessToken(cfg, { userId: row.user_id, tenantId: row.tenant_id, role: session.role });
      const remaining = (started.s.getTime() + cfg.SESSION_ABSOLUTE_TTL_SECONDS * 1000 - Date.now()) / 1000;
      return { accessToken, refreshToken, session, remaining };
    });
    if (result === "capped") {
      await db.withTenant(row.tenant_id, async (tx) => {
        await tx.query("UPDATE refresh_token SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
        await audit(tx, { tenantId: row.tenant_id, actorUserId: row.user_id, action: "auth.session.expired", entityType: "user", entityId: row.user_id, ...m, details: { reason: "absolute_cap" } });
      });
      throw reject("Session expired; sign in again");
    }
    if (!result) {
      await revokeFamily("concurrent_use");
      throw reject();
    }
    setRefreshCookie(cfg, reply, result.refreshToken, result.remaining);
    return { accessToken: result.accessToken, session: result.session };
  });

  app.post("/auth/logout", { config: relaxed }, async (req, reply) => {
    checkOrigin(cfg, req);
    const presented = req.cookies[REFRESH_COOKIE];
    if (presented) {
      const { rows } = await db.query<{ tenant_id: string; user_id: string; family_id: string }>("SELECT * FROM auth_find_refresh_token($1)", [sha256(presented)]);
      const row = rows[0];
      if (row) {
        await db.withTenant(row.tenant_id, async (tx) => {
          await tx.query("UPDATE refresh_token SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
          const s = await loadSession(tx, row.user_id);
          await audit(tx, { tenantId: row.tenant_id, actorUserId: row.user_id, actorEmail: s?.user.email ?? null, action: "auth.logout", entityType: "user", entityId: row.user_id, ...reqMeta(req) });
        });
      }
    }
    clearRefreshCookie(cfg, reply);
    return reply.code(204).send();
  });

  app.get("/auth/me", { config: relaxed, preHandler: requireRole(cfg, db, "viewer") }, async (req) => {
    const { user, tenant, role } = authOf(req);
    return { user, tenant, role } satisfies SessionInfo;
  });
}
