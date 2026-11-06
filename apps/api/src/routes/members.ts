/**
 * Phase 4 members: list, invite (single-use setup link, D-082), and role, client, or status changes.
 * Rules: only owners create or change owners and admins; the last active owner cannot be demoted or
 * disabled; client_viewer memberships always carry a client of this workspace (D-081).
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateMember, MemberRole, Uuid, type Member, type Role } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { authOf, sha256, type AuthContext } from "../lib/auth.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { reqMeta } from "./auth.js";
import type { FieldRouteDeps } from "./deps.js";

export const SETUP_TOKEN_TTL_HOURS = 72;
const PRIVILEGED: Role[] = ["owner", "admin"];

const MEMBER_SQL = `SELECT m.user_id AS "userId", u.email, u.name, m.role, m.client_id AS "clientId", c.name AS "clientName", m.status
  FROM membership m JOIN app_user u ON u.id = m.user_id LEFT JOIN client c ON c.id = m.client_id`;

async function memberOf(tx: Tx, userId: string): Promise<Member | null> {
  const { rows } = await tx.query<Member>(`${MEMBER_SQL} WHERE m.user_id = $1`, [userId]);
  return rows[0] ?? null;
}

async function requireClient(tx: Tx, clientId: string) {
  const c = await tx.query("SELECT 1 FROM client WHERE id = $1", [clientId]);
  if (!c.rowCount) throw new AppError(400, "unknown_client", "The client does not exist in this workspace");
}

const ownerOnly = (a: AuthContext, what: string) => {
  if (a.role !== "owner") throw new AppError(403, "forbidden", `Only an owner can ${what}`);
};

export async function memberRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters } = deps;
  const role = guard(cfg, db, limiters);

  app.get("/members", role("admin"), async (req) =>
    db.withTenant(authOf(req).tenantId, async (tx) => (await tx.query<Member>(`${MEMBER_SQL} ORDER BY lower(u.name), u.id`)).rows),
  );

  app.post("/members", role("admin"), async (req, reply) => {
    const a = authOf(req);
    const body = parse(CreateMember, req.body);
    if (PRIVILEGED.includes(body.role)) ownerOnly(a, "add owners or admins");
    const token = randomBytes(32).toString("base64url");
    const out = await db.withTenant(a.tenantId, async (tx) => {
      if (body.clientId) await requireClient(tx, body.clientId);
      const u = (await tx.query<{ user_id: string; created: boolean }>("SELECT * FROM member_invite_user($1, $2)", [body.email.toLowerCase(), body.name])).rows[0]!;
      const existing = (await tx.query<{ status: string; role: Role }>("SELECT status, role FROM membership WHERE user_id = $1 FOR UPDATE", [u.user_id])).rows[0];
      if (existing && existing.status !== "invited") throw new AppError(409, "member_exists", "This person is already a member of this workspace");
      if (existing) {
        // Re-invite: a fresh link replaces any earlier one.
        if (PRIVILEGED.includes(existing.role)) ownerOnly(a, "change owners or admins");
        await tx.query("UPDATE membership SET role = $2, client_id = $3, updated_at = now() WHERE user_id = $1", [u.user_id, body.role, body.clientId]);
        await tx.query("DELETE FROM member_setup_token WHERE user_id = $1", [u.user_id]);
      } else {
        await tx.query("INSERT INTO membership (tenant_id, user_id, role, client_id, status) VALUES ($1, $2, $3, $4, 'invited')", [a.tenantId, u.user_id, body.role, body.clientId]);
      }
      const exp = await tx.query<{ expires_at: Date }>(
        `INSERT INTO member_setup_token (token_hash, tenant_id, user_id, expires_at, created_by)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5) RETURNING expires_at`,
        [sha256(token), a.tenantId, u.user_id, SETUP_TOKEN_TTL_HOURS, a.userId],
      );
      await audit(tx, {
        tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: existing ? "member.reinvite" : "member.create",
        entityType: "user", entityId: u.user_id, ...reqMeta(req),
        details: { email: body.email.toLowerCase(), role: body.role, clientId: body.clientId, newAccount: u.created },
      });
      return { member: (await memberOf(tx, u.user_id))!, expiresAt: exp.rows[0]!.expires_at.toISOString() };
    });
    // The fragment keeps the token out of server and proxy logs; it is shown once, to this admin only.
    return reply.code(201).send({ member: out.member, setupUrl: `${cfg.WEB_ORIGIN}/setup#token=${token}`, expiresAt: out.expiresAt });
  });

  const PatchMember = z
    .object({ role: MemberRole.optional(), clientId: Uuid.nullable().optional(), status: z.enum(["active", "disabled"]).optional() })
    .strict();
  app.patch("/members/:userId", role("admin"), async (req) => {
    const a = authOf(req);
    const { userId } = parse(z.object({ userId: Uuid }), req.params);
    const body = parse(PatchMember, req.body ?? {});
    return db.withTenant(a.tenantId, async (tx) => {
      // Lock every owner row first so two concurrent demotions cannot both pass the last-owner check.
      const owners = (await tx.query<{ user_id: string }>("SELECT user_id FROM membership WHERE role = 'owner' AND status = 'active' ORDER BY user_id FOR UPDATE")).rows;
      const cur = (await tx.query<{ role: Role; client_id: string | null; status: string }>("SELECT role, client_id, status FROM membership WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
      if (!cur) throw notFound("Member");
      const nextRole = body.role ?? cur.role;
      if (PRIVILEGED.includes(cur.role) && (body.role !== undefined && body.role !== cur.role || body.status !== undefined && body.status !== cur.status)) {
        ownerOnly(a, "change owners or admins");
      }
      if (PRIVILEGED.includes(nextRole) && nextRole !== cur.role) ownerOnly(a, "make someone an owner or admin");
      let nextClient = body.clientId !== undefined ? body.clientId : cur.client_id;
      if (nextRole !== "client_viewer" && body.clientId === undefined) nextClient = null;
      if ((nextRole === "client_viewer") !== (nextClient !== null)) {
        throw new AppError(400, "validation_error", "Request validation failed", [{ path: "clientId", message: "clientId is required for client_viewer and only for it" }]);
      }
      if (nextClient) await requireClient(tx, nextClient);
      let nextStatus = cur.status;
      if (body.status && body.status !== cur.status) {
        if (cur.status === "invited" && body.status === "active") {
          throw new AppError(409, "invite_pending", "This member has not completed setup yet; share a new setup link instead");
        }
        nextStatus = body.status;
      }
      const isLastOwner = cur.role === "owner" && cur.status === "active" && owners.length <= 1;
      if (isLastOwner && (nextRole !== "owner" || nextStatus !== "active")) {
        throw new AppError(409, "last_owner", "The workspace needs at least one active owner; make someone else an owner first");
      }
      await tx.query("UPDATE membership SET role = $2, client_id = $3, status = $4, updated_at = now() WHERE user_id = $1", [userId, nextRole, nextClient, nextStatus]);
      if (nextStatus === "disabled" && cur.status !== "disabled") {
        // Disabled members lose their sessions at once (access tokens already fail the per-request membership check).
        await tx.query("UPDATE refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
      }
      if (nextStatus === "disabled") await tx.query("UPDATE member_setup_token SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
      await audit(tx, {
        tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "member.update", entityType: "user", entityId: userId, ...reqMeta(req),
        details: { from: { role: cur.role, clientId: cur.client_id, status: cur.status }, to: { role: nextRole, clientId: nextClient, status: nextStatus } },
      });
      return memberOf(tx, userId);
    });
  });
}
