import type { FastifyRequest } from "fastify";
import type { VisionClient } from "@sentinel/ai";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { fieldCtx, runAfterCommit, type FieldCtx } from "../field/context.js";
import type { Limiters } from "../lib/access.js";
import { authOf } from "../lib/auth.js";
import type { WalkthroughDef } from "../lib/walkthrough.js";
import type { ObjectStorage } from "../storage/index.js";
import type { RiskService } from "../risk/service.js";

export interface FieldRouteDeps {
  cfg: Config;
  db: Db;
  limiters: Limiters;
  storage: ObjectStorage;
  walkthrough: WalkthroughDef | null;
  /** Returns the vision client, or null when AI is not configured (no real ANTHROPIC_API_KEY). */
  vision: () => VisionClient | null;
  risk: RiskService;
}

/** Runs fn in the caller's tenant transaction with a field context; runs after-commit actions. */
export async function inField<T>(db: Db, req: FastifyRequest, fn: (ctx: FieldCtx) => Promise<T>): Promise<T> {
  const auth = authOf(req);
  let ctx!: FieldCtx;
  const result = await db.withTenant(auth.tenantId, async (tx) => {
    ctx = fieldCtx(tx, auth, req);
    return fn(ctx);
  });
  await runAfterCommit(ctx, (err) => req.log.warn({ err }, "after-commit action failed"));
  return result;
}
