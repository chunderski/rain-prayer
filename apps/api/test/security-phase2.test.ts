/** Phase 2 security items: absolute session cap (R-5), 403 audit (R-6), data rate limits (R-9), embed origins (R-10). */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OWNER_URL, WEB_ORIGIN, adminScalar, auth, login, makeApp, refreshCookieOf, testConfig, withClient } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await makeApp({ EMBED_ORIGINS: "https://partner.example, https://portal.integrator.example" });
});
afterAll(() => app.close());

const DAY = 86_400;
async function ageSession(refresh: string, seconds: number) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(refresh).digest("hex");
  await withClient(OWNER_URL, async (c) => {
    const t = (await c.query("SELECT tenant_id FROM refresh_token WHERE token_hash = $1", [hash])).rows[0].tenant_id;
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
    await c.query("UPDATE refresh_token SET session_started_at = now() - make_interval(secs => $2) WHERE token_hash = $1", [hash, seconds]);
    await c.query("COMMIT");
  });
}
const refresh = (token: string) =>
  app.inject({ method: "POST", url: "/auth/refresh", headers: { origin: WEB_ORIGIN }, cookies: { sa_refresh: token } });

describe("absolute session cap (R-5)", () => {
  it("rotation near the cap issues a token that expires at the cap", async () => {
    const s = await login(app, "viewer@acme.test");
    await ageSession(s.refresh, 30 * DAY - 3600);
    const r = await refresh(s.refresh);
    expect(r.statusCode).toBe(200);
    const cookie = r.cookies.find((c) => c.name === "sa_refresh")!;
    expect(cookie.maxAge).toBeLessThanOrEqual(3600);
    expect(cookie.maxAge).toBeGreaterThan(3500);
  });

  it("refresh fails after 30 days from sign-in even with a fresh token, and the family is revoked", async () => {
    const s = await login(app, "viewer@acme.test");
    const rotated = refreshCookieOf(await refresh(s.refresh))!;
    await ageSession(rotated, 30 * DAY + 60);
    const r = await refresh(rotated);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("invalid_refresh_token");
    const log = (await app.inject({ url: "/audit?limit=20", headers: auth((await login(app, "owner@acme.test")).token) })).json();
    expect(log.some((x: { action: string }) => x.action === "auth.session.expired")).toBe(true);
  });

  it("the session start carries across rotations", async () => {
    const s = await login(app, "viewer@acme.test");
    await ageSession(s.refresh, 10 * DAY);
    const r1 = refreshCookieOf(await refresh(s.refresh))!;
    const r2 = refreshCookieOf(await refresh(r1))!;
    const { createHash } = await import("node:crypto");
    await withClient(OWNER_URL, async (c) => {
      const row = (await c.query("SELECT now() - session_started_at > interval '9 days' AS old FROM refresh_token WHERE token_hash = $1", [createHash("sha256").update(r2).digest("hex")])).rows[0];
      expect(row.old).toBe(true);
    });
  });
});

describe("rate limits on data routes (R-9)", () => {
  it("limits per user, not per IP", async () => {
    const limited = await makeApp({ DATA_RATE_LIMIT_MAX: "3" });
    const a = (await login(limited, "viewer@acme.test")).token;
    const b = (await login(limited, "owner@acme.test")).token;
    for (let i = 0; i < 3; i++) expect((await limited.inject({ url: "/clients", headers: auth(a) })).statusCode).toBe(200);
    const blocked = await limited.inject({ url: "/frameworks", headers: auth(a) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate_limited");
    expect((await limited.inject({ url: "/clients", headers: auth(b) })).statusCode).toBe(200);
    await limited.close();
  });
});

describe("embed origins (R-10)", () => {
  it("CORS allows WEB_ORIGIN and each EMBED_ORIGINS entry, nothing else, and exposes the GPS header", async () => {
    for (const origin of [WEB_ORIGIN, "https://partner.example", "https://portal.integrator.example"]) {
      const r = await app.inject({ method: "OPTIONS", url: "/clients", headers: { origin, "access-control-request-method": "GET" } });
      expect(r.headers["access-control-allow-origin"], origin).toBe(origin);
    }
    const bad = await app.inject({ method: "OPTIONS", url: "/clients", headers: { origin: "https://partner.example.evil", "access-control-request-method": "GET" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const get = await app.inject({ url: "/health", headers: { origin: "https://partner.example" } });
    expect(String(get.headers["access-control-expose-headers"])).toMatch(/X-Sentinel-Gps/i);
  });

  it("rejects malformed or non-https embed origins in production", () => {
    expect(() => testConfig({ EMBED_ORIGINS: "https://ok.example/path" })).toThrow(/EMBED_ORIGINS/);
    expect(() => testConfig({ EMBED_ORIGINS: "*" })).toThrow(/EMBED_ORIGINS/);
    expect(() =>
      loadConfig({ NODE_ENV: "production", WEB_ORIGIN: "https://app.example", DATABASE_URL: "postgres://a:b@h/d", JWT_SECRET: "x".repeat(40), EMBED_ORIGINS: "http://insecure.example" }),
    ).toThrow(/EMBED_ORIGINS/);
  });
});

describe("403 audit (R-6)", () => {
  it("a role denial is written to the audit log with the route", async () => {
    const viewer = (await login(app, "viewer@acme.test")).token;
    expect((await app.inject({ method: "PATCH", url: "/tenant/settings", headers: auth(viewer), payload: { allowGps: true } })).statusCode).toBe(403);
    const log = (await app.inject({ url: "/audit?limit=10", headers: auth((await login(app, "owner@acme.test")).token) })).json();
    expect(log.find((x: { action: string; entityId: string; actorEmail: string }) => x.action === "access.denied" && x.entityId === "/tenant/settings" && x.actorEmail === "viewer@acme.test")).toBeTruthy();
  });

  it("a refresh from a foreign origin is denied and audited without a tenant", async () => {
    const r = await app.inject({ method: "POST", url: "/auth/refresh", headers: { origin: "https://evil.example" }, cookies: { sa_refresh: "x" } });
    expect(r.statusCode).toBe(403);
    expect(Number(await adminScalar("SELECT count(*) FROM audit_log WHERE tenant_id IS NULL AND action = 'auth.denied'"))).toBeGreaterThan(0);
  });
});
