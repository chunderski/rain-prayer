/** Route options combining authentication, minimum role, and a per-user rate limit. */
import type { Role } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { requireRole } from "./auth.js";
import { createUserLimiter, type UserLimiter } from "./ratelimit.js";

export interface Limiters {
  data: UserLimiter;
  sync: UserLimiter;
  analyze: UserLimiter;
}

export function createLimiters(cfg: Config): Limiters {
  const win = cfg.DATA_RATE_LIMIT_WINDOW_SECONDS * 1000;
  return {
    data: createUserLimiter("data", cfg.DATA_RATE_LIMIT_MAX, win),
    sync: createUserLimiter("sync", cfg.SYNC_RATE_LIMIT_MAX, win),
    analyze: createUserLimiter("photo analysis", cfg.AI_ANALYZE_RATE_LIMIT_PER_HOUR, 3_600_000),
  };
}

export function guard(cfg: Config, db: Db, limiters: Limiters) {
  /** Default limiter is `data`; pass others (for example sync) to replace it. */
  return (min: Role, ...limits: UserLimiter[]) => ({
    preHandler: [requireRole(cfg, db, min), ...(limits.length ? limits : [limiters.data])],
  });
}
