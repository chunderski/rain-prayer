import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp, type AppDeps } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { hashPassword } from "../src/lib/auth.js";
import { DEV_PASSWORD } from "../src/db/seed.js";
import { APP_URL, OWNER_URL } from "./env.js";

export { APP_URL, OWNER_URL, DEV_PASSWORD };
export const WEB_ORIGIN = "http://localhost:5173";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    WEB_ORIGIN,
    DATABASE_URL: APP_URL,
    JWT_SECRET: "test-only-secret-0123456789abcdefghijklmnopqrstuvwxyz",
    AUTH_RATE_LIMIT_MAX: "1000",
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
