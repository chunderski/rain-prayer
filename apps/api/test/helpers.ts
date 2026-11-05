import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp, type AppDeps } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { hashPassword } from "../src/lib/auth.js";
import { DEV_PASSWORD } from "../src/db/seed.js";
import { APP_URL, OWNER_URL } from "./env.js";

export { APP_URL, OWNER_URL, DEV_PASSWORD };
export const WEB_ORIGIN = "http://localhost:5173";
export const TEST_STORAGE_DIR = join(tmpdir(), `sentinel-api-test-storage-${process.pid}`);

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    WEB_ORIGIN,
    DATABASE_URL: APP_URL,
    JWT_SECRET: "test-only-secret-0123456789abcdefghijklmnopqrstuvwxyz",
    AUTH_RATE_LIMIT_MAX: "1000",
    DATA_RATE_LIMIT_MAX: "100000",
    SYNC_RATE_LIMIT_MAX: "100000",
    AI_ANALYZE_RATE_LIMIT_PER_HOUR: "1000",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: TEST_STORAGE_DIR,
    API_PUBLIC_URL: "http://api.test",
    ANTHROPIC_API_KEY: "",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

export async function makeApp(overrides: Record<string, string> = {}, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides), deps);
  await app.ready();
  return app;
}

export interface LoggedIn {
  token: string;
  refresh: string;
  body: { accessToken: string; session: { user: { id: string; email: string }; tenant: { id: string; slug: string }; role: string } };
}

export function refreshCookieOf(res: { cookies: { name: string; value: string }[] }): string | undefined {
  return res.cookies.find((c) => c.name === "sa_refresh")?.value;
}

export async function login(app: FastifyInstance, email: string, tenantSlug?: string, password = DEV_PASSWORD): Promise<LoggedIn> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, ...(tenantSlug ? { tenantSlug } : {}) } });
  if (res.statusCode !== 200) throw new Error(`login ${email} failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { token: body.accessToken, refresh: refreshCookieOf(res)!, body };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Runs fn as a raw pg client connected with the given URL; always closes it. */
export async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Creates (or resets) a user with memberships, as the owner role. */
export async function createUser(email: string, memberships: { slug: string; role: string }[], password = DEV_PASSWORD) {
  const hash = await hashPassword(password);
  return withClient(OWNER_URL, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app_user (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_count = 0, locked_until = NULL
       RETURNING id`,
      [email, email.split("@")[0], hash],
    );
    const userId = rows[0]!.id;
    for (const m of memberships) {
      const t = await c.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [m.slug]);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.rows[0]!.id]);
      await c.query(
        "INSERT INTO membership (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        [t.rows[0]!.id, userId, m.role],
      );
      await c.query("COMMIT");
    }
    return userId;
  });
}

export async function tenantId(slug: string): Promise<string> {
  return withClient(OWNER_URL, async (c) => (await c.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [slug])).rows[0]!.id);
}

/** Runs fn inside a tenant transaction as sentinel_app (rolled back), for raw SQL isolation checks. */
/** Like asAppInTenant, but COMMITs, for tests that need the rows to exist afterwards. */
export async function asAppInTenantCommit<T>(tid: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  return withClient(APP_URL, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
      const out = await fn((sql, p) => c.query(sql, p));
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

export async function asAppInTenant<T>(tid: string, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  return withClient(APP_URL, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tid]);
      return await fn((sql, p) => c.query(sql, p));
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

export interface FieldFixture {
  clientId: string;
  siteId: string;
  assessmentId: string;
}

/** Client, site, and assessment (test-fw) created by the given admin or owner; assessors assigned if given. */
export async function fieldFixture(app: FastifyInstance, adminToken: string, assessorIds: string[] = [], title = "Field walk"): Promise<FieldFixture> {
  const c = await app.inject({ method: "POST", url: "/clients", headers: auth(adminToken), payload: { name: `Client ${title}` } });
  const clientId = c.json().id;
  const s = await app.inject({ method: "POST", url: "/sites", headers: auth(adminToken), payload: { clientId, name: `Site ${title}` } });
  const siteId = s.json().id;
  const a = await app.inject({
    method: "POST", url: "/assessments", headers: auth(adminToken),
    payload: { siteId, title, frameworks: [{ frameworkId: "test-fw", version: "1.0.0" }] },
  });
  if (a.statusCode !== 201) throw new Error(`assessment: ${a.statusCode} ${a.body}`);
  const assessmentId = a.json().id;
  if (assessorIds.length) {
    const r = await app.inject({ method: "PUT", url: `/assessments/${assessmentId}/assessors`, headers: auth(adminToken), payload: { userIds: assessorIds } });
    if (r.statusCode !== 200) throw new Error(`assign: ${r.statusCode} ${r.body}`);
  }
  return { clientId, siteId, assessmentId };
}

export const nowIso = () => new Date().toISOString();

/** Runs a scalar query as a Postgres superuser (same access path as setup-db), for rows no app role may read. */
export async function adminScalar(sql: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { TEST_DB } = await import("./env.js");
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  const args = ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"];
  const out = adminUrl
    ? execFileSync("psql", [...args, adminUrl.replace(/\/[^/]*$/, `/${TEST_DB}`), "-c", sql])
    : execFileSync("su", ["postgres", "-c", `psql ${args.join(" ")} -d ${TEST_DB}`], { input: sql });
  return out.toString().trim();
}
