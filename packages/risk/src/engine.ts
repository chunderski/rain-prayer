/**
 * Sentinel risk method, version risk-method@1.0.0. The method is documented in docs/risk-method.md;
 * keep the two in step and bump METHOD_VERSION whenever a number this file produces would change.
 *
 * Pure and deterministic: no I/O beyond the bundled scenario JSON, no clock, no randomness.
 */
import { z } from "zod";
import {
  ThreatScenario as ThreatScenarioSchema,
  type Answer,
  type Finding,
  type Question,
  type RiskLevel,
  type RiskResult,
  type ScenarioInput,
  type ScenarioResult,
  type Severity,
  type SiteComparison,
  type ThreatScenario,
} from "@sentinel/shared";
import type { CompareInput, ScoreAssessmentInput, ScoringControl } from "./index.js";
import scenarioFile from "../data/scenarios.json" with { type: "json" };

export const METHOD_VERSION = "risk-method@1.0.0";

/** Controls can remove at most this share of inherent risk (see docs/risk-method.md, "Why 80 percent"). */
export const MAX_REDUCTION = 0.8;

/** Highest effectiveness a control can have while an open finding of this severity is recorded against it. */
export const FINDING_CAPS: Readonly<Record<Severity, number>> = { critical: 0, high: 0.25, medium: 0.5, low: 0.75, info: 1 };

/** Risk level bands on the 1 to 25 scale; a score belongs to the first band whose `below` it is under. */
export const LEVEL_BANDS: ReadonlyArray<{ level: RiskLevel; label: string; from: number; below: number }> = [
  { level: "very_low", label: "very low", from: 0, below: 4 },
  { level: "low", label: "low", from: 4, below: 7 },
  { level: "medium", label: "medium", from: 7, below: 13 },
  { level: "high", label: "high", from: 13, below: 20 },
  { level: "very_high", label: "very high", from: 20, below: Infinity },
];

export interface ScaleAnchor {
  value: 1 | 2 | 3 | 4 | 5;
  label: string;
  description: string;
}

export const LIKELIHOOD_SCALE: readonly ScaleAnchor[] = [
  { value: 1, label: "Rare", description: "Not expected in the next 5 years. No history at this site, nearby, or at comparable sites, and no specific intent known." },
  { value: 2, label: "Unlikely", description: "Could happen within 5 years. Isolated history in the area or sector, little known intent toward this site." },
  { value: 3, label: "Possible", description: "Could happen within 1 to 3 years. Has happened at comparable sites or nearby, or the site is a plausible target." },
  { value: 4, label: "Likely", description: "Expected within the next year. Has happened at this site or close by recently, or there are known threats." },
  { value: 5, label: "Almost certain", description: "Expected several times a year or already happening. Recurring incidents or active, specific threats." },
];

export const IMPACT_SCALE: readonly ScaleAnchor[] = [
  { value: 1, label: "Negligible", description: "No injury. Loss absorbed in the normal operating budget. Disruption of a few hours at most. No sensitive data involved." },
  { value: 2, label: "Minor", description: "First aid injury. Loss noticeable but within a department's budget. Disruption under 1 day. Internal data exposed, no notification duty." },
  { value: 3, label: "Moderate", description: "Injury needing medical treatment. Loss needing management approval. Disruption of 1 to 3 days. Limited sensitive data exposed; local attention." },
  { value: 4, label: "Major", description: "Serious injury. Significant financial loss. Disruption up to 2 weeks. Regulated data breach requiring notification; regional attention." },
  { value: 5, label: "Severe", description: "Loss of life. Loss threatening the organization's viability. Prolonged shutdown. Large regulated breach; national attention or regulatory action." },
];

// ---------- scenario library ----------

const ScenarioFile = z.object({
  scenarioLibraryVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  methodVersion: z.string(),
  controlLibraryVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  notes: z.string().optional(),
  scenarios: z.array(ThreatScenarioSchema).min(1),
});

/** Version of data/scenarios.json. */
export const SCENARIO_LIBRARY_VERSION: string = scenarioFile.scenarioLibraryVersion;
/** Control library version the scenario mitigations were checked against. */
export const SCENARIO_CONTROL_LIBRARY_VERSION: string = scenarioFile.controlLibraryVersion;

