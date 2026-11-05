/**
 * Response schemas for the Phase 2 field API (docs/api-phase2.md). Record payloads come from
 * @sentinel/shared (packages/shared/src/field.ts); these add the walkthrough envelope and the
 * `version` the API attaches to synced records.
 */
import { z } from "zod";
import { AiSuggestion, Answer, Area, Asset, Finding, Photo, Question, Severity, SignedUrl } from "@sentinel/shared";
import { Relationship } from "../api/schemas";

const version = { version: z.number().int().nullish() };

export const WalkthroughFramework = z.object({
  frameworkId: z.string(),
  shortName: z.string(),
  requirementCode: z.string(),
  relationship: Relationship,
});
export type WalkthroughFramework = z.infer<typeof WalkthroughFramework>;

export const WalkthroughControl = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  defaultSeverity: Severity,
  assetTypes: z.array(z.string()).default([]),
  frameworks: z.array(WalkthroughFramework).default([]),
  questions: z.array(Question),
});
export type WalkthroughControl = z.infer<typeof WalkthroughControl>;

export const WalkthroughSection = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  order: z.number(),
  domains: z.array(z.string()).default([]),
  controls: z.array(WalkthroughControl),
});
export type WalkthroughSection = z.infer<typeof WalkthroughSection>;

export const VersionedArea = Area.extend(version);
export const VersionedAnswer = Answer.extend(version);
export const VersionedAsset = Asset.extend(version);
export const VersionedFinding = Finding.extend(version);
export const VersionedPhoto = Photo.extend(version);

export const WalkthroughResponse = z.object({
  assessmentId: z.string(),
  libraryVersion: z.string(),
  sections: z.array(WalkthroughSection),
  areas: z.array(VersionedArea).default([]),
  answers: z.array(VersionedAnswer).default([]),
  findings: z.array(VersionedFinding).default([]),
  photos: z.array(VersionedPhoto).default([]),
  assets: z.array(VersionedAsset).default([]),
  assessors: z.array(z.object({ userId: z.string(), name: z.string() })).default([]),
});
export type WalkthroughResponse = z.infer<typeof WalkthroughResponse>;

/** What is cached for offline use: structure only; records live in their own stores. */
export const WalkthroughStructure = WalkthroughResponse.pick({ assessmentId: true, libraryVersion: true, sections: true, assessors: true });
export type WalkthroughStructure = z.infer<typeof WalkthroughStructure>;

export const TenantSettings = z.object({
  allowGps: z.boolean().default(false),
  aiPhotoAnalysis: z.boolean().default(true),
  aiShareContext: z.boolean().default(false),
});
export type TenantSettings = z.infer<typeof TenantSettings>;

export const Member = z.object({ userId: z.string(), email: z.string(), name: z.string(), role: z.string() });
export type Member = z.infer<typeof Member>;

export const ReviewResult = z.object({
  suggestion: AiSuggestion,
  findings: z.array(VersionedFinding),
  photo: VersionedPhoto,
});

export { AiSuggestion, SignedUrl };
