/** Environment configuration, validated once at startup. Invalid config stops the process. */
import { z } from "zod";

const PLACEHOLDER = /replace-me|replace-with|change-me/i;

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_ORIGIN: z.string().url(),
    TRUST_PROXY: bool.default(false),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
    JWT_SECRET: z
      .string()
      .min(32, "JWT_SECRET must be at least 32 characters")
      .refine((v) => !PLACEHOLDER.test(v), "JWT_SECRET is still the .env.example placeholder; generate one with: openssl rand -base64 48"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(60 * 60 * 24 * 90).default(1_209_600),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    AUTH_RATE_LIMIT_WINDOW: z.string().default("1 minute"),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
    LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Absolute session lifetime: refresh tokens stop rotating this long after sign-in (QA R-5). */
    SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(300).max(60 * 60 * 24 * 90).default(2_592_000),
    /** Comma-separated origins allowed to embed the app (web component or iframe host pages); added to CORS (QA R-10). */
    EMBED_ORIGINS: z.string().default(""),
    /** Base URL clients use to reach this API; used for local-driver signed photo URLs. */
    API_PUBLIC_URL: z.string().url().optional(),
    // Per-user rate limits on data routes (QA R-9).
    DATA_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
    DATA_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    SYNC_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
    AI_ANALYZE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(30),
    // Photo storage.
    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().min(1).default("./.data/storage"),
    /** Optional separate key for local signed URLs; otherwise derived from JWT_SECRET with a distinct label. */
    STORAGE_SIGNING_SECRET: z.string().min(32).optional(),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    S3_ENDPOINT: z.string().url().optional(),
    /** Endpoint browsers use for presigned URLs when it differs from S3_ENDPOINT (for example Docker networking). */
    S3_PUBLIC_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),
    /** Server-side encryption header for PutObject; leave unset for MinIO without KMS. */
    S3_SSE: z.enum(["AES256", "aws:kms"]).optional(),
    // Anthropic vision.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_VISION_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production") {
      if (PLACEHOLDER.test(c.DATABASE_URL)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "placeholder password in production" });
      }
      if (!c.WEB_ORIGIN.startsWith("https://")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["WEB_ORIGIN"], message: "must be https in production" });
      }
    }
    for (const o of splitOrigins(c.EMBED_ORIGINS)) {
      let ok = false;
      try {
        const u = new URL(o);
        ok = u.origin === o && (u.protocol === "https:" || (c.NODE_ENV !== "production" && u.protocol === "http:"));
      } catch {
        ok = false;
      }
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["EMBED_ORIGINS"], message: `"${o}" must be a bare origin (scheme://host[:port]), https in production` });
    }
    if (c.STORAGE_DRIVER === "s3") {
      for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!c[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "required when STORAGE_DRIVER=s3" });
        else if (c.NODE_ENV === "production" && PLACEHOLDER.test(c[k]!)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "placeholder in production" });
      }
    }
    if (c.STORAGE_SIGNING_SECRET && PLACEHOLDER.test(c.STORAGE_SIGNING_SECRET)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["STORAGE_SIGNING_SECRET"], message: "still a placeholder; generate one with: openssl rand -base64 48 (or leave unset)" });
    }
  });

const splitOrigins = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

export type Config = z.infer<typeof ConfigSchema> & {
  google: GoogleConfig | null;
  /** Parsed EMBED_ORIGINS. */
  embedOrigins: string[];
  /** ANTHROPIC_API_KEY when it is a real value, else null (analyze answers 503 ai_not_configured). */
  anthropicApiKey: string | null;
  /** Base URL for links this API hands out. */
  publicUrl: string;
};

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Google sign-in is active only when both credentials are set to non-placeholder values. */
function googleConfig(c: z.infer<typeof ConfigSchema>): GoogleConfig | null {
  const real = (v?: string) => !!v && v.trim() !== "" && !PLACEHOLDER.test(v);
  if (!real(c.GOOGLE_CLIENT_ID) || !real(c.GOOGLE_CLIENT_SECRET)) return null;
  return {
    clientId: c.GOOGLE_CLIENT_ID!,
    clientSecret: c.GOOGLE_CLIENT_SECRET!,
    redirectUri: c.GOOGLE_REDIRECT_URI ?? `http://localhost:${c.API_PORT}/auth/google/callback`,
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = ConfigSchema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const key = r.data.ANTHROPIC_API_KEY?.trim();
  return {
    ...r.data,
    google: googleConfig(r.data),
    embedOrigins: splitOrigins(r.data.EMBED_ORIGINS),
    anthropicApiKey: key && !PLACEHOLDER.test(key) ? key : null,
    publicUrl: (r.data.API_PUBLIC_URL ?? `http://localhost:${r.data.API_PORT}`).replace(/\/+$/, ""),
  };
}
