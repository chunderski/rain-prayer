import type { FastifyInstance } from "fastify";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from "../src/routes/google.js";
import { WEB_ORIGIN, makeApp, refreshCookieOf } from "./helpers.js";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-google-secret", GOOGLE_REDIRECT_URI: "http://localhost:3000/auth/google/callback" };

describe("Google sign-in not configured", () => {
  it("answers 404 google_not_configured with placeholder or missing credentials", async () => {
    for (const env of [{}, { GOOGLE_CLIENT_ID: "replace-me.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "replace-me" }]) {
      const app = await makeApp(env);
      for (const url of ["/auth/google/start", "/auth/google/callback?code=x&state=y"]) {
        const res = await app.inject({ url });
        expect(res.statusCode, url).toBe(404);
        expect(res.json().error.code).toBe("google_not_configured");
      }
      await app.close();
    }
  });
});

describe("Google sign-in configured (Google mocked)", () => {
  let app: FastifyInstance;
  let privateKey: CryptoKey;
  const fetchMock = vi.fn<typeof fetch>();
  let idTokenClaims: Record<string, unknown> = {};

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
    fetchMock.mockImplementation(async () => {
      const idToken = await new SignJWT(idTokenClaims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://accounts.google.com")
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } });
    });
    app = await makeApp(GOOGLE_ENV, { google: { fetch: fetchMock, googleJwks: createLocalJWKSet({ keys: [jwk] }) } });
  });
  afterAll(() => app.close());

  async function start(query = "") {
    const res = await app.inject({ url: `/auth/google/start${query}` });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    const cookie = res.cookies.find((c) => c.name === "sa_oidc")!;
    return { res, loc, cookie, state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")! };
  }
  const callback = (qs: string, cookie?: string) =>
    app.inject({ url: `/auth/google/callback?${qs}`, headers: cookie ? { cookie: `sa_oidc=${cookie}` } : {} });
  const errorOf = (res: { headers: Record<string, unknown> }) => new URL(res.headers.location as string).searchParams.get("error");

  it("start redirects to Google with state, nonce, and S256 PKCE, and seals state in a cookie", async () => {
    const { loc, cookie, state } = await start();
    expect(`${loc.origin}${loc.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/auth/google" });
    expect(cookie.value).not.toContain(state); // encrypted, not just signed
  });

  it("callback rejects a missing cookie, a wrong state, and a tampered cookie before calling Google", async () => {
    fetchMock.mockClear();
    const { cookie, state } = await start();
    expect(errorOf(await callback(`code=c&state=${state}`))).toBe("invalid_state");
    expect(errorOf(await callback(`code=c&state=wrong-state`, cookie.value))).toBe("invalid_state");
    expect(errorOf(await callback(`code=c&state=${state}`, cookie.value.slice(0, -4) + "AAAA"))).toBe("invalid_state");
    expect(errorOf(await callback(`error=access_denied&state=${state}`, cookie.value))).toBe("google_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs in an existing user by verified email and sets the refresh cookie", async () => {
    fetchMock.mockClear();
    const { cookie, state, nonce } = await start();
    idTokenClaims = { sub: "google-sub-owner", email: "Owner@Acme.test", email_verified: true, nonce };
    const res = await callback(`code=auth-code&state=${state}`, cookie.value);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/?signin=google`);
    const sent = new URLSearchParams(String(fetchMock.mock.calls[0]![1]!.body));
    expect(fetchMock.mock.calls[0]![0]).toBe(GOOGLE_TOKEN_URL);
    expect(sent.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const refresh = refreshCookieOf(res)!;
    const r = await app.inject({ method: "POST", url: "/auth/refresh", headers: { cookie: `sa_refresh=${refresh}` } });
    expect(r.json().session).toMatchObject({ user: { email: "owner@acme.test" }, role: "owner" });
  });

  it("rejects a wrong nonce, unverified email, unknown user, and a different Google account", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ sub: "google-sub-owner", email: "owner@acme.test", email_verified: true, nonce: "other" }, "invalid_state"],
      [{ sub: "s2", email: "viewer@acme.test", email_verified: false }, "email_not_verified"],
      [{ sub: "s3", email: "stranger@example.com", email_verified: true }, "no_account"],
      [{ sub: "someone-else", email: "owner@acme.test", email_verified: true }, "account_mismatch"],
    ];
    for (const [claims, expected] of cases) {
      const { cookie, state, nonce } = await start();
      idTokenClaims = { nonce, ...claims };
      const res = await callback(`code=c&state=${state}`, cookie.value);
      expect(errorOf(res), expected).toBe(expected);
      expect(refreshCookieOf(res)).toBeUndefined();
    }
  });
});
