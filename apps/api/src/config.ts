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
  });

export type Config = z.infer<typeof ConfigSchema> & { google: GoogleConfig | null };

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
  return { ...r.data, google: googleConfig(r.data) };
}
