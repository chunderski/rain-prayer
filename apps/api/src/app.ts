import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
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
import { createAnthropicTextClient, createAnthropicVisionClient, type TextClient, type VisionClient } from "@sentinel/ai";
import { createGoogleClient, type Transport } from "./google/client.js";
import { createExportQueue, type ExportQueue } from "./google/exports.js";
import { photoGate } from "./photos/process.js";
import { RiskService, type RiskDeps } from "./risk/service.js";
import { integrationRoutes } from "./routes/integrations.js";
import { reportRoutes } from "./routes/report.js";
import { riskRoutes } from "./routes/risk.js";
import { createLimiters, type Limiters } from "./lib/access.js";
import { audit } from "./lib/audit.js";
import { loadWalkthrough, type WalkthroughDef } from "./lib/walkthrough.js";
import { aiRoutes } from "./routes/ai.js";
import { logUnscoped } from "./routes/auth.js";
import { fieldRoutes } from "./routes/field.js";
import { photoRoutes } from "./routes/photos.js";
import { syncRoutes } from "./routes/sync.js";
import { createStorage, type ObjectStorage } from "./storage/index.js";
import { DEFAULT_TEMPLATE_PATH } from "./quotes/pricebook.js";
import { brandingRoutes } from "./routes/branding.js";
import { memberRoutes } from "./routes/members.js";
import { portalRoutes } from "./routes/portal.js";
import { priceBookRoutes } from "./routes/pricebook.js";
import { quoteRoutes } from "./routes/quotes.js";