/** The bundled scenario library, validated with the shared ThreatScenario schema. Returns a fresh copy each call. */
export function loadScenarios(): ThreatScenario[] {
  return ScenarioFile.parse(scenarioFile).scenarios;
}

/** Scenarios with at least one mitigation among the given control ids, in library order. */
export function scenariosForControls(scenarios: ThreatScenario[], controlIds: string[]): ThreatScenario[] {
  const ids = new Set(controlIds);
  return scenarios.filter((s) => s.mitigations.some((m) => ids.has(m.controlId)));
}

// ---------- helpers ----------

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const pct = (n: number) => `${Math.round(n * 100)}%`;
const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];
const sevRank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const domainOf = (controlId: string) => controlId.split("-")[1] ?? "";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const trimEnd = (s: string) => s.trim().replace(/[.;:,\s]+$/, "");

export function levelFor(score: number): RiskLevel {
  return (LEVEL_BANDS.find((b) => score < b.below) ?? LEVEL_BANDS[LEVEL_BANDS.length - 1]!).level;
}
export function levelLabel(level: RiskLevel): string {
  return LEVEL_BANDS.find((b) => b.level === level)!.label;
}

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

// ---------- answers ----------

type AnswerScore = { kind: "scored"; score: number } | { kind: "na" } | { kind: "unscored" };

/**
 * Score one answer against its question, on 0..1.
 * yes/no types: compliant answer 1, partial 0.5, the other answer 0, N/A excluded.
 * scale: (value - min) / (max - min). select: mean of the library's option scores.
 * number and text: never scored (the library does not say which direction is better or what target applies).
 */
export function scoreAnswer(q: Question, v: Answer["value"]): AnswerScore {
  if (v.kind === "choice" && v.value === "na") return { kind: "na" };
  switch (q.answerType) {
    case "yes_no_na":
    case "yes_partial_no_na": {
      if (v.kind !== "choice") return { kind: "unscored" };
      if (v.value === "partial") return { kind: "scored", score: 0.5 };
      const compliant = q.compliantAnswer ?? "yes";
      return { kind: "scored", score: v.value === compliant ? 1 : 0 };
    }
    case "scale": {
      if (v.kind !== "scale" || !q.scale || q.scale.max <= q.scale.min) return { kind: "unscored" };
      const s = (v.value - q.scale.min) / (q.scale.max - q.scale.min);
      return { kind: "scored", score: Math.min(1, Math.max(0, s)) };
    }
    case "single_select":
    case "multi_select": {
      if (v.kind !== "select") return { kind: "unscored" };
      const scores = v.values
        .map((val) => q.options?.find((o) => o.value === val)?.score)
        .filter((s): s is number => typeof s === "number");
      if (!scores.length) return { kind: "unscored" };
      return { kind: "scored", score: scores.reduce((a, b) => a + b, 0) / scores.length };
    }
    default:
      return { kind: "unscored" };
  }
}

// ---------- control effectiveness ----------

export interface ControlEvaluation {
  controlId: string;
  title: string;
  /** Final 0..1 effectiveness, or null when there is no scored evidence. */
  effectiveness: number | null;
  /** Mean answer score before any finding cap, or null without scored answers. */
  answerScore: number | null;
  /** Lowest cap from open findings (1 when none). */
  cap: number;
  scoredAnswers: number;
  fullyMet: number;
  partlyMet: number;
  notMet: number;
  naAnswers: number;
  /** Distinct named areas with scored answers (site-wide answers are not counted as an area). */
  areas: number;
  /** True when no question of the control can be scored by this method (numbers and text only). */
  noScorableQuestions: boolean;
  /** Open (not resolved) findings, most severe first. */
  openFindings: Finding[];
  evidence: string;
}

/**
 * Effectiveness of one shared control.
 * 1. Each answer is scored (scoreAnswer). Per question, scores from several areas are averaged.
 * 2. The control's answer score is the mean of its question scores (questions without scored answers are skipped).
 * 3. Open findings cap it: min(answer score, lowest severity cap). Resolved findings are ignored.
 * 4. No scored answers: if an open finding of severity low or higher exists, effectiveness is that cap
 *    (the finding is direct evidence of a weakness); otherwise null (unknown).
 */
