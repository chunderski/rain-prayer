/**
 * Framework library contract.
 *
 * The library has three layers:
 *  1. Shared controls: one place for each thing an assessor can observe or verify.
 *     Each shared control owns its objective assessment questions.
 *  2. Framework versions: the requirements of an external framework (NIST CSF 2.0
 *     subcategories, CPTED principles, CARVER criteria, ...), with citations.
 *  3. Crosswalk: maps shared controls to framework requirements, so one finding
 *     against a shared control counts toward every mapped framework.
 *
 * All library data is versioned. Changing content means publishing a new version.
 */
import { z } from "zod";

export const SEMVER = /^\d+\.\d+\.\d+$/;

/** Stable id formats. */
export const FrameworkId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "framework id: lowercase kebab-case");
export const SharedControlId = z.string().regex(/^SC-[A-Z]{2,5}-\d{3}$/, "shared control id: SC-<DOMAIN>-<NNN>");
export const QuestionId = z.string().regex(/^Q-[A-Z]{2,5}-\d{3}-\d{2}$/, "question id: Q-<DOMAIN>-<NNN>-<NN>");

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

/** Domains group shared controls; the code is the middle part of the shared control id. */
export const ControlDomain = z.enum([
  "PER", // perimeter
  "ACC", // access control
  "VSS", // video surveillance
  "IDS", // intrusion detection and alarms
  "LCK", // locks and hardware
  "LGT", // lighting
  "GRD", // guard operations
  "POL", // physical security policy and procedures
  "ENV", // environmental design (CPTED oriented)
  "GOV", // cyber governance
  "IDN", // cyber asset and risk identification
  "PRT", // cyber protection
  "DET", // cyber detection
  "RSP", // cyber response
  "RCV", // cyber recovery
  "CRY", // cryptography and PQC
]);
export type ControlDomain = z.infer<typeof ControlDomain>;

export const AssetType = z.enum([
  "camera",
  "door",
  "gate",
  "lock",
  "card_reader",
  "alarm_panel",
  "sensor",
  "fence",
  "barrier",
  "lighting",
  "window",
  "signage",
  "landscaping",
  "parking",
  "guard_post",
  "server_room",
  "network_device",
  "server",
  "endpoint",
  "application",
  "cryptographic_asset",
  "document",
  "other",
]);
export type AssetType = z.infer<typeof AssetType>;

/** Citation for a control or requirement. `verified` is false when wording or section could not be checked against the source. */
export const Citation = z.object({
  source: z.string().min(3), // e.g. "NIST CSWP 29 (CSF 2.0)"
  section: z.string().min(1), // e.g. "PR.AA-01" or "Clause 5.2"
  url: z.string().url().optional(),
  verified: z.boolean(),
  note: z.string().optional(),
});
export type Citation = z.infer<typeof Citation>;

export const AnswerType = z.enum([
  "yes_no_na", // yes | no | na
  "yes_partial_no_na", // yes | partial | no | na
  "scale", // integer within scale.min..scale.max with anchored descriptions
  "number", // numeric measurement with unit
  "single_select",
  "multi_select",
  "text", // free text; never scored
]);
export type AnswerType = z.infer<typeof AnswerType>;

export const ScaleAnchor = z.object({ value: z.number().int(), label: z.string().min(1), description: z.string().min(1) });

export const AnswerOption = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  /** 0..1 contribution to control effectiveness; omit for unscored options. */
  score: z.number().min(0).max(1).optional(),
});

