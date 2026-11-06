/**
 * Typed API client.
 *
 * - Base URL: import.meta.env.VITE_API_URL, default http://localhost:3000.
 * - The access token lives only in this closure (memory). Nothing token-bearing is written to
 *   localStorage, IndexedDB, or the service worker cache.
 * - On a 401 the client calls POST /auth/refresh once (httpOnly cookie, credentials: "include"),
 *   then retries the original request. Concurrent 401s share a single refresh call.
 * - POST /auth/login answering 409 tenant_required throws TenantRequiredError so the UI can show
 *   a workspace chooser and retry with tenantSlug.
 */
import type { z } from "zod";
import type { LoginRequest, SessionInfo } from "@sentinel/shared";
import { ApiErrorBody, TenantRequiredDetails, TokenResponse, type TenantChoice } from "./schemas";

export const DEFAULT_API_URL = "http://localhost:3000";

export function apiBaseUrl(): string {
  const fromEnv = import.meta.env?.VITE_API_URL as string | undefined;
  return (fromEnv ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request never reached the server (offline, DNS, CORS). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("The server could not be reached. Check your connection.");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class TenantRequiredError extends ApiError {
  constructor(readonly tenants: TenantChoice[]) {
    super(409, "tenant_required", "Choose a workspace to continue.", { tenants });
    this.name = "TenantRequiredError";
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Called when a refresh fails, so the app can return to sign in. */
  onSessionExpired?: () => void;
  /** Called whenever the session changes (sign in, refresh, sign out). */
  onSession?: (session: SessionInfo | null) => void;
}

interface RequestOptions<S extends z.ZodTypeAny> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  schema?: S;
  /** Send the bearer token and refresh on 401. Default true. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Binary body (photo bytes); sent as is with `contentType`. */
  rawBody?: Blob;
  contentType?: string;
  /** Return the body as text (HTML report preview) instead of parsing JSON. */
  text?: boolean;
}

export type RestoreResult = { kind: "ok"; session: SessionInfo } | { kind: "none" } | { kind: "offline" };

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? apiBaseUrl()).replace(/\/+$/, "");
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  let accessToken: string | null = null;
  let refreshInFlight: Promise<boolean> | null = null;
  let currentSession: SessionInfo | null = null;

  async function rawFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(`${baseUrl}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new NetworkError(err);
    }
  }

  async function toError(res: Response): Promise<ApiError> {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    const parsed = ApiErrorBody.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      if (res.status === 409 && code === "tenant_required") {
        const d = TenantRequiredDetails.safeParse(details);
        if (d.success) return new TenantRequiredError(d.data.tenants);
      }
      return new ApiError(res.status, code, message, details);
    }
    return new ApiError(res.status, "http_error", `Request failed (${res.status})`);
  }

  function setSession(data: TokenResponse | null) {
    accessToken = data?.accessToken ?? null;
    currentSession = data?.session ?? null;
    options.onSession?.(data?.session ?? null);
  }

  /** POST /auth/refresh once; shared by concurrent callers. Resolves true when a new token was issued. */
  function refresh(): Promise<boolean> {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const res = await rawFetch("/auth/refresh", { method: "POST", credentials: "include" });
          if (!res.ok) return false;
          const data = TokenResponse.parse(await res.json());
          setSession(data);
          return true;
        } catch (err) {
          if (err instanceof NetworkError) throw err;
          return false;
        } finally {
          refreshInFlight = null;
        }
      })();
    }
    return refreshInFlight;
  }

  async function request<S extends z.ZodTypeAny = z.ZodUnknown>(
    path: string,
    opts: RequestOptions<S> = {},
  ): Promise<z.infer<S>> {
    const { method = "GET", body, schema, auth = true, signal, rawBody, contentType, text } = opts;
    const send = () => {
      const headers: Record<string, string> = { Accept: text ? "text/html" : "application/json" };
      if (rawBody) headers["Content-Type"] = contentType ?? (rawBody.type || "application/octet-stream");
      else if (body !== undefined) headers["Content-Type"] = "application/json";
      if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
      return rawFetch(path, {
        method,
        headers,
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal,
        credentials: path.startsWith("/auth/") ? "include" : "same-origin",
      });
    };

    let res = await send();
    if (res.status === 401 && auth) {
      const refreshed = await refresh();
      if (!refreshed) {
        setSession(null);
        options.onSessionExpired?.();
        throw await toError(res);
      }
      res = await send();
    }
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as z.infer<S>;
    if (text) return (await res.text()) as z.infer<S>;
    const json: unknown = await res.json();
    if (!schema) return json as z.infer<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(res.status, "invalid_response", `Unexpected response from ${path}`, parsed.error.issues);
    }
    return parsed.data;
  }

  return {
    baseUrl,
    request,
    get: <S extends z.ZodTypeAny>(path: string, schema: S, signal?: AbortSignal) => request(path, { schema, signal }),
    post: <S extends z.ZodTypeAny>(path: string, body: unknown, schema: S) => request(path, { method: "POST", body, schema }),
    hasToken: () => accessToken !== null,
    session: () => currentSession,

    async login(req: LoginRequest): Promise<SessionInfo> {
      const data = await request("/auth/login", { method: "POST", body: req, schema: TokenResponse, auth: false });
      setSession(data);
      return data.session;
    },

    /** POST /auth/setup: set a password from a one-time setup link; signs in like login. */
    async completeSetup(body: { token: string; password: string }): Promise<SessionInfo> {
      const data = await request("/auth/setup", { method: "POST", body, schema: TokenResponse, auth: false });
      setSession(data);
      return data.session;
    },

    /** Restore a session from the refresh cookie at startup. Returns null when there is none. */
    async restore(): Promise<SessionInfo | null> {
      const ok = await refresh().catch(() => false);
      return ok ? currentSession : null;
    },

    /**
     * Like restore, but tells "no session" apart from "could not reach the server", so the app can
     * open cached work offline for a user who signed in on this device before.
     */
    async restoreDetailed(): Promise<RestoreResult> {
      try {
        const ok = await refresh();
        return ok && currentSession ? { kind: "ok", session: currentSession } : { kind: "none" };
      } catch (err) {
        if (err instanceof NetworkError) return { kind: "offline" };
        return { kind: "none" };
      }
    },

    /** Resolve true when an access token is available, refreshing once if needed. Throws NetworkError when offline. */
    async ensureToken(): Promise<boolean> {
      if (accessToken) return true;
      return refresh();
    },

    async logout(): Promise<void> {
      try {
        await rawFetch("/auth/logout", { method: "POST", credentials: "include" });
      } catch {
        /* offline: the local token is cleared regardless */
      } finally {
        setSession(null);
      }
    },

    googleStartUrl: () => `${baseUrl}/auth/google/start`,
  };
}
