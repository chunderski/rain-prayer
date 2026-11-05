// Placeholder until the risk-scoring-analyst lands the implementation.
import type { RiskResult, SiteComparison, ThreatScenario } from "@sentinel/shared";
import type { CompareInput, ScoreAssessmentInput } from "./index.js";
export const METHOD_VERSION = "0.0.0";
const todo = (): never => { throw new Error("risk engine not implemented yet"); };
export function scoreAssessment(_i: ScoreAssessmentInput): RiskResult { return todo(); }
export function compareSites(_i: CompareInput[]): SiteComparison { return todo(); }
export function loadScenarios(): ThreatScenario[] { return todo(); }
/** Scenarios with at least one mitigation among the given control ids. */
export function scenariosForControls(_s: ThreatScenario[], _controlIds: string[]): ThreatScenario[] { return todo(); }