export function evaluateControl(control: ScoringControl, answers: Answer[], findings: Finding[]): ControlEvaluation {
  const qById = new Map(control.questions.map((q) => [q.id, q]));
  const perQuestion = new Map<string, number[]>();
  const areas = new Set<string>();
  let fullyMet = 0, partlyMet = 0, notMet = 0, naAnswers = 0;
  const relevant = answers
    .filter((a) => qById.has(a.questionId))
    .sort((a, b) => cmp(a.questionId, b.questionId) || cmp(a.areaId ?? "", b.areaId ?? "") || cmp(a.id, b.id));
  for (const a of relevant) {
    const r = scoreAnswer(qById.get(a.questionId)!, a.value);
    if (r.kind === "na") naAnswers++;
    if (r.kind !== "scored") continue;
    if (r.score >= 1) fullyMet++;
    else if (r.score <= 0) notMet++;
    else partlyMet++;
    if (a.areaId) areas.add(a.areaId);
    const list = perQuestion.get(a.questionId) ?? [];
    list.push(r.score);
    perQuestion.set(a.questionId, list);
  }
  const qMeans = [...perQuestion.keys()].sort(cmp).map((k) => {
    const l = perQuestion.get(k)!;
    return l.reduce((x, y) => x + y, 0) / l.length;
  });
  const answerScore = qMeans.length ? qMeans.reduce((x, y) => x + y, 0) / qMeans.length : null;

  const openFindings = findings
    .filter((f) => f.status !== "resolved" && f.controlIds.includes(control.id))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || cmp(a.title, b.title) || cmp(a.id, b.id));
  const cap = openFindings.reduce((c, f) => Math.min(c, FINDING_CAPS[f.severity]), 1);

  let effectiveness: number | null;
  if (answerScore !== null) effectiveness = Math.min(answerScore, cap);
  else effectiveness = cap < 1 ? cap : null;

  const noScorableQuestions = control.questions.every((q) => q.answerType === "number" || q.answerType === "text");
  const scoredAnswers = fullyMet + partlyMet + notMet;
  const ev: ControlEvaluation = {
    controlId: control.id,
    title: control.title,
    effectiveness: effectiveness === null ? null : round(effectiveness, 3),
    answerScore: answerScore === null ? null : round(answerScore, 3),
    cap,
    scoredAnswers,
    fullyMet,
    partlyMet,
    notMet,
    naAnswers,
    areas: areas.size,
    noScorableQuestions,
    openFindings,
    evidence: "",
  };
  ev.evidence = evidenceText(ev);
  return ev;
}

function findingCounts(fs: Finding[]): string {
  return SEVERITY_ORDER.filter((s) => fs.some((f) => f.severity === s))
    .map((s) => `${fs.filter((f) => f.severity === s).length} ${s}`)
    .join(", ");
}

/** Short evidence summary for the contributor table, e.g. "1 of 2 scored answers fully met, 1 partly met; 1 open high finding (caps it at 25%)". */
function evidenceText(ev: ControlEvaluation): string {
  const parts: string[] = [];
  if (ev.scoredAnswers > 0) {
    let s = `${ev.fullyMet} of ${plural(ev.scoredAnswers, "scored answer")} fully met`;
    if (ev.partlyMet) s += `, ${ev.partlyMet} partly met`;
    if (ev.areas > 1) s += ` across ${ev.areas} areas`;
    parts.push(s);
  } else if (ev.noScorableQuestions) {
    parts.push("its questions are measurements or notes, which this method does not score");
  } else {
    parts.push("no scored answers yet");
  }
  if (ev.naAnswers) parts.push(`${ev.naAnswers} N/A ${ev.naAnswers === 1 ? "answer" : "answers"} excluded`);
  if (ev.openFindings.length) {
    let s = `${plural(ev.openFindings.length, "open finding")} (${findingCounts(ev.openFindings)})`;
    if (ev.cap < 1 && (ev.answerScore === null || ev.cap < ev.answerScore)) s += `, capping it at ${pct(ev.cap)}`;
    parts.push(s);
  }
  return parts.join("; ");
}