export interface AppDeps {
  db?: Db;
  google?: GoogleDeps;
  storage?: ObjectStorage;
  /** Vision transport; tests inject a fake. Defaults to the Anthropic client when ANTHROPIC_API_KEY is real. */
  vision?: VisionClient;
  /** Walkthrough definition; undefined loads packages/frameworks/data/walkthrough.json, null forces the per-domain fallback. */
  walkthrough?: WalkthroughDef | null;
  /** Exposed for tests (reset between cases). */
  limiters?: Limiters;
  /** Risk engine and scenario library overrides (tests use fixture scenarios). */
  risk?: RiskDeps;
  /** Narrative text transport; tests inject a fake. Defaults to the Anthropic client when ANTHROPIC_API_KEY is real. */
  text?: TextClient | null;
  /** Google Drive, Docs, and Sheets transport for exports; tests inject a fake. */
  googleApi?: { transport?: Transport; sleep?: (ms: number) => Promise<void> };
  /** Price book template file; defaults to apps/api/data/price-book-template.json. */
  priceBookTemplatePath?: string;
}

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    limiters: Limiters;
    storage: ObjectStorage;
    exportQueue: ExportQueue | null;
    /** Every registered route (tests walk it to prove client_viewer is refused outside the portal). */
    routeRegistry: RegisteredRoute[];
  }
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
    routerOptions: { maxParamLength: 600 }, // signed file tokens (/files/:token) are about 200 characters
    logger: {
      level: cfg.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
      ...(cfg.NODE_ENV === "development" ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
    },
  });

  const routeRegistry: RegisteredRoute[] = [];
  app.decorate("routeRegistry", routeRegistry);
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") routeRegistry.push({ method: m, url: r.url ?? r.path });
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
    // Exact match: the PWA origin plus embedding hosts (EMBED_ORIGINS, QA R-10); other origins get no CORS headers.
    origin: [cfg.WEB_ORIGIN, ...cfg.embedOrigins],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["X-Sentinel-Gps", "Retry-After", "X-RateLimit-Remaining", "X-Risk-Method", "X-Report-Template"],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => new AppError(429, "rate_limited", `Too many requests; try again in ${ctx.after}`),
  });

  /** QA R-6: every 403 is audited, in the caller's tenant when known, otherwise as an unscoped auth event. */
  const auditDenied = async (req: FastifyRequest, err: AppError) => {
    const details = { method: req.method, route: req.routeOptions.url ?? req.url.split("?")[0], code: err.code };
    try {
      if (req.auth) {
        await db.withTenant(req.auth.tenantId, (tx) =>
          audit(tx, {
            tenantId: req.auth!.tenantId, actorUserId: req.auth!.userId, actorEmail: req.auth!.user.email, action: "access.denied",
            entityType: "route", entityId: details.route, ip: req.ip, userAgent: req.headers["user-agent"], details,
          }),
        );
      } else {
        await logUnscoped(db, req, "auth.denied", null, "", details);
      }
    } catch (e) {
      req.log.error({ err: e }, "could not audit a 403");
    }
  };

  app.setErrorHandler(async (err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode === 403) await auditDenied(req, err);
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

  const limiters = deps.limiters ?? createLimiters(cfg);
  const storage = deps.storage ?? createStorage(cfg);
  const walkthrough = deps.walkthrough === undefined ? loadWalkthrough(undefined, (m) => app.log.warn(m)) : deps.walkthrough;
  let vision: VisionClient | null | undefined = deps.vision;
  const getVision = () => {
    if (vision === undefined) vision = cfg.anthropicApiKey ? createAnthropicVisionClient({ apiKey: cfg.anthropicApiKey }) : null;
    return vision;
  };
  let text: TextClient | null | undefined = deps.text;
  const getText = () => {
    if (text === undefined) text = cfg.anthropicApiKey ? createAnthropicTextClient({ apiKey: cfg.anthropicApiKey }) : null;
    return text;
  };
  photoGate.setMax(cfg.PHOTO_MAX_CONCURRENCY);
  const risk = new RiskService(deps.risk);
  const google = cfg.googleExport
    ? createGoogleClient({ ...cfg.googleExport, transport: deps.googleApi?.transport, sleep: deps.googleApi?.sleep })
    : null;
  const exportQueue = google ? createExportQueue({ cfg, db, storage, risk, google, log: app.log }) : null;
  // Let running exports finish before the pool closes.
  app.addHook("onClose", async () => exportQueue?.idle());
  app.decorate("limiters", limiters);
  app.decorate("storage", storage);
  app.decorate("exportQueue", exportQueue);
  const fieldDeps = { cfg, db, limiters, storage, walkthrough, vision: getVision, risk };

  app.get("/health", async () => ({ status: "ok" }));
  // Brand color stylesheet for previews shown inside the PWA's sandboxed iframe, whose inherited CSP blocks
  // the server's inline <style>. Public and stateless: it only echoes two validated hex colors, no tenant data.
  app.get("/theme.css", async (req, reply) => {
    const q = req.query as { p?: unknown; a?: unknown };
    const hex = (v: unknown, d: string) => (typeof v === "string" && /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : d);
    reply.type("text/css; charset=utf-8");
    return `:root{--brand-primary:${hex(q.p, "#0b3d91")};--brand-accent:${hex(q.a, "#b45309")};--brand-on-primary:#ffffff}\n`;
  });
  await app.register(authRoutes, { cfg, db });
  await app.register(googleRoutes, { cfg, db, deps: deps.google ?? {} });
  await app.register(libraryRoutes, { cfg, db, limiters });
  await app.register(tenantRoutes, { cfg, db, limiters });
  await app.register(fieldRoutes, fieldDeps);
  await app.register(photoRoutes, fieldDeps);
  await app.register(aiRoutes, fieldDeps);
  await app.register(syncRoutes, fieldDeps);
  await app.register(riskRoutes, fieldDeps);
  await app.register(reportRoutes, { ...fieldDeps, text: getText });
  await app.register(integrationRoutes, { ...fieldDeps, google, exportQueue });
  const channelDeps = { ...fieldDeps, templatePath: deps.priceBookTemplatePath ?? DEFAULT_TEMPLATE_PATH };
  await app.register(brandingRoutes, fieldDeps);
  await app.register(memberRoutes, fieldDeps);
  await app.register(priceBookRoutes, channelDeps);
  await app.register(quoteRoutes, channelDeps);
  await app.register(portalRoutes, channelDeps);
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
