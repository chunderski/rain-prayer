/**
 * Response schemas for the Phase 1 API (docs/api-phase1.md). Request payloads and library shapes
 * come from @sentinel/shared; these cover the list and detail views the API adds on top.
 * Optional text columns may come back as null from Postgres, hence `.nullish()`.
 */
import { z } from "zod";
import { AssessmentStatus, Question, SessionInfo, Severity } from "@sentinel/shared";

export const ApiErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export const TokenResponse = z.object({ accessToken: z.string().min(1), session: SessionInfo });
export type TokenResponse = z.infer<typeof TokenResponse>;

export const TenantChoice = z.object({ slug: z.string(), name: z.string() });
export type TenantChoice = z.infer<typeof TenantChoice>;
export const TenantRequiredDetails = z.object({ tenants: z.array(TenantChoice).min(1) });

export const FrameworkCategory = z.enum(["physical", "cyber", "hybrid"]);
export type FrameworkCategory = z.infer<typeof FrameworkCategory>;

export const FrameworkSummary = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  kind: z.string(),
  category: FrameworkCategory,
  description: z.string(),
  publisher: z.string(),
  sourceEdition: z.string(),
  version: z.string(),
  requirementCount: z.number().int(),
  controlCount: z.number().int(),
  needsReviewCount: z.number().int(),
});
export type FrameworkSummary = z.infer<typeof FrameworkSummary>;

export const Relationship = z.enum(["satisfies", "supports", "informs"]);
export type Relationship = z.infer<typeof Relationship>;

export const ControlSummary = z.object({
  id: z.string(),
  domain: z.string(),
  title: z.string(),
  objective: z.string(),
  defaultSeverity: Severity,
  assetTypes: z.array(z.string()).default([]),
  status: z.enum(["draft", "needs_review", "approved"]),
  questionCount: z.number().int(),
  mappings: z.array(z.object({ frameworkId: z.string(), requirementCode: z.string(), relationship: Relationship })),
});
export type ControlSummary = z.infer<typeof ControlSummary>;

export const ControlMappingDetail = z.object({
  frameworkId: z.string(),
  frameworkShortName: z.string(),
  requirementCode: z.string(),
  requirementTitle: z.string(),
  relationship: Relationship,
  rationale: z.string().nullish(),
});
export type ControlMappingDetail = z.infer<typeof ControlMappingDetail>;

export const ControlDetail = z.object({
  id: z.string(),
  domain: z.string(),
  title: z.string(),
  objective: z.string(),
  defaultSeverity: Severity,
  assetTypes: z.array(z.string()).default([]),
  status: z.enum(["draft", "needs_review", "approved"]),
  evidence: z.array(z.object({ type: z.string(), description: z.string() })).default([]),
  questions: z.array(Question).default([]),
  mappings: z.array(ControlMappingDetail),
});
export type ControlDetail = z.infer<typeof ControlDetail>;

export const ClientSummary = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string().nullish(),
  siteCount: z.number().int().default(0),
  createdAt: z.string(),
});
export type ClientSummary = z.infer<typeof ClientSummary>;

export const Site = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  address: z.string().nullish(),
  siteType: z.string().nullish(),
});
export type Site = z.infer<typeof Site>;

export const ClientDetail = ClientSummary.extend({
  notes: z.string().nullish(),
  siteCount: z.number().int().optional(),
  sites: z.array(Site).default([]),
});
export type ClientDetail = z.infer<typeof ClientDetail>;

export const ClientCreated = z.object({ id: z.string(), name: z.string() }).passthrough();

export const AssessmentFramework = z.object({
  frameworkId: z.string(),
  version: z.string(),
  shortName: z.string().optional(),
});

export const AssessmentSummary = z.object({
  id: z.string(),
  title: z.string(),
  status: AssessmentStatus,
  siteId: z.string(),
  siteName: z.string().nullish(),
  clientName: z.string().nullish(),
  frameworks: z.array(AssessmentFramework),
  createdAt: z.string(),
});
export type AssessmentSummary = z.infer<typeof AssessmentSummary>;

export const AssessmentDetail = AssessmentSummary.extend({
  scheduledFor: z.string().nullish(),
  controlCount: z.number().int().optional(),
  questionCount: z.number().int().optional(),
});
export type AssessmentDetail = z.infer<typeof AssessmentDetail>;

export const AssessmentCreated = z.object({ id: z.string() }).passthrough();