function bandWord(e: number): string {
  if (e >= 0.75) return "effective";
  if (e >= 0.4) return "partly effective";
  return "weak";
}

/** One client-readable sentence about a contributing control. */
function contributorSentence(ev: ControlEvaluation, weight: number): string {
  const e = ev.effectiveness ?? 0;
  const reasons: string[] = [];
  if (ev.scoredAnswers > 0) {
    if (ev.fullyMet === ev.scoredAnswers) reasons.push(`${ev.scoredAnswers === 1 ? "its one scored check was" : `all ${ev.scoredAnswers} scored checks were`} fully met`);
    else if (ev.scoredAnswers === 1) reasons.push(`its one scored check was ${ev.partlyMet ? "only partly met" : "not met"}`);
    else {
      let s = `${ev.fullyMet} of ${plural(ev.scoredAnswers, "scored check")} ${ev.fullyMet === 1 ? "was" : "were"} fully met`;
      if (ev.partlyMet) s += ` and ${ev.partlyMet} partly met`;
      reasons.push(s);
    }
  } else {
    reasons.push("no checks are answered yet, so it is rated from its open findings");
  }
  const top = ev.openFindings[0];
  if (top) {
    const capNote = ev.cap < 1 && (ev.answerScore === null || ev.cap < ev.answerScore) ? `, which limits the rating to ${pct(ev.cap)}` : "";
    const lead =
      ev.openFindings.length === 1
        ? `${article(top.severity)} ${top.severity} finding is open${capNote}`
        : `${ev.openFindings.length} findings are open, the most serious rated ${top.severity}${capNote}`;
    reasons.push(`${lead}: ${trimEnd(top.title)}`);
  }
  const relevance = weight >= 3 ? "a primary control" : weight === 2 ? "a significant control" : "a supporting control";
  return `${ev.title} (${relevance}) is rated ${bandWord(e)} at ${pct(e)} because ${reasons.join(", and ")}.`;
}

// ---------- scenarios ----------

interface ScoredScenario {
  result: ScenarioResult;
  scenario: ThreatScenario;
}

const validLevel = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;

