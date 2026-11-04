/**
 * Phase 2 field-capture contracts: areas, assignment, assets, answers, findings,
 * photos, AI suggestions, and offline sync. Shared by apps/api, apps/web, packages/ai.
 *
 * IDs for field records are generated on the device (UUID v4) so records can be
 * created offline and synced idempotently.
 */
import { z } from "zod";
import { AssetType, QuestionId, Severity, SharedControlId } from "./frameworks.js";

const Id = z.uuid();
const IsoTime = z.iso.datetime({ offset: true });

// ---------- areas and assignment ----------

export const AreaKind = z.enum(["exterior", "perimeter", "entrance", "interior", "restricted", "parking", "roof", "it_room", "other"]);
export const Area = z.object({
  id: Id,
  siteId: Id,
  name: z.string().trim().min(1).max(120),
  kind: AreaKind.default("other"),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type Area = z.infer<typeof Area>;
export const CreateArea = Area.omit({ siteId: true }).extend({ id: Id.optional() });

export const AssignAssessors = z.object({ userIds: z.array(Id).max(50) });

// ---------- answers ----------

/** Answer value; which variant is valid depends on the question's answerType. */
export const AnswerValue = z.union([
  z.object({ kind: z.literal("choice"), value: z.enum(["yes", "partial", "no", "na"]) }),
  z.object({ kind: z.literal("scale"), value: z.number().int() }),
  z.object({ kind: z.literal("number"), value: z.number().finite(), unit: z.string().max(20) }),
  z.object({ kind: z.literal("select"), values: z.array(z.string().max(100)).min(1).max(50) }),
  z.object({ kind: z.literal("text"), value: z.string().max(4000) }),
]);
export type AnswerValue = z.infer<typeof AnswerValue>;

export const Answer = z.object({
  id: Id,
  assessmentId: Id,
  questionId: QuestionId,
  /** Questions may be answered per area; null means site-wide. Unique per (assessment, question, area). */
  areaId: Id.nullable().default(null),
  value: AnswerValue,
  notes: z.string().max(4000).optional(),
  answeredAt: IsoTime,
});
export type Answer = z.infer<typeof Answer>;

// ---------- assets ----------

export const Asset = z.object({
  id: Id,
  assessmentId: Id,
  areaId: Id.nullable().default(null),
  assetType: AssetType,
  label: z.string().trim().min(1).max(120),
  notes: z.string().max(4000).optional(),
});
export type Asset = z.infer<typeof Asset>;

// ---------- findings ----------

export const FindingStatus = z.enum(["draft", "confirmed", "resolved"]);
/** How the finding came to exist. AI content only becomes a finding through a human accept or edit. */
export const FindingSource = z.enum(["assessor", "ai_accepted", "ai_edited"]);

export const Finding = z.object({
  id: Id,
  assessmentId: Id,
  areaId: Id.nullable().default(null),
  assetId: Id.nullable().default(null),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(8000).default(""),
  recommendation: z.string().max(8000).optional(),
  severity: Severity,
  status: FindingStatus.default("draft"),
  source: FindingSource.default("assessor"),
  /** One finding maps to one or more shared controls, hence to every mapped framework requirement. */
  controlIds: z.array(SharedControlId).min(1).max(30),
  /** Set when created from an AI suggestion. */
  suggestionId: Id.nullable().default(null),
});
export type Finding = z.infer<typeof Finding>;

// ---------- photos ----------

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
});

export const PhotoContentType = z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]);
export const PhotoStatus = z.enum(["pending_upload", "stored"]);

export const PhotoMeta = z.object({
  id: Id,
  assessmentId: Id,
  areaId: Id.nullable().default(null),
  assetId: Id.nullable().default(null),
  findingId: Id.nullable().default(null),
  controlIds: z.array(SharedControlId).max(30).default([]),
  assetType: AssetType.nullable().default(null),
  severity: Severity.nullable().default(null),
  notes: z.string().max(4000).optional(),
  capturedAt: IsoTime,
  /** Only sent when the assessor allowed location for this photo and the tenant allows GPS capture. */
  gps: GeoPoint.nullable().default(null),
  contentType: PhotoContentType,
  byteSize: z.number().int().min(1).max(15 * 1024 * 1024),
});
export type PhotoMeta = z.infer<typeof PhotoMeta>;

