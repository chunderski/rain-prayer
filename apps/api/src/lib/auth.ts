import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Role, hasRole, type SessionInfo } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Db, Tx } from "../db/pool.js";
import { AppError } from "./errors.js";

export const REFRESH_COOKIE = "sa_refresh";
const ISSUER = "sentinel-assess";
const AUDIENCE = "sentinel-api";

/** argon2id with OWASP-recommended minimums (19 MiB, t=2) exceeded: 64 MiB, t=3, p=1. */
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, ARGON_OPTS);

let dummyHash: Promise<string> | undefined;
/** Verifies a password; with no stored hash, still burns comparable time (no user enumeration by timing). */
export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= argon2.hash("sentinel-timing-equalizer", ARGON_OPTS);
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return argon2.verify(stored, password).catch(() => false);
}

export interface AccessClaims {
  userId: string;
  tenantId: string;
  role: Role;
}

const keyFor = (cfg: Config) => new TextEncoder().encode(cfg.JWT_SECRET);

export async function signAccessToken(cfg: Config, c: AccessClaims): Promise<string> {
  return new SignJWT({ tid: c.tenantId, role: c.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(c.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${cfg.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(keyFor(cfg));
}

export async function verifyAccessToken(cfg: Config, token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, keyFor(cfg), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    const role = Role.safeParse(payload.role);
    if (typeof payload.sub !== "string" || typeof payload.tid !== "string" || !role.success) throw new Error("claims");
    return { userId: payload.sub, tenantId: payload.tid, role: role.data };
  } catch {
    throw new AppError(401, "unauthorized", "Invalid or expired access token");
  }
}

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** A new opaque refresh token (256 bits) and the hash we store. */
export function newRefreshToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

export interface AuthContext extends SessionInfo {
  userId: string;
  tenantId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** Loads the caller's current membership inside the tenant (so revoked access applies immediately). */
export async function loadSession(tx: Tx, userId: string): Promise<SessionInfo | null> {
  const { rows } = await tx.query<{ id: string; email: string; name: string; role: Role; tid: string; slug: string; tname: string }>(
    `SELECT u.id, u.email, u.name, m.role, t.id AS tid, t.slug, t.name AS tname
       FROM membership m
       JOIN app_user u ON u.id = m.user_id
       JOIN tenant t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND u.disabled_at IS NULL`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  return { user: { id: r.id, email: r.email, name: r.name }, tenant: { id: r.tid, slug: r.slug, name: r.tname }, role: r.role };
}

/** Inserts a refresh token row (in the tenant transaction) and returns the opaque token. */
export async function createRefreshToken(
  cfg: Config,
  tx: Tx,
  a: { tenantId: string; userId: string; familyId?: string; ip?: string; userAgent?: string; id?: string; sessionStartedAt?: Date },
): Promise<string> {
  const { token, hash } = newRefreshToken();
  // Expiry is the sliding TTL, capped at the absolute session lifetime from the original sign-in (QA R-5).
  await tx.query(
    `INSERT INTO refresh_token (id, tenant_id, user_id, family_id, token_hash, expires_at, ip, user_agent, session_started_at)
     VALUES ($1, $2, $3, $4, $5,
             LEAST(now() + make_interval(secs => $6), COALESCE($9::timestamptz, now()) + make_interval(secs => $10)),
             $7, $8, COALESCE($9::timestamptz, now()))`,
    [a.id ?? randomUUID(), a.tenantId, a.userId, a.familyId ?? randomUUID(), hash, cfg.REFRESH_TOKEN_TTL_SECONDS, a.ip ?? null,
      a.userAgent?.slice(0, 512) ?? null, a.sessionStartedAt ?? null, cfg.SESSION_ABSOLUTE_TTL_SECONDS],
  );
  return token;
}

export function setRefreshCookie(cfg: Config, reply: FastifyReply, token: string, maxAgeSeconds = cfg.REFRESH_TOKEN_TTL_SECONDS) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: cfg.NODE_ENV !== "development",
    sameSite: "strict",
    path: "/auth",
    maxAge: Math.max(1, Math.min(cfg.REFRESH_TOKEN_TTL_SECONDS, Math.floor(maxAgeSeconds))),
  });
}

export function clearRefreshCookie(cfg: Config, reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: cfg.NODE_ENV !== "development", sameSite: "strict", path: "/auth" });
}

/** preHandler factory: requires a valid access token and at least `min` role in the token's tenant. */
export function requireRole(cfg: Config, db: Db, min: Role) {
  return async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const m = header?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/);
    if (!m?.[1]) throw new AppError(401, "unauthorized", "Missing bearer token");
    const claims = await verifyAccessToken(cfg, m[1]);
    const session = await db.withTenant(claims.tenantId, (tx) => loadSession(tx, claims.userId));
    if (!session) throw new AppError(401, "unauthorized", "Session is no longer valid");
    // Set before the role check so a 403 can be audited against the caller (QA R-6).
    req.auth = { ...session, userId: session.user.id, tenantId: session.tenant.id };
    if (!hasRole(session.role, min)) throw new AppError(403, "forbidden", `Requires role ${min} or higher`);
  };
}

/** Returns req.auth or throws; for use in handlers behind requireRole. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new AppError(401, "unauthorized", "Not authenticated");
  return req.auth;
}