function scoreScenario(
  scenario: ThreatScenario,
  input: ScenarioInput,
  controlsById: Map<string, ScoringControl>,
  evals: Map<string, ControlEvaluation>,
): ScenarioResult {
  const likelihood = input.likelihood;
  const impact = input.impact;
  const inherentScore = likelihood * impact;
  const inherentLevel = levelFor(inherentScore);

  // Relevant controls: listed mitigations that are in scope; if none is, in-scope controls from the scenario's domains at weight 1.
  const totalLibraryWeight = scenario.mitigations.reduce((s, m) => s + m.weight, 0);
  let relevant = scenario.mitigations.filter((m) => controlsById.has(m.controlId)).map((m) => ({ controlId: m.controlId, weight: m.weight }));
  const fallback = relevant.length === 0;
  if (fallback) {
    relevant = [...controlsById.keys()]
      .filter((id) => (scenario.domains as string[]).includes(domainOf(id)))
      .sort(cmp)
      .map((controlId) => ({ controlId, weight: 1 }));
  }
  const inScopeWeight = fallback ? 0 : relevant.reduce((s, m) => s + m.weight, 0);
  const scopeShare = totalLibraryWeight ? inScopeWeight / totalLibraryWeight : 0;
  const outOfScope = fallback ? scenario.mitigations.length : scenario.mitigations.length - relevant.length;

  const rows = relevant.map((m) => ({ ...m, ev: evals.get(m.controlId)! }));
  const totalWeight = rows.reduce((s, r) => s + r.weight, 0);
  const withEvidence = rows.filter((r) => r.ev.effectiveness !== null);
  const evidenceWeight = withEvidence.reduce((s, r) => s + r.weight, 0);
  const effectivenessRaw = evidenceWeight ? withEvidence.reduce((s, r) => s + r.weight * r.ev.effectiveness!, 0) / evidenceWeight : 0;
  const effectiveness = round(effectivenessRaw, 3);
  const coverage = totalWeight ? round(evidenceWeight / totalWeight, 3) : 0;

  const residualScore = round(inherentScore * (1 - effectiveness * MAX_REDUCTION), 1);
  const residualLevel = levelFor(residualScore);

  let confidence: ScenarioResult["confidence"];
  if (coverage >= 0.8 && scopeShare >= 0.5 && !fallback) confidence = "high";
  else if (coverage >= 0.5) confidence = "medium";
  else confidence = "low";

  // Ranking: the biggest weighted shortfall first (what holds residual risk up), then weight, then id. Unknown controls last.
  const gap = (r: (typeof rows)[number]) => r.weight * (1 - (r.ev.effectiveness ?? 0));
  const ranked = [...withEvidence].sort((a, b) => gap(b) - gap(a) || b.weight - a.weight || cmp(a.controlId, b.controlId));
  const unknown = rows.filter((r) => r.ev.effectiveness === null).sort((a, b) => b.weight - a.weight || cmp(a.controlId, b.controlId));

  const contributors = [...ranked, ...unknown].map((r) => ({
    controlId: r.controlId,
    title: r.ev.title,
    weight: r.weight,
    effectiveness: r.ev.effectiveness,
    evidence: fallback ? `${r.ev.evidence}; used as a same-domain stand-in at weight 1` : r.ev.evidence,
    findingIds: r.ev.openFindings.map((f) => f.id),
  }));

  // ---- explanation (3 to 6 sentences) ----
  const L = LIKELIHOOD_SCALE[likelihood - 1]!;
  const I = IMPACT_SCALE[impact - 1]!;
  const explanation: string[] = [
    `Inherent risk for ${scenario.name} is ${inherentScore} of 25 (${levelLabel(inherentLevel)}): the assessor rated likelihood ${likelihood} (${L.label}) and impact ${impact} (${I.label}), which are multiplied.`,
  ];
  const outNote = outOfScope > 0 && !fallback ? `; ${plural(outOfScope, "further mitigating control")} ${outOfScope === 1 ? "is" : "are"} outside the frameworks selected for this assessment` : "";
  if (rows.length === 0) {
    explanation.push("None of the controls that mitigate this scenario are covered by the frameworks selected for this assessment, so no reduction is credited.");
  } else if (withEvidence.length === 0) {
    explanation.push(
      `${fallback ? "No listed mitigating control is in scope, so same-domain controls stand in; " : ""}none of the ${plural(rows.length, "relevant control")} in scope has scored evidence yet (not yet assessed: ${listNames(unknown.map((u) => u.ev.title))}), so no reduction is credited${outNote}.`.replace(/^n/, "N"),
    );
  } else {
    let s = fallback
      ? `No listed mitigating control is in scope, so ${plural(rows.length, "control")} from the same security domains ${rows.length === 1 ? "stands" : "stand"} in at equal weight; `
      : "";
    s += `the ${plural(withEvidence.length, "relevant control")} with evidence ${withEvidence.length === 1 ? "is" : "are"} ${pct(effectiveness)} effective on a weighted basis, with evidence covering ${pct(coverage)} of the weighted relevance in scope`;
    if (unknown.length) s += ` (not yet assessed: ${listNames(unknown.map((u) => u.ev.title))})`;
    s += `${outNote}.`;
    explanation.push(s.charAt(0).toUpperCase() + s.slice(1));
    for (const r of ranked.slice(0, 3)) explanation.push(contributorSentence(r.ev, r.weight));
  }
  const confWhy =
    confidence === "high"
      ? "evidence covers most of the relevant controls"
      : confidence === "medium"
        ? `evidence covers ${pct(coverage)} of the relevant controls in scope${scopeShare < 0.5 ? ` and the selected frameworks include ${pct(scopeShare)} of this scenario's mitigations` : ""}${fallback ? " and only same-domain stand-ins were available" : ""}`
        : rows.length === 0
          ? "no relevant controls were assessed"
          : `evidence covers only ${pct(coverage)} of the relevant controls in scope`;
  explanation.push(
    `Residual risk is ${residualScore} of 25 (${levelLabel(residualLevel)}), calculated as ${inherentScore} x (1 - ${effectiveness} x ${MAX_REDUCTION}), because controls are credited with removing at most ${pct(MAX_REDUCTION)} of inherent risk; confidence is ${confidence} because ${confWhy}.`,
  );

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    category: scenario.category,
    inherent: { likelihood, impact, score: inherentScore, level: inherentLevel },
    controlEffectiveness: { value: effectiveness, coverage, contributors },
    residual: { score: residualScore, level: residualLevel },
    confidence,
    explanation,
  };
}

