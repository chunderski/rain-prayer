import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAppRoleSafe } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/pool.js";
import { DEV_PASSWORD, OWNER_URL, WEB_ORIGIN, auth, createUser, login, makeApp, refreshCookieOf, withClient } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp();
  await createUser("multi@test.test", [{ slug: "acme-integrators", role: "assessor" }, { slug: "bluefield-security", role: "viewer" }]);
});
afterAll(() => app.close());

const post = (url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload, headers });
const withCookie = (v: string) => ({ cookie: `sa_refresh=${v}` });

describe("login", () => {
  it("returns an access token, session, and a hardened refresh cookie", async () => {
    const res = await post("/auth/login", { email: "Owner@Acme.test", password: DEV_PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session).toMatchObject({ user: { email: "owner@acme.test" }, tenant: { slug: "acme-integrators" }, role: "owner" });
    expect(body.accessToken.split(".")).toHaveLength(3);
    const c = res.cookies.find((x) => x.name === "sa_refresh")!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/auth" });
    const me = await app.inject({ url: "/auth/me", headers: auth(body.accessToken) });
    expect(me.json()).toEqual(body.session);
  });

  it("rejects a wrong password and an unknown user with the same 401", async () => {
    const a = await post("/auth/login", { email: "viewer@acme.test", password: "wrong" });
    const b = await post("/auth/login", { email: "nobody@acme.test", password: "wrong" });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
    expect(a.json().error.code).toBe("invalid_credentials");
  });

  it("answers 409 tenant_required for multi-tenant users, then accepts tenantSlug", async () => {
    const res = await post("/auth/login", { email: "multi@test.test", password: DEV_PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "tenant_required",
      details: { tenants: [{ slug: "acme-integrators", name: "Acme Integrators" }, { slug: "bluefield-security", name: "Bluefield Security" }] },
    });
    expect(refreshCookieOf(res)).toBeUndefined();
    const ok = await login(app, "multi@test.test", "bluefield-security");
    expect(ok.body.session).toMatchObject({ tenant: { slug: "bluefield-security" }, role: "viewer" });
    const denied = await post("/auth/login", { email: "owner@acme.test", password: DEV_PASSWORD, tenantSlug: "bluefield-security" });
    expect(denied.statusCode).toBe(403);
  });

  it("does not reveal tenants before the password is verified", async () => {
    const res = await post("/auth/login", { email: "multi@test.test", password: "wrong" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("bluefield");
  });

  it("locks the account after repeated failures", async () => {
    await createUser("lockme@acme.test", [{ slug: "acme-integrators", role: "viewer" }]);
    for (let i = 0; i < 5; i++) expect((await post("/auth/login", { email: "lockme@acme.test", password: "bad" })).statusCode).toBe(401);
    const locked = await post("/auth/login", { email: "lockme@acme.test", password: DEV_PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("account_locked");
    // Lock expires: simulate by moving locked_until into the past.
    await withClient(OWNER_URL, (c) => c.query("UPDATE app_user SET locked_until = now() - interval '1 second' WHERE email = 'lockme@acme.test'"));
    expect((await post("/auth/login", { email: "lockme@acme.test", password: DEV_PASSWORD })).statusCode).toBe(200);
  });

  it("rate limits /auth/login per client", async () => {
    const limited = await makeApp({ AUTH_RATE_LIMIT_MAX: "3" });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await limited.inject({ method: "POST", url: "/auth/login", payload: { email: "x@y.test", password: "z" } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
      const last = await limited.inject({ method: "POST", url: "/auth/login", payload: { email: "x@y.test", password: "z" } });
      expect(last.json().error.code).toBe("rate_limited");
    } finally {
      await limited.close();
    }
  });

  it("writes audit entries for login success and failure", async () => {
    const owner = await login(app, "owner@acme.test");
    await post("/auth/login", { email: "viewer@acme.test", password: "nope" });
    const rows = (await app.inject({ url: "/audit?limit=50", headers: auth(owner.token) })).json();
    const actions = rows.map((r: { action: string; actorEmail: string }) => `${r.action}:${r.actorEmail}`);
    expect(actions).toContain("auth.login.success:owner@acme.test");
    expect(actions).toContain("auth.login.failure:viewer@acme.test");
  });
});

describe("refresh and logout", () => {
  it("rotates the refresh token and rejects the old one (and then the whole family)", async () => {
    const first = await login(app, "assessor@acme.test");
    const r1 = await post("/auth/refresh", undefined, withCookie(first.refresh));
    expect(r1.statusCode).toBe(200);
    expect(r1.json().session.role).toBe("assessor");
    const second = refreshCookieOf(r1)!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first.refresh);

    const reuse = await post("/auth/refresh", undefined, withCookie(first.refresh));
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("invalid_refresh_token");
    // Reuse of a rotated token revokes the family, so the newer token is dead too.
    expect((await post("/auth/refresh", undefined, withCookie(second))).statusCode).toBe(401);
  });

  it("rejects missing, unknown, and foreign-origin refresh requests", async () => {
    expect((await post("/auth/refresh")).statusCode).toBe(401);
    expect((await post("/auth/refresh", undefined, withCookie("not-a-real-token"))).statusCode).toBe(401);
    const s = await login(app, "viewer@acme.test");
    const foreign = await post("/auth/refresh", undefined, { ...withCookie(s.refresh), origin: "https://evil.example" });
    expect(foreign.statusCode).toBe(403);
    const ok = await post("/auth/refresh", undefined, { ...withCookie(s.refresh), origin: WEB_ORIGIN });
    expect(ok.statusCode).toBe(200);
  });

  it("logout revokes the refresh token and audits it", async () => {
    const s = await login(app, "owner@acme.test");
    const out = await post("/auth/logout", undefined, withCookie(s.refresh));
    expect(out.statusCode).toBe(204);
    expect((await post("/auth/refresh", undefined, withCookie(s.refresh))).statusCode).toBe(401);
    const rows = (await app.inject({ url: "/audit?limit=20", headers: auth(s.token) })).json();
    expect(rows.map((r: { action: string }) => r.action)).toContain("auth.logout");
    expect((await post("/auth/logout")).statusCode).toBe(204);
  });

  it("stores only a SHA-256 hash of refresh tokens", async () => {
    const s = await login(app, "viewer@acme.test");
    const found = await withClient(OWNER_URL, (c) => c.query("SELECT 1 FROM refresh_token WHERE token_hash = $1", [s.refresh]));
    expect(found.rowCount).toBe(0);
  });
});

describe("access tokens", () => {
  it("rejects missing, malformed, and wrongly signed tokens", async () => {
    expect((await app.inject({ url: "/auth/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/auth/me", headers: auth("abc.def.ghi") })).statusCode).toBe(401);
    const other = await makeApp({ JWT_SECRET: "a-completely-different-secret-value-0123456789" });
    const foreign = await login(other, "owner@acme.test");
    await other.close();
    const res = await app.inject({ url: "/auth/me", headers: auth(foreign.token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("stops working when the membership is removed", async () => {
    const id = await createUser("removed@acme.test", [{ slug: "acme-integrators", role: "admin" }]);
    const s = await login(app, "removed@acme.test");
    expect((await app.inject({ url: "/clients", headers: auth(s.token) })).statusCode).toBe(200);
    await withClient(OWNER_URL, async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [s.body.session.tenant.id]);
      await c.query("DELETE FROM membership WHERE user_id = $1", [id]);
      await c.query("COMMIT");
    });
    expect((await app.inject({ url: "/clients", headers: auth(s.token) })).statusCode).toBe(401);
  });
});

describe("startup safety", () => {
  const base = { WEB_ORIGIN, DATABASE_URL: "postgres://a:b@localhost/x" };
  it("fails fast on a short or placeholder JWT_SECRET", () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: "short" })).toThrow(/JWT_SECRET must be at least 32/);
    expect(() => loadConfig({ ...base, JWT_SECRET: "replace-with-at-least-32-random-bytes" })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...base })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, JWT_SECRET: "x".repeat(40), NODE_ENV: "production" })).toThrow(/https/);
  });

  it("treats placeholder Google credentials as not configured", () => {
    const cfg = loadConfig({ ...base, JWT_SECRET: "x".repeat(40), GOOGLE_CLIENT_ID: "replace-me.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "replace-me" });
    expect(cfg.google).toBeNull();
  });

  it("refuses to run the API as the owner role, accepts sentinel_app", async () => {
    const owner = createDb(OWNER_URL, 1);
    await expect(assertAppRoleSafe(owner)).rejects.toThrow(/bypass row-level security/);
    await owner.close();
    const appDb = createDb((await import("./env.js")).APP_URL, 1);
    await expect(assertAppRoleSafe(appDb)).resolves.toBeUndefined();
    await appDb.close();
  });
});
