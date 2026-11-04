/**
 * Google OIDC sign-in (authorization code flow with PKCE, state, and nonce).
 * Active only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET hold real values.
 * Users must already exist (matched by verified email); there is no auto-provisioning.
 *
 * Browser flow: the PWA navigates to /auth/google/start[?tenant=<slug>]; Google redirects to
 * /auth/google/callback; on success the API sets the sa_refresh cookie and redirects to
 * WEB_ORIGIN/?signin=google, where the PWA calls POST /auth/refresh to get an access token.
 * On failure it redirects to WEB_ORIGIN/login?error=<code>.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { EncryptJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Config, GoogleConfig } from "../config.js";
import type { Db } from "../db/pool.js";
import { setRefreshCookie } from "../lib/auth.js";
import { AppError, parse } from "../lib/errors.js";
import { findUser, logUnscoped, resolveTenant, startSession } from "./auth.js";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const OIDC_COOKIE = "sa_oidc";
const OIDC_COOKIE_PATH = "/auth/google";
const STATE_TTL_SECONDS = 600;

export interface GoogleDeps {
  fetch?: typeof fetch;
  googleJwks?: JWTVerifyGetKey;
}

const b64url = (b: Buffer) => b.toString("base64url");
const StartQuery = z.object({ tenant: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional() });
const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});
const StateCookie = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), tenant: z.string().optional() });

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function googleRoutes(app: FastifyInstance, { cfg, db, deps }: { cfg: Config; db: Db; deps: GoogleDeps }) {
  const rateLimit = { rateLimit: { max: cfg.AUTH_RATE_LIMIT_MAX, timeWindow: cfg.AUTH_RATE_LIMIT_WINDOW } };
  // Key for the encrypted state cookie, derived from JWT_SECRET with a distinct label.
  const cookieKey = createHash("sha256").update(`sentinel-oidc-state:${cfg.JWT_SECRET}`).digest();
  const doFetch = deps.fetch ?? fetch;
  let jwks = deps.googleJwks;
  const cookieOpts = { httpOnly: true, secure: cfg.NODE_ENV !== "development", sameSite: "lax" as const, path: OIDC_COOKIE_PATH };

  const requireGoogle = (): GoogleConfig => {
    if (!cfg.google) throw new AppError(404, "google_not_configured", "Google sign-in is not configured on this server");
    return cfg.google;
  };

  app.get("/auth/google/start", { config: rateLimit }, async (req, reply) => {
    const g = requireGoogle();
    const { tenant } = parse(StartQuery, req.query);
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const sealed = await new EncryptJWT({ state, nonce, verifier, ...(tenant ? { tenant } : {}) })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime(`${STATE_TTL_SECONDS}s`)
      .encrypt(cookieKey);
    reply.setCookie(OIDC_COOKIE, sealed, { ...cookieOpts, maxAge: STATE_TTL_SECONDS });
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: g.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return reply.redirect(url.toString(), 302);
  });

  app.get("/auth/google/callback", { config: rateLimit }, async (req, reply) => {
    const g = requireGoogle();
    const fail = (code: string) => {
      const to = new URL("/login", cfg.WEB_ORIGIN);
      to.searchParams.set("error", code);
      return reply.redirect(to.toString(), 302);
    };
    const sealed = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, cookieOpts);

    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return fail("invalid_request");
    if (q.data.error) return fail("google_denied");
    if (!sealed || !q.data.state || !q.data.code) return fail("invalid_state");
    let saved: z.infer<typeof StateCookie>;
    try {
      const { payload } = await jwtDecrypt(sealed, cookieKey);
      saved = StateCookie.parse(payload);
    } catch {
      return fail("invalid_state");
    }
    if (!safeEqual(saved.state, q.data.state)) return fail("invalid_state");

    // Exchange the code (with the PKCE verifier) and verify the ID token against Google's JWKS.
    let claims: { sub: string; email: string; nonce?: unknown; email_verified?: unknown };
    try {
      const res = await doFetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          code: q.data.code,
          client_id: g.clientId,
          client_secret: g.clientSecret,
          redirect_uri: g.redirectUri,
          grant_type: "authorization_code",
          code_verifier: saved.verifier,
        }),
      });
      if (!res.ok) throw new Error(`token endpoint ${res.status}`);
      const body = (await res.json()) as { id_token?: unknown };
      if (typeof body.id_token !== "string") throw new Error("no id_token");
      jwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
      const { payload } = await jwtVerify(body.id_token, jwks, { issuer: GOOGLE_ISSUERS, audience: g.clientId, algorithms: ["RS256"] });
      if (typeof payload.sub !== "string" || typeof payload.email !== "string") throw new Error("missing claims");
      claims = payload as typeof claims;
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "google sign-in: token exchange or verification failed");
      return fail("google_failed");
    }
    if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, saved.nonce)) return fail("invalid_state");
    if (claims.email_verified !== true) return fail("email_not_verified");

    const email = claims.email.toLowerCase();
    const user = await findUser(db, email);
    if (!user) {
      await logUnscoped(db, req, "auth.login.failure", null, email, { method: "google", reason: "no_account" });
      return fail("no_account");
    }
    const { rows } = await db.query<{ ok: boolean }>("SELECT auth_link_google_sub($1, $2) AS ok", [user.user_id, claims.sub]);
    if (!rows[0]?.ok) {
      await logUnscoped(db, req, "auth.login.failure", user.user_id, email, { method: "google", reason: "google_account_mismatch" });
      return fail("account_mismatch");
    }
    let tenantId: string;
    try {
      tenantId = resolveTenant(user.memberships, saved.tenant).tenantId;
    } catch (err) {
      return fail(err instanceof AppError ? err.code : "no_tenant_access");
    }
    await db.query("SELECT auth_register_login_success($1)", [user.user_id]);
    const { refreshToken } = await startSession(cfg, db, req, user.user_id, tenantId, "google");
    setRefreshCookie(cfg, reply as FastifyReply, refreshToken);
    const to = new URL("/", cfg.WEB_ORIGIN);
    to.searchParams.set("signin", "google");
    return reply.redirect(to.toString(), 302);
  });
}