export const Question = z
  .object({
    id: QuestionId,
    text: z.string().min(10),
    answerType: AnswerType,
    /** Which answer indicates the control is in place (for yes/no types). Defaults to "yes". */
    compliantAnswer: z.enum(["yes", "no"]).optional(),
    options: z.array(AnswerOption).optional(),
    scale: z.object({ min: z.number().int(), max: z.number().int(), anchors: z.array(ScaleAnchor).min(2) }).optional(),
    unit: z.string().optional(),
    /** Plain-language help for the assessor: how to check, what counts as yes. */
    guidance: z.string().min(10),
    /** Whether a photo is expected as evidence when the answer is non-compliant. */
    photoOnDeficiency: z.boolean().default(false),
  })
  .superRefine((q, ctx) => {
    if ((q.answerType === "single_select" || q.answerType === "multi_select") && !q.options?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${q.id}: select questions need options` });
    }
    if (q.answerType === "scale" && !q.scale) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${q.id}: scale questions need a scale` });
    }
    if (q.answerType === "number" && !q.unit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${q.id}: number questions need a unit` });
    }
  });
export type Question = z.infer<typeof Question>;

export const EvidenceType = z.enum(["photo", "document", "interview", "observation", "configuration", "log", "test"]);

export const SharedControl = z.object({
  id: SharedControlId,
  domain: ControlDomain,
  title: z.string().min(3),
  /** What "in place" looks like, written as a testable statement. */
  objective: z.string().min(10),
  assetTypes: z.array(AssetType).default([]),
  defaultSeverity: Severity,
  evidence: z.array(z.object({ type: EvidenceType, description: z.string().min(5) })).min(1),
  questions: z.array(Question).min(1),
  /** Sources this control's wording or rationale is drawn from (not framework mappings; those live in the crosswalk). */
  references: z.array(Citation).default([]),
  status: z.enum(["draft", "needs_review", "approved"]),
});
export type SharedControl = z.infer<typeof SharedControl>;

export const SharedControlLibrary = z.object({
  libraryVersion: z.string().regex(SEMVER),
  domain: ControlDomain,
  controls: z.array(SharedControl).min(1),
});
export type SharedControlLibrary = z.infer<typeof SharedControlLibrary>;

export const FrameworkKind = z.enum([
  "control_framework", // NIST CSF 2.0, ISO 27001: requirements an organization meets
  "design_principles", // CPTED: principles a site design is assessed against
  "target_analysis", // CARVER: criteria used to score targets or assets
  "assessment_checklist", // general physical security assessment
  "readiness_model", // PQC readiness
]);

export const Requirement = z.object({
  /** Code as used by the source (e.g. "PR.AA-01"), or a Sentinel code when the source has none (prefixed "SA-"). */
  code: z.string().min(1),
  title: z.string().min(1),
  /** Official text when public domain (e.g. NIST), otherwise a paraphrase flagged in citation.note. */
  text: z.string().min(1),
  /** Hierarchy: e.g. function > category > subcategory. */
  level: z.string().min(1),
  parentCode: z.string().optional(),
  citation: Citation,
  status: z.enum(["verified", "needs_review"]),
  /** For target_analysis frameworks: scoring scale used for this criterion. */
  scale: z.object({ min: z.number().int(), max: z.number().int(), anchors: z.array(ScaleAnchor).min(2) }).optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const FrameworkVersion = z.object({
  id: FrameworkId,
  name: z.string().min(2),
  shortName: z.string().min(2),
  version: z.string().regex(SEMVER), // Sentinel library version of this framework file
  sourceEdition: z.string().min(1), // e.g. "2.0 (February 26, 2024)"
  publisher: z.string().min(2),
  kind: FrameworkKind,
  category: z.enum(["physical", "cyber", "hybrid"]),
  description: z.string().min(10),
  sources: z.array(Citation).min(1),
  levels: z.array(z.string()).min(1), // ordered hierarchy names, top first
  requirements: z.array(Requirement).min(1),
});
export type FrameworkVersion = z.infer<typeof FrameworkVersion>;

export const CrosswalkEntry = z.object({
  sharedControlId: SharedControlId,
  frameworkId: FrameworkId,
  requirementCode: z.string().min(1),
  /** satisfies: control fully addresses requirement; supports: partial; informs: evidence feeds an analysis (e.g. CARVER scoring). */
  relationship: z.enum(["satisfies", "supports", "informs"]),
  rationale: z.string().min(5),
});
export type CrosswalkEntry = z.infer<typeof CrosswalkEntry>;

export const Crosswalk = z.object({
  libraryVersion: z.string().regex(SEMVER),
  entries: z.array(CrosswalkEntry).min(1),
});
export type Crosswalk = z.infer<typeof Crosswalk>;
