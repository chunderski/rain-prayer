/**
 * Per-user fixed-window rate limits for data routes (QA R-9). Runs after authentication, so the key
 * is the verified user id (never a client-supplied value). In-memory: correct for one API instance;
 * a multi-instance deployment needs a shared store (documented in README).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

export interface UserLimiter {
  (req: FastifyRequest, reply: FastifyReply): Promise<void>;
  reset(): void;
}

export function createUserLimiter(name: string, max: number, windowMs: number): UserLimiter {
  const buckets = new Map<string, { count: number; start: number }>();
  let lastSweep = Date.now();
  const fn = (async (req: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
      lastSweep = now;
    }
    const key = req.auth?.userId ? `u:${req.auth.userId}` : `ip:${req.ip}`;
    let b = buckets.get(key);
    if (!b || now - b.start >= windowMs) {
      b = { count: 0, start: now };
      buckets.set(key, b);
    }
    b.count++;
    const resetSec = Math.ceil((b.start + windowMs - now) / 1000);
    reply.header("x-ratelimit-limit", max);
    reply.header("x-ratelimit-remaining", Math.max(0, max - b.count));
    if (b.count > max) {
      reply.header("retry-after", resetSec);
      throw new AppError(429, "rate_limited", `Too many ${name} requests; try again in ${resetSec} seconds`);
    }
  }) as UserLimiter;
  fn.reset = () => buckets.clear();
  return fn;
}