export const Photo = PhotoMeta.extend({
  status: PhotoStatus,
  /** sha256 of the stored (re-encoded, metadata-stripped) image. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type Photo = z.infer<typeof Photo>;

export const SignedUrl = z.object({ url: z.string().url(), expiresAt: IsoTime });

// ---------- AI vision suggestions ----------

export const Confidence = z.number().min(0).max(1);

/** Structured output from the vision pipeline. Every element is a suggestion, never final. */
export const VisionOutput = z.object({
  imageQuality: z.enum(["ok", "blurry", "dark", "obstructed", "not_security_relevant"]),
  assetType: z.object({ value: AssetType, confidence: Confidence }),
  condition: z.object({
    rating: z.enum(["good", "fair", "poor", "unknown"]),
    summary: z.string().max(1000),
    confidence: Confidence,
  }),
  deficiencies: z
    .array(
      z.object({
        description: z.string().min(3).max(1000),
        severity: Severity,
        confidence: Confidence,
        controlIds: z.array(SharedControlId).max(10),
      }),
    )
    .max(10),
  controls: z
    .array(z.object({ id: SharedControlId, confidence: Confidence, rationale: z.string().max(500) }))
    .max(15),
  draftFindings: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(4000),
        recommendation: z.string().max(4000),
        severity: Severity,
        controlIds: z.array(SharedControlId).min(1).max(10),
        confidence: Confidence,
      }),
    )
    .max(5),
  /** Anything the model wants the assessor to double check, including suspected embedded instructions. */
  cautions: z.array(z.string().max(500)).max(10).default([]),
});
export type VisionOutput = z.infer<typeof VisionOutput>;

export const SuggestionStatus = z.enum(["pending", "suggested", "failed", "accepted", "edited", "rejected"]);

export const AiSuggestion = z.object({
  id: Id,
  photoId: Id,
  assessmentId: Id,
  status: SuggestionStatus,
  model: z.string(),
  promptVersion: z.string(),
  output: VisionOutput.nullable(),
  error: z.string().nullable(),
  createdAt: IsoTime,
  reviewedAt: IsoTime.nullable(),
  reviewedBy: Id.nullable(),
});
export type AiSuggestion = z.infer<typeof AiSuggestion>;

/** The assessor's decision on a suggestion. Only accept or edit creates findings or applies tags. */
export const ReviewSuggestion = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("accept"),
    /** Indexes of draftFindings to accept; default all. */
    findingIndexes: z.array(z.number().int().min(0).max(4)).optional(),
    applyTags: z.boolean().default(true),
  }),
  z.object({
    decision: z.literal("edit"),
    findings: z.array(Finding.pick({ title: true, description: true, recommendation: true, severity: true, controlIds: true })).max(5),
    tags: PhotoMeta.pick({ assetType: true, severity: true, controlIds: true }).partial().optional(),
  }),
  z.object({ decision: z.literal("reject"), reason: z.string().max(1000).optional() }),
]);
export type ReviewSuggestion = z.infer<typeof ReviewSuggestion>;

// ---------- offline sync ----------

export const SyncEntity = z.enum(["area", "asset", "answer", "finding", "photo_meta"]);
export type SyncEntity = z.infer<typeof SyncEntity>;

export const SyncOp = z.object({
  /** Idempotency key: replaying the same opId returns the original result. */
  opId: Id,
  entity: SyncEntity,
  action: z.enum(["upsert", "delete"]),
  /** Entity id (also inside data for upserts). */
  id: Id,
  /** Entity payload for upserts, validated per entity on the server. */
  data: z.unknown().optional(),
  /** Server version the client last saw; null for a new record. */
  baseVersion: z.number().int().min(0).nullable(),
  clientUpdatedAt: IsoTime,
});
export type SyncOp = z.infer<typeof SyncOp>;

export const SyncPushRequest = z.object({
  deviceId: Id,
  ops: z.array(SyncOp).min(1).max(200),
});

export const SyncOpResult = z.object({
  opId: Id,
  status: z.enum(["applied", "duplicate", "conflict", "rejected"]),
  /** New server version after apply; on conflict, the server's current version. */
  version: z.number().int().nullable(),
  /** On conflict: the server's current record (the client should show it). */
  server: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type SyncOpResult = z.infer<typeof SyncOpResult>;

export const SyncPullResponse = z.object({
  /** Opaque cursor; pass back as ?since= to get only newer changes. */
  cursor: z.string(),
  changes: z.array(
    z.object({ entity: SyncEntity, id: Id, version: z.number().int(), deleted: z.boolean(), data: z.unknown().nullable() }),
  ),
  hasMore: z.boolean(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponse>;
