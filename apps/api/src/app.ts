import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "./config.js";
import { createDb, type Db } from "./db/pool.js";
import { AppError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { googleRoutes, type GoogleDeps } from "./routes/google.js";
import { libraryRoutes } from "./routes/library.js";
import { tenantRoutes } from "./routes/tenant.js";

export interface AppDeps {
  db?: Db;
  google?: GoogleDeps;
}

const FASTIFY_CODES: Record<string, [number, string, string]> = {
  FST_ERR_CTP_INVALID_JSON_BODY: [400, "bad_request", "Malformed JSON body"],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, "unsupported_media_type", "Content-Type must be application/json"],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, "payload_too_large", "Request body too large"],
};

export async function buildApp(cfg: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    logger: {
      level: cfg.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
      ...(cfg.NODE_ENV === "development" ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
    },
  });

  const db = deps.db ?? createDb(cfg.DATABASE_URL);
  if (!deps.db) app.addHook("onClose", async () => db.close());

  // JSON bodies; an empty body is treated as no body (POST /auth/logout, /auth/refresh).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, "bad_request", "Malformed JSON body"), undefined);
    }
  });

  await app.register(helmet, { crossOriginResourcePolicy: { policy: "same-site" } });
  // API responses may carry tenant data or tokens: never let browsers or proxies cache them (QA R-4).
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  await app.register(cors, {
    origin: [cfg.WEB_ORIGIN], // exact match; other origins get no CORS headers
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => new AppError(429, "rate_limited", `Too many requests; try again in ${ctx.after}`),
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      const body: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.details !== undefined) body.details = err.details;
      return reply.code(err.statusCode).send({ error: body });
    }
    const known = err.code ? FASTIFY_CODES[err.code] : undefined;
    if (known) return reply.code(known[0]).send({ error: { code: known[1], message: known[2] } });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
    }
    return reply.code(status).send({ error: { code: status === 429 ? "rate_limited" : "bad_request", message: err.message } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Route not found" } }));

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(authRoutes, { cfg, db });
  await app.register(googleRoutes, { cfg, db, deps: deps.google ?? {} });
  await app.register(libraryRoutes, { cfg, db });
  await app.register(tenantRoutes, { cfg, db });
  return app;
}

/**
 * Refuses to run when DATABASE_URL connects as a role that could bypass RLS
 * (superuser, BYPASSRLS, or the owner of the tables).
 */
export async function assertAppRoleSafe(db: Db): Promise<void> {
  const { rows } = await db.query<{ role: string; super: boolean; bypass: boolean; owned: number }>(
    `SELECT r.rolname AS role, r.rolsuper AS super, r.rolbypassrls AS bypass,
            (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r || r.super || r.bypass || r.owned > 0) {
    throw new Error(
      `DATABASE_URL role "${r?.role}" can bypass row-level security (superuser, BYPASSRLS, or table owner). ` +
        "Connect the API as sentinel_app; use MIGRATION_DATABASE_URL only for migrations and seeding.",
    );
  }
}
