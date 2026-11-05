/**
 * Phase 3 contracts: risk scoring, comparison, dashboard, report narrative, and Google export.
 * The scoring engine lives in packages/risk; these are the shapes the API returns.
 */
import { z } from "zod";
import { ControlDomain, Severity, SharedControlId } from "./frameworks.js";

const Id = z.uuid();
const IsoTime = z.iso.datetime({ offset: true });

export const RiskLevel = z.enum(["very_low", "low", "medium", "high", "very_high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** A threat scenario from the scenario library (packages/risk/data/scenarios.json). */
export const ThreatScenario = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(3).max(80),
  description: z.string().min(10).max(600),
  category: z.enum(["physical", "cyber", "hybrid"]),
  /** Shared controls that mitigate this scenario, with relative weight (1 low, 2 medium, 3 high). */
  mitigations: z.array(z.object({ controlId: SharedControlId, weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) })).min(1),
  /** Domains used when a mitigating control is not in scope (fallback relevance). */
  domains: z.array(ControlDomain).min(1),
  references: z.array(z.string()).default([]),
});
export type ThreatScenario = z.infer<typeof ThreatScenario>;

/** Assessor's inherent risk inputs per scenario (1 to 5 anchored scales; see docs/risk-method.md). */
export const ScenarioInput = z.object({
  scenarioId: z.string(),
  likelihood: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  rationale: z.string().max(2000).optional(),
  /** Scenario judged not applicable to this site. */
  excluded: z.boolean().default(false),
});
export type ScenarioInput = z.infer<typeof ScenarioInput>;

export const PutScenarioInputs = z.object({ scenarios: z.array(ScenarioInput).max(50) });

export const ControlContribution = z.object({
  controlId: SharedControlId,
  title: z.string(),
  weight: z.number(),
  /** 0..1, or null when no scored answers exist (unknown). */
  effectiveness: z.number().min(0).max(1).nullable(),
  /** Plain-language evidence, e.g. "2 of 3 questions answered Yes; 1 high finding open". */
  evidence: z.string(),
  findingIds: z.array(Id),
});

export const ScenarioResult = z.object({
  scenarioId: z.string(),
  name: z.string(),
  category: z.enum(["physical", "cyber", "hybrid"]),
  inherent: z.object({ likelihood: z.number(), impact: z.number(), score: z.number(), level: RiskLevel }),
  controlEffectiveness: z.object({
    /** 0..1 weighted effectiveness of the mitigating controls in scope. */
    value: z.number().min(0).max(1),
    /** 0..1 share of weighted mitigations that had scored evidence; low coverage lowers confidence. */
    coverage: z.number().min(0).max(1),
    contributors: z.array(ControlContribution),
  }),
  residual: z.object({ score: z.number(), level: RiskLevel }),
  confidence: z.enum(["low", "medium", "high"]),
  /** Ordered plain-English sentences explaining the result, suitable for a client report. */
  explanation: z.array(z.string()).min(1),
});
export type ScenarioResult = z.infer<typeof ScenarioResult>;

export const RiskResult = z.object({
  methodVersion: z.string(),
  assessmentId: Id,
  computedAt: IsoTime,
  scenarios: z.array(ScenarioResult),
  overall: z.object({ inherent: z.number(), residual: z.number(), level: RiskLevel, explanation: z.array(z.string()) }),
  /** Scenarios with no inputs yet. */
  missingInputs: z.array(z.string()),
});
export type RiskResult = z.infer<typeof RiskResult>;

export const SiteComparison = z.object({
  methodVersion: z.string(),
  sites: z.array(
    z.object({
      assessmentId: Id,
      siteName: z.string(),
      clientName: z.string(),
      completedAt: IsoTime.nullable(),
      overall: RiskResult.shape.overall,
      byScenario: z.record(z.string(), z.object({ inherent: z.number(), residual: z.number(), level: RiskLevel })),
      findingsBySeverity: z.record(Severity, z.number().int()),
    }),
  ),
  /** Notes on comparability, e.g. different frameworks or library versions. */
  caveats: z.array(z.string()),
});
export type SiteComparison = z.infer<typeof SiteComparison>;

// ---------- report narrative (AI drafted, human approved) ----------

export const NarrativeSection = z.enum(["executive_summary", "methodology", "key_findings", "recommendations"]);
export const Narrative = z.object({
  assessmentId: Id,
  section: NarrativeSection,
  text: z.string().max(20_000),
  status: z.enum(["ai_draft", "edited", "approved"]),
  model: z.string().nullable(),
  updatedAt: IsoTime,
  approvedBy: Id.nullable(),
});
export type Narrative = z.infer<typeof Narrative>;
export const PutNarrative = z.object({ text: z.string().max(20_000), approve: z.boolean().default(false) });

// ---------- Google export ----------

export const ExportTarget = z.enum(["docs", "sheets", "drive"]);
export const ExportJob = z.object({
  id: Id,
  assessmentId: Id,
  targets: z.array(ExportTarget).min(1),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  /** Per-target result links (Google URLs) or error messages. */
  results: z.array(z.object({ target: ExportTarget, status: z.enum(["pending", "succeeded", "failed"]), url: z.string().url().nullable(), error: z.string().nullable() })),
  createdAt: IsoTime,
  finishedAt: IsoTime.nullable(),
});
export type ExportJob = z.infer<typeof ExportJob>;
export const CreateExport = z.object({ targets: z.array(ExportTarget).min(1).max(3) });
