/** API contracts shared by apps/api and apps/web. */
import { z } from "zod";
import { FrameworkId } from "./frameworks.js";

/** client_viewer is a read-only login for one client (Phase 4). It ranks below viewer, so every
 * route guarded by hasRole(..., "viewer") refuses it; only the client portal routes admit it. */
export const Role = z.enum(["owner", "admin", "assessor", "viewer", "client_viewer"]);
export type Role = z.infer<typeof Role>;

/** Higher number means more privilege. */
export const ROLE_RANK: Record<Role, number> = { client_viewer: 0, viewer: 1, assessor: 2, admin: 3, owner: 4 };
export const hasRole = (actual: Role, required: Role) => ROLE_RANK[actual] >= ROLE_RANK[required];

export const Uuid = z.string().uuid();

export const LoginRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  /** Optional when the user belongs to one tenant. */
  tenantSlug: z.string().max(64).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionInfo = z.object({
  user: z.object({ id: Uuid, email: z.string(), name: z.string() }),
  tenant: z.object({ id: Uuid, slug: z.string(), name: z.string() }),
  role: Role,
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const CreateClient = z.object({
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(100).optional(),
  notes: z.string().max(4000).optional(),
});
export type CreateClient = z.infer<typeof CreateClient>;

export const CreateSite = z.object({
  clientId: Uuid,
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).optional(),
  siteType: z.string().trim().max(100).optional(),
});
export type CreateSite = z.infer<typeof CreateSite>;

export const FrameworkSelection = z.object({ frameworkId: FrameworkId, version: z.string() });
export type FrameworkSelection = z.infer<typeof FrameworkSelection>;

export const CreateAssessment = z.object({
  siteId: Uuid,
  title: z.string().trim().min(1).max(200),
  frameworks: z.array(FrameworkSelection).min(1, "Pick at least one framework").max(20),
  scheduledFor: z.string().date().optional(),
});
export type CreateAssessment = z.infer<typeof CreateAssessment>;

export const AssessmentStatus = z.enum(["draft", "in_progress", "in_review", "complete", "archived"]);
export type AssessmentStatus = z.infer<typeof AssessmentStatus>;
