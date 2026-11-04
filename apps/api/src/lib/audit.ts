import type { Tx } from "../db/pool.js";

export interface AuditEntry {
  tenantId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

/** Appends an audit row inside the caller's tenant transaction (RLS checks tenant_id). */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, actor_email, action, entity_type, entity_id, ip, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.tenantId,
      e.actorUserId ?? null,
      e.actorEmail ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.ip?.slice(0, 64) ?? null,
      e.userAgent?.slice(0, 512) ?? null,
      JSON.stringify(e.details ?? {}),
    ],
  );
}
