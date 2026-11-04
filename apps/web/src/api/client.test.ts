import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, NetworkError, TenantRequiredError, createApiClient } from "./client";

const session = {
  user: { id: "11111111-1111-4111-8111-111111111111", email: "a@acme.test", name: "A" },
  tenant: { id: "22222222-2222-4222-8222-222222222222", slug: "acme", name: "Acme" },
  role: "assessor",
};

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init = {}) =>
    handler(String(input), init),
  );
}
const authHeader = (init: RequestInit) => (init.headers as Record<string, string> | undefined)?.Authorization;

describe("api client", () => {
  it("logs in, keeps the token in memory, and sends it as a bearer token", async () => {
    const fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/login")) return json(200, { accessToken: "t1", session });
      if (url.endsWith("/clients")) return authHeader(init) === "Bearer t1" ? json(200, []) : json(401, { error: { code: "unauthorized", message: "no" } });
      throw new Error(url);
    });
    const api = createApiClient({ baseUrl: "http://api.test", fetch });
    await api.login({ email: "a@acme.test", password: "x" });
    expect(await api.get("/clients", z.array(z.unknown()))).toEqual([]);
    const loginInit = fetch.mock.calls[0]![1]!;
    expect(loginInit.credentials).toBe("include");
    expect(localStorage.length).toBe(0);
  });

  it("refreshes once on 401 and retries the original request", async () => {
    let token = "old";
    const fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/refresh")) {
        expect(init.credentials).toBe("include");
        token = "new";
        return json(200, { accessToken: "new", session });
      }
      if (url.endsWith("/frameworks")) {
        return authHeader(init) === `Bearer ${token}` && token === "new" ? json(200, [1]) : json(401, { error: { code: "token_expired", message: "expired" } });
      }
      throw new Error(url);
    });
    const onSession = vi.fn();
    const api = createApiClient({ baseUrl: "http://api.test", fetch, onSession });
    const data = await api.get("/frameworks", z.array(z.number()));
    expect(data).toEqual([1]);
    const paths = fetch.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths).toEqual(["/frameworks", "/auth/refresh", "/frameworks"]);
    expect(onSession).toHaveBeenCalledWith(session);
  });

  it("shares one refresh between concurrent 401s", async () => {
    let refreshed = false;
    const fetch = mockFetch(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        await new Promise((r) => setTimeout(r, 5));
        refreshed = true;
        return json(200, { accessToken: "new", session });
      }
      return refreshed ? json(200, { ok: true }) : json(401, { error: { code: "token_expired", message: "expired" } });
    });
    const api = createApiClient({ baseUrl: "http://api.test", fetch });
    await Promise.all([api.get("/a", z.unknown()), api.get("/b", z.unknown()), api.get("/c", z.unknown())]);
    expect(fetch.mock.calls.filter((c) => String(c[0]).endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("gives up after one failed refresh and reports the session as expired", async () => {
    const fetch = mockFetch((url) =>
      url.endsWith("/auth/refresh") ? json(401, { error: { code: "invalid_refresh", message: "no" } }) : json(401, { error: { code: "unauthorized", message: "Sign in" } }),
    );
    const onSessionExpired = vi.fn();
    const api = createApiClient({ baseUrl: "http://api.test", fetch, onSessionExpired });
    await expect(api.get("/clients", z.unknown())).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it("does not try to refresh for the login call itself", async () => {
    const fetch = mockFetch(() => json(401, { error: { code: "invalid_credentials", message: "Wrong" } }));
    const api = createApiClient({ baseUrl: "http://api.test", fetch });
    await expect(api.login({ email: "a@acme.test", password: "x" })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("turns 409 tenant_required into a workspace choice", async () => {
    const tenants = [
      { slug: "acme", name: "Acme" },
      { slug: "bluefield", name: "Bluefield" },
    ];
    const fetch = mockFetch(() => json(409, { error: { code: "tenant_required", message: "Pick", details: { tenants } } }));
    const api = createApiClient({ baseUrl: "http://api.test", fetch });
    const err = await api.login({ email: "a@acme.test", password: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantRequiredError);
    expect((err as TenantRequiredError).tenants).toEqual(tenants);
  });

  it("restore() returns null without a refresh cookie", async () => {
    const fetch = mockFetch(() => json(401, { error: { code: "no_session", message: "none" } }));
    expect(await createApiClient({ baseUrl: "http://api.test", fetch }).restore()).toBeNull();
  });

  it("reports network failures as NetworkError", async () => {
    const fetch = mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const api = createApiClient({ baseUrl: "http://api.test", fetch });
    await expect(api.get("/frameworks", z.unknown())).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects responses that do not match the schema", async () => {
    const api = createApiClient({ baseUrl: "http://api.test", fetch: mockFetch(() => json(200, { nope: true })) });
    await expect(api.get("/x", z.array(z.string()))).rejects.toMatchObject({ code: "invalid_response" });
  });
});
