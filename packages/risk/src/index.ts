/**
 * @sentinel/risk public interface (contract). The risk-scoring-analyst owns the implementation.
 * Pure and deterministic: no I/O, no clock reads (computedAt is passed in).
 */
import type { Answer, Finding, Question, RiskResult, ScenarioInput, SiteComparison, ThreatScenario } from "@sentinel/shared";

export interface ScoringControl {
  id: string;
  title: string;
  questions: Question[];
}

export interface ScoreAssessmentInput {
  assessmentId: string;
  computedAt: string;
  scenarios: ThreatScenario[];
  inputs: ScenarioInput[];
  /** Shared controls in scope for the assessment (its pinned frameworks). */
  controls: ScoringControl[];
  answers: Answer[];
  /** Non-deleted findings; resolved findings do not reduce effectiveness. */
  findings: Finding[];
}

export interface CompareInput {
  assessmentId: string;
  siteName: string;
  clientName: string;
  completedAt: string | null;
  result: RiskResult;
  findings: Finding[];
  frameworks: string[];
  libraryVersion: string;
}

export { METHOD_VERSION, scoreAssessment, compareSites, loadScenarios, scenariosForControls } from "./engine.js";
export {
  MAX_REDUCTION,
  FINDING_CAPS,
  LEVEL_BANDS,
  LIKELIHOOD_SCALE,
  IMPACT_SCALE,
  SCENARIO_LIBRARY_VERSION,
  SCENARIO_CONTROL_LIBRARY_VERSION,
  levelFor,
  levelLabel,
  scoreAnswer,
  evaluateControl,
  type ControlEvaluation,
  type ScaleAnchor,
} from "./engine.js";