/** Score an assessment. Answers and findings for other assessments are ignored. */
export function scoreAssessment(input: ScoreAssessmentInput): RiskResult {
  const answers = input.answers.filter((a) => a.assessmentId === input.assessmentId);
  const findings = input.findings.filter((f) => f.assessmentId === input.assessmentId);
  const controlsById = new Map<string, ScoringControl>();
  for (const c of [...input.controls].sort((a, b) => cmp(a.id, b.id))) if (!controlsById.has(c.id)) controlsById.set(c.id, c);
  const evals = new Map<string, ControlEvaluation>();
  for (const c of controlsById.values()) evals.set(c.id, evaluateControl(c, answers, findings));

  const inputById = new Map<string, ScenarioInput>();
  for (const i of input.inputs) if (!inputById.has(i.scenarioId)) inputById.set(i.scenarioId, i);

  const scored: ScoredScenario[] = [];
  const missingInputs: string[] = [];
  let excluded = 0;
  const seen = new Set<string>();
  for (const scenario of input.scenarios) {
    if (seen.has(scenario.id)) continue;
    seen.add(scenario.id);
    const si = inputById.get(scenario.id);
    if (si?.excluded) {
      excluded++;
      continue;
    }
    if (!si || !validLevel(si.likelihood) || !validLevel(si.impact)) {
      missingInputs.push(scenario.id);
      continue;
    }
    scored.push({ scenario, result: scoreScenario(scenario, si, controlsById, evals) });
  }

  const results = scored.map((s) => s.result);
  return {
    methodVersion: METHOD_VERSION,
    assessmentId: input.assessmentId,
    computedAt: input.computedAt,
    scenarios: results,
    overall: overall(results, missingInputs.length, excluded),
    missingInputs,
  };
}

/**
 * Overall site risk.
 * level: the highest residual level of any scenario (a site is as exposed as its worst scenario).
 * inherent and residual: means weighted by each scenario's inherent score, so serious scenarios count more
 * than trivial ones; used for trends and portfolio ranking.
 */
function overall(results: ScenarioResult[], missing: number, excluded: number): RiskResult["overall"] {
  const status = `${plural(results.length, "scenario")} scored, ${missing} awaiting likelihood and impact, ${excluded} excluded as not applicable.`;
  if (!results.length) {
    return {
      inherent: 0,
      residual: 0,
      level: "very_low",
      explanation: [status, "No scenario has likelihood and impact yet, so no overall risk can be stated; the level shown is a placeholder until inputs are entered."],
    };
  }
  const wSum = results.reduce((s, r) => s + r.inherent.score, 0);
  const inherent = round(results.reduce((s, r) => s + r.inherent.score * r.inherent.score, 0) / wSum, 1);
  const residual = round(results.reduce((s, r) => s + r.inherent.score * r.residual.score, 0) / wSum, 1);
  const worst = [...results].sort((a, b) => b.residual.score - a.residual.score || cmp(a.scenarioId, b.scenarioId))[0]!;
  const level = worst.residual.level;
  const ties = results.filter((r) => r.residual.level === level).length;
  const explanation = [
    status,
    `Overall residual risk is ${levelLabel(level)}, set by the highest scenario, ${worst.name}, at ${worst.residual.score} of 25${ties > 1 ? `; ${ties} scenarios are at this level` : ""}.`,
    `Weighting each scenario by its inherent score, the average is ${inherent} of 25 before controls and ${residual} after, a reduction of ${pct(inherent ? 1 - residual / inherent : 0)}.`,
  ];
  const low = results.filter((r) => r.confidence === "low");
  if (low.length) explanation.push(`${plural(low.length, "scenario")} ${low.length === 1 ? "has" : "have"} low confidence because few relevant controls have scored evidence: ${listNames(low.map((r) => r.name))}.`);
  return { inherent, residual, level, explanation };
}

// ---------- comparison ----------

const SEVERITIES: readonly Severity[] = ["info", "low", "medium", "high", "critical"];

/** Side-by-side site comparison with caveats on comparability. Sites stay in input order. */
export function compareSites(inputs: CompareInput[]): SiteComparison {
  const sites = inputs.map((i) => {
    const findingsBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const f of i.findings) if (f.status !== "resolved") findingsBySeverity[f.severity]++;
    const byScenario: Record<string, { inherent: number; residual: number; level: RiskLevel }> = {};
    for (const s of i.result.scenarios) byScenario[s.scenarioId] = { inherent: s.inherent.score, residual: s.residual.score, level: s.residual.level };
    return {
      assessmentId: i.assessmentId,
      siteName: i.siteName,
      clientName: i.clientName,
      completedAt: i.completedAt,
      overall: i.result.overall,
      byScenario,
      findingsBySeverity,
    };
  });

  const caveats: string[] = [];
  const name = (i: CompareInput) => i.siteName;
  if (inputs.length === 0) caveats.push("No sites were selected.");
  else if (inputs.length === 1) caveats.push("Only one site was selected, so there is nothing to compare against.");

  const methods = [...new Set(inputs.map((i) => i.result.methodVersion))].sort(cmp);
  if (methods.length > 1 || (methods.length === 1 && methods[0] !== METHOD_VERSION)) {
    caveats.push(
      `Scores were produced with different scoring method versions (${inputs.map((i) => `${name(i)}: ${i.result.methodVersion}`).join("; ")}; current ${METHOD_VERSION}); differences may come from the method rather than the sites.`,
    );
  }
  const libs = [...new Set(inputs.map((i) => i.libraryVersion))];
  if (libs.length > 1) {
    caveats.push(
      `Sites were assessed against different control library versions (${inputs.map((i) => `${name(i)}: ${i.libraryVersion}`).join("; ")}); questions and controls differ between versions, so control effectiveness is not strictly comparable.`,
    );
  }
  const fwKey = (i: CompareInput) => [...new Set(i.frameworks)].sort(cmp).join(", ");
  if (new Set(inputs.map(fwKey)).size > 1) {
    caveats.push(
      `Framework selections differ (${inputs.map((i) => `${name(i)}: ${fwKey(i) || "none"}`).join("; ")}); each scenario is scored only on controls in scope, so a site assessed with fewer frameworks has fewer controls counted.`,
    );
  }
  if (inputs.length > 1) {
    const allIds = [...new Set(inputs.flatMap((i) => i.result.scenarios.map((s) => s.scenarioId)))].sort(cmp);
    const partial = allIds.filter((id) => inputs.some((i) => !i.result.scenarios.some((s) => s.scenarioId === id)));
    if (partial.length) {
      const names = partial.map((id) => inputs.flatMap((i) => i.result.scenarios).find((s) => s.scenarioId === id)!.name);
      caveats.push(
        `Some scenarios are scored at only some of the sites (${listNames(names, 5)}); overall averages therefore cover different sets of scenarios.`,
      );
    }
  }
  const open = inputs.filter((i) => i.completedAt === null);
  if (open.length) {
    caveats.push(`${listNames(open.map(name), 5)} ${open.length === 1 ? "is" : "are"} not complete; ${open.length === 1 ? "its" : "their"} scores are live and may change.`);
  }
  const lowConf = inputs.filter((i) => i.result.scenarios.some((s) => s.confidence === "low"));
  if (lowConf.length) {
    caveats.push(`Some scenario scores have low confidence because few relevant controls have evidence (${listNames(lowConf.map(name), 5)}).`);
  }
  return { methodVersion: METHOD_VERSION, sites, caveats };
}
