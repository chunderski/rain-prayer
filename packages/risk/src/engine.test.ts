import { describe, expect, it } from "vitest";
import { loadLibrary } from "@sentinel/frameworks";
import { RiskResult, SiteComparison, type Answer, type Finding, type Question, type ScenarioInput, type Severity } from "@sentinel/shared";
import {
  FINDING_CAPS,
  METHOD_VERSION,
  SCENARIO_CONTROL_LIBRARY_VERSION,
  compareSites,
  evaluateControl,
  levelFor,
  loadScenarios,
  scenariosForControls,
  scoreAnswer,
  scoreAssessment,
  type CompareInput,
  type ScoringControl,
} from "./index.js";

const lib = loadLibrary();
const ALL_CONTROLS: ScoringControl[] = lib.controls.map((c) => ({ id: c.id, title: c.title, questions: c.questions }));
const SCENARIOS = loadScenarios();
const AID = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const NOW = "2026-11-05T12:00:00Z";
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
const ctrl = (id: string) => ALL_CONTROLS.find((c) => c.id === id)!;

function answer(questionId: string, value: Answer["value"], areaId: string | null = null, assessmentId = AID): Answer {
  return { id: uid(), assessmentId, questionId, areaId, value, answeredAt: NOW };
}
const choice = (v: "yes" | "partial" | "no" | "na"): Answer["value"] => ({ kind: "choice", value: v });

function finding(controlIds: string[], severity: Severity, status: Finding["status"] = "confirmed", title = `Finding ${severity}`, assessmentId = AID): Finding {
  return { id: uid(), assessmentId, areaId: null, assetId: null, title, description: "", severity, status, source: "assessor", controlIds, suggestionId: null };
}

/** Answer every scorable question of the given controls the same way. */
function answerAll(controls: ScoringControl[], mode: "pass" | "fail" | "na"): Answer[] {
  const out: Answer[] = [];
  for (const c of controls)
    for (const q of c.questions) {
      if (mode === "na") out.push(answer(q.id, choice("na")));
      else if (q.answerType === "yes_no_na" || q.answerType === "yes_partial_no_na") {
        const compliant = q.compliantAnswer ?? "yes";
        const other = compliant === "yes" ? "no" : "yes";
        out.push(answer(q.id, choice(mode === "pass" ? compliant : other)));
      } else if (q.answerType === "scale" && q.scale) out.push(answer(q.id, { kind: "scale", value: mode === "pass" ? q.scale.max : q.scale.min }));
      else if (q.answerType === "number") out.push(answer(q.id, { kind: "number", value: 5, unit: q.unit ?? "" }));
    }
  return out;
}

const inputsFor = (ids: string[], l = 4, i = 4): ScenarioInput[] => ids.map((scenarioId) => ({ scenarioId, likelihood: l, impact: i, excluded: false }));

function score(over: Partial<Parameters<typeof scoreAssessment>[0]> = {}) {
  const r = scoreAssessment({
    assessmentId: AID,
    computedAt: NOW,
    scenarios: SCENARIOS,
    inputs: inputsFor(SCENARIOS.map((s) => s.id)),
    controls: ALL_CONTROLS,
    answers: [],
    findings: [],
    ...over,
  });
  RiskResult.parse(r); // every result satisfies the shared contract
  return r;
}
const scen = (r: ReturnType<typeof score>, id: string) => r.scenarios.find((s) => s.scenarioId === id)!;

// ---------- scenario data ----------

describe("scenario library", () => {
  it("validates, is version stamped, and covers the required threats", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(7);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["theft", "forced-entry", "vandalism", "active-threat", "insider-threat", "cyber-intrusion", "harvest-now-decrypt-later"]) expect(ids).toContain(id);
    expect(SCENARIO_CONTROL_LIBRARY_VERSION).toBe(lib.libraryVersion);
  });

  it("references only shared controls that exist in the real library, once each, with weights 1 to 3", () => {
    const known = new Set(lib.controls.map((c) => c.id));
    for (const s of SCENARIOS) {
      const mids = s.mitigations.map((m) => m.controlId);
      expect(new Set(mids).size, `${s.id} duplicate mitigation`).toBe(mids.length);
      for (const m of s.mitigations) {
        expect(known.has(m.controlId), `${s.id}: ${m.controlId}`).toBe(true);
        expect([1, 2, 3]).toContain(m.weight);
      }
      expect(s.mitigations.some((m) => m.weight === 3), `${s.id} has a primary control`).toBe(true);
      expect(s.references.length).toBeGreaterThan(0);
    }
  });

  it("returns a fresh copy each call", () => {
    const a = loadScenarios();
    a[0]!.name = "changed";
    expect(loadScenarios()[0]!.name).not.toBe("changed");
  });

  it("scenariosForControls keeps library order and filters by mitigation", () => {
    const r = scenariosForControls(SCENARIOS, ["SC-CRY-001"]);
    expect(r.map((s) => s.id)).toEqual(["harvest-now-decrypt-later"]);
    expect(scenariosForControls(SCENARIOS, [])).toEqual([]);
    expect(scenariosForControls(SCENARIOS, ALL_CONTROLS.map((c) => c.id)).length).toBe(SCENARIOS.length);
  });
});

// ---------- answers and controls ----------

describe("scoreAnswer", () => {
  const yn: Question = { id: "Q-PER-001-02", text: "Is the fence intact along the run?", answerType: "yes_partial_no_na", guidance: "Walk the fence line.", photoOnDeficiency: false };
  it("scores yes, partial, no and excludes N/A", () => {
    expect(scoreAnswer(yn, choice("yes"))).toEqual({ kind: "scored", score: 1 });
    expect(scoreAnswer(yn, choice("partial"))).toEqual({ kind: "scored", score: 0.5 });
    expect(scoreAnswer(yn, choice("no"))).toEqual({ kind: "scored", score: 0 });
    expect(scoreAnswer(yn, choice("na"))).toEqual({ kind: "na" });
  });
  it("respects compliantAnswer no", () => {
    const q = { ...yn, compliantAnswer: "no" as const };
    expect(scoreAnswer(q, choice("no"))).toEqual({ kind: "scored", score: 1 });
    expect(scoreAnswer(q, choice("yes"))).toEqual({ kind: "scored", score: 0 });
  });
  it("normalizes scales by min and max and clamps", () => {
    const q: Question = { ...yn, answerType: "scale", scale: { min: 0, max: 3, anchors: [{ value: 0, label: "None", description: "none" }, { value: 3, label: "All", description: "all" }] } };
    expect(scoreAnswer(q, { kind: "scale", value: 2 })).toEqual({ kind: "scored", score: 2 / 3 });
    expect(scoreAnswer(q, { kind: "scale", value: 9 })).toEqual({ kind: "scored", score: 1 });
  });
  it("leaves number and text unscored, and mismatched kinds unscored", () => {
    expect(scoreAnswer({ ...yn, answerType: "number", unit: "ft" }, { kind: "number", value: 7, unit: "ft" })).toEqual({ kind: "unscored" });
    expect(scoreAnswer({ ...yn, answerType: "text" }, { kind: "text", value: "fine" })).toEqual({ kind: "unscored" });
    expect(scoreAnswer(yn, { kind: "scale", value: 1 })).toEqual({ kind: "unscored" });
  });
  it("uses library option scores for selects", () => {
    const q: Question = { ...yn, answerType: "multi_select", options: [{ value: "a", label: "A", score: 1 }, { value: "b", label: "B", score: 0 }, { value: "c", label: "C" }] };
    expect(scoreAnswer(q, { kind: "select", values: ["a", "b"] })).toEqual({ kind: "scored", score: 0.5 });
    expect(scoreAnswer(q, { kind: "select", values: ["c"] })).toEqual({ kind: "unscored" });
  });
});

describe("evaluateControl", () => {
  const fence = ctrl("SC-PER-001"); // number, yes_partial_no_na, yes_partial_no_na
  const [, q2, q3] = fence.questions.map((q) => q.id);
  it("is null (unknown) without scored answers, not zero", () => {
    expect(evaluateControl(fence, [], []).effectiveness).toBeNull();
    expect(evaluateControl(fence, [answer(q2!, choice("na")), answer(fence.questions[0]!.id, { kind: "number", value: 6, unit: "ft" })], []).effectiveness).toBeNull();
  });
  it("averages areas per question, then questions", () => {
    const e = evaluateControl(fence, [answer(q2!, choice("yes"), "a1"), answer(q2!, choice("no"), "a2"), answer(q2!, choice("yes"), "a3"), answer(q3!, choice("partial"))], []);
    expect(e.effectiveness).toBeCloseTo((2 / 3 + 0.5) / 2, 3);
    expect(e.evidence).toContain("2 of 4 scored answers fully met, 1 partly met across 3 areas");
  });
  it.each(Object.entries(FINDING_CAPS) as [Severity, number][])("an open %s finding caps effectiveness at %s", (sev, cap) => {
    const e = evaluateControl(fence, [answer(q2!, choice("yes")), answer(q3!, choice("yes"))], [finding(["SC-PER-001"], sev)]);
    expect(e.effectiveness).toBe(cap);
  });
  it("uses the lowest cap, counts drafts, and ignores resolved findings and other controls", () => {
    const ans = [answer(q2!, choice("yes")), answer(q3!, choice("yes"))];
    expect(evaluateControl(fence, ans, [finding(["SC-PER-001"], "low"), finding(["SC-PER-001"], "high", "draft")]).effectiveness).toBe(0.25);
    expect(evaluateControl(fence, ans, [finding(["SC-PER-001"], "critical", "resolved")]).effectiveness).toBe(1);
    expect(evaluateControl(fence, ans, [finding(["SC-PER-003"], "critical")]).effectiveness).toBe(1);
  });
  it("a cap never raises a lower answer score", () => {
    expect(evaluateControl(fence, [answer(q2!, choice("no"))], [finding(["SC-PER-001"], "low")]).effectiveness).toBe(0);
  });
  it("rates from findings alone when nothing is answered; info alone stays unknown", () => {
    expect(evaluateControl(fence, [], [finding(["SC-PER-001"], "high")]).effectiveness).toBe(0.25);
    expect(evaluateControl(fence, [], [finding(["SC-PER-001"], "info")]).effectiveness).toBeNull();
  });
  it("flags controls whose questions are all measurements", () => {
    const e = evaluateControl(ctrl("SC-DET-003"), answerAll([ctrl("SC-DET-003")], "pass"), []);
    expect(e.effectiveness).toBeNull();
    expect(e.evidence).toContain("measurements or notes");
  });
});

// ---------- assessment edge cases ----------

describe("scoreAssessment edge cases", () => {
  it("no answers: no reduction, zero coverage, low confidence", () => {
    const r = score();
    expect(r.methodVersion).toBe(METHOD_VERSION);
    for (const s of r.scenarios) {
      expect(s.inherent.score).toBe(16);
      expect(s.controlEffectiveness).toMatchObject({ value: 0, coverage: 0 });
      expect(s.residual.score).toBe(16);
      expect(s.confidence).toBe("low");
      expect(s.explanation.length).toBeGreaterThanOrEqual(3);
      expect(s.explanation.join(" ")).toContain("no reduction is credited");
    }
  });

  it("all N/A behaves like no evidence", () => {
    const r = score({ answers: answerAll(ALL_CONTROLS, "na") });
    for (const s of r.scenarios) expect(s.controlEffectiveness.coverage).toBe(0);
    expect(r.scenarios.map((s) => s.residual.score)).toEqual(score().scenarios.map((s) => s.residual.score));
  });

  it("all failing: effectiveness 0 with evidence, residual equals inherent", () => {
    const r = score({ answers: answerAll(ALL_CONTROLS, "fail") });
    for (const s of r.scenarios) {
      expect(s.controlEffectiveness.value).toBe(0);
      expect(s.residual.score).toBe(16);
      expect(s.controlEffectiveness.coverage).toBeGreaterThan(0);
    }
    expect(scen(r, "theft").explanation.join(" ")).toContain("rated weak at 0%");
  });

  it("all passing: residual is inherent x 0.2, never zero", () => {
    const r = score({ answers: answerAll(ALL_CONTROLS, "pass") });
    for (const s of r.scenarios) {
      expect(s.controlEffectiveness.value).toBe(1);
      expect(s.residual.score).toBe(3.2);
      expect(s.residual.level).toBe("very_low");
    }
    expect(scen(r, "theft").confidence).toBe("high");
  });

  it("excluded scenarios are neither scored nor missing; missing and invalid inputs are reported", () => {
    const inputs: ScenarioInput[] = [
      { scenarioId: "theft", likelihood: 3, impact: 3, excluded: true },
      { scenarioId: "vandalism", likelihood: 2, impact: 2, excluded: false },
      { scenarioId: "ransomware", likelihood: null as unknown as number, impact: 4, excluded: false },
      { scenarioId: "not-in-library", likelihood: 5, impact: 5, excluded: false },
    ];
    const r = score({ inputs });
    expect(r.scenarios.map((s) => s.scenarioId)).toEqual(["vandalism"]);
    expect(r.missingInputs).toContain("ransomware");
    expect(r.missingInputs).toContain("forced-entry");
    expect(r.missingInputs).not.toContain("theft");
    expect(r.missingInputs).not.toContain("not-in-library");
    expect(r.overall.explanation[0]).toContain("1 excluded as not applicable");
  });

  it("no inputs at all gives an empty, explained overall", () => {
    const r = score({ inputs: [] });
    expect(r.scenarios).toEqual([]);
    expect(r.missingInputs.length).toBe(SCENARIOS.length);
    expect(r.overall).toMatchObject({ inherent: 0, residual: 0 });
    expect(r.overall.explanation.join(" ")).toContain("placeholder");
  });

  it("ignores answers and findings from other assessments", () => {
    const other = answerAll(ALL_CONTROLS, "pass").map((a) => ({ ...a, assessmentId: OTHER }));
    const r = score({ answers: other, findings: [finding(["SC-ACC-001"], "critical", "confirmed", "x", OTHER)] });
    expect(scen(r, "theft").controlEffectiveness.coverage).toBe(0);
  });

  it("scenario with no in-scope controls and no domain stand-ins credits nothing", () => {
    const r = score({ controls: [ctrl("SC-CRY-001")], answers: answerAll([ctrl("SC-CRY-001")], "pass") });
    const t = scen(r, "theft");
    expect(t.controlEffectiveness.contributors).toEqual([]);
    expect(t.residual.score).toBe(16);
    expect(t.explanation[1]).toContain("None of the controls");
    expect(scen(r, "harvest-now-decrypt-later").controlEffectiveness.value).toBe(1);
  });

  it("falls back to same-domain controls at weight 1 when no listed mitigation is in scope", () => {
    // SC-PER-002 is not a theft mitigation, but PER is a theft domain.
    const c = [ctrl("SC-PER-002")];
    const r = score({ controls: c, answers: answerAll(c, "pass") });
    const t = scen(r, "theft");
    expect(t.controlEffectiveness.contributors.map((x) => [x.controlId, x.weight])).toEqual([["SC-PER-002", 1]]);
    expect(t.confidence).not.toBe("high");
    expect(t.explanation[1]).toContain("same security domains");
  });

  it("partial coverage lowers confidence", () => {
    const theft = SCENARIOS.find((s) => s.id === "theft")!;
    const inScope = theft.mitigations.map((m) => ctrl(m.controlId));
    const total = theft.mitigations.reduce((s, m) => s + m.weight, 0);
    // Answer only the weight-3 controls (6 of 28 weight): low.
    const primaries = inScope.filter((c) => theft.mitigations.find((m) => m.controlId === c.id)!.weight === 3);
    const low = scen(score({ controls: inScope, answers: answerAll(primaries, "pass") }), "theft");
    expect(low.controlEffectiveness.coverage).toBeCloseTo(6 / total, 3);
    expect(low.confidence).toBe("low");
    // Primaries plus four weight-2 controls: 14 of 28 weight, coverage 0.5: medium.
    const twos = inScope.filter((c) => theft.mitigations.find((m) => m.controlId === c.id)!.weight === 2).slice(0, 4);
    const med = scen(score({ controls: inScope, answers: answerAll([...primaries, ...twos], "pass") }), "theft");
    expect(med.controlEffectiveness.coverage).toBe(0.5);
    expect(med.confidence).toBe("medium");
    expect(med.explanation[1]).toContain("not yet assessed");
  });

  it("is deterministic regardless of input order", () => {
    const answers = answerAll(ALL_CONTROLS.slice(0, 30), "pass").concat(answerAll(ALL_CONTROLS.slice(30), "fail"));
    const findings = [finding(["SC-ACC-001"], "high"), finding(["SC-PRT-001", "SC-PRT-003"], "medium")];
    const a = score({ answers, findings });
    const b = score({ answers: [...answers].reverse(), findings: [...findings].reverse(), controls: [...ALL_CONTROLS].reverse() });
    expect(b).toEqual(a);
  });
});

describe("levels and explanations", () => {
  it("bands the 1 to 25 scale", () => {
    expect([1, 3, 4, 6, 8, 12, 15, 16, 20, 25].map(levelFor)).toEqual(["very_low", "very_low", "low", "low", "medium", "medium", "high", "high", "very_high", "very_high"]);
    expect(levelFor(12.9)).toBe("medium");
    expect(levelFor(13)).toBe("high");
  });

  it("names the top contributors with their finding, in 3 to 6 sentences, without em dashes", () => {
    const fence = ctrl("SC-PER-001");
    const answers = [answer(fence.questions[1]!.id, choice("yes")), answer(fence.questions[2]!.id, choice("partial")), ...answerAll([ctrl("SC-ACC-001"), ctrl("SC-IDS-003")], "pass")];
    const findings = [finding(["SC-PER-001"], "high", "confirmed", "Fence fabric cut near gate post.")];
    const r = score({ answers, findings });
    const t = scen(r, "theft");
    expect(t.explanation.length).toBeGreaterThanOrEqual(3);
    expect(t.explanation.length).toBeLessThanOrEqual(6);
    const fenceLine = t.explanation.find((s) => s.startsWith("Perimeter fence height and condition"))!;
    expect(fenceLine).toBe(
      "Perimeter fence height and condition (a significant control) is rated weak at 25% because 1 of 2 scored checks was fully met and 1 partly met, and a high finding is open, which limits the rating to 25%: Fence fabric cut near gate post.",
    );
    expect(t.controlEffectiveness.contributors[0]!.controlId).toBe("SC-PER-001");
    expect(t.controlEffectiveness.contributors[0]!.findingIds).toEqual([findings[0]!.id]);
    for (const s of r.scenarios.flatMap((x) => x.explanation).concat(r.overall.explanation)) {
      expect(s).not.toMatch(/[—–]/);
      expect(s).toMatch(/[.]$/);
    }
  });
});

// ---------- comparison ----------

describe("compareSites", () => {
  const base = (over: Partial<CompareInput> = {}): CompareInput => ({
    assessmentId: AID,
    siteName: "North depot",
    clientName: "Acme",
    completedAt: NOW,
    result: score({ answers: answerAll(ALL_CONTROLS, "pass") }),
    findings: [],
    frameworks: ["physical-general", "nist-csf-2"],
    libraryVersion: "1.1.0",
    ...over,
  });

  it("builds per-site rows and counts open findings by severity", () => {
    const c = compareSites([base({ findings: [finding(["SC-ACC-001"], "high"), finding(["SC-ACC-001"], "high", "resolved")] }), base({ assessmentId: OTHER, siteName: "South depot" })]);
    SiteComparison.parse(c);
    expect(c.sites[0]!.findingsBySeverity).toEqual({ info: 0, low: 0, medium: 0, high: 1, critical: 0 });
    expect(c.sites[0]!.byScenario["theft"]).toEqual({ inherent: 16, residual: 3.2, level: "very_low" });
    expect(c.caveats).toEqual([]);
  });

  it("flags different frameworks, library and method versions, partial scenario sets, open and low-confidence sites", () => {
    const partial = score({ inputs: inputsFor(["theft"]) });
    const c = compareSites([
      base(),
      base({ assessmentId: OTHER, siteName: "South depot", completedAt: null, frameworks: ["cpted"], libraryVersion: "1.0.0", result: { ...partial, methodVersion: "risk-method@0.9.0" } }),
    ]);
    SiteComparison.parse(c);
    const text = c.caveats.join("\n");
    expect(text).toContain("different scoring method versions");
    expect(text).toContain("different control library versions (North depot: 1.1.0; South depot: 1.0.0)");
    expect(text).toContain("Framework selections differ");
    expect(text).toContain("scored at only some of the sites");
    expect(text).toContain("South depot is not complete");
    expect(text).toContain("low confidence");
  });

  it("handles zero and one site", () => {
    expect(compareSites([]).caveats).toEqual(["No sites were selected."]);
    expect(compareSites([base()]).caveats[0]).toContain("Only one site");
  });
});

// ---------- golden file ----------

describe("golden: small mixed site", () => {
  it("matches the reviewed golden result", async () => {
    const areaGate = "00000000-0000-4000-8000-00000000a001";
    const areaLobby = "00000000-0000-4000-8000-00000000a002";
    const controls = ["SC-PER-001", "SC-PER-003", "SC-ACC-001", "SC-ACC-006", "SC-IDS-001", "SC-IDS-003", "SC-VSS-001", "SC-PRT-001", "SC-RCV-001", "SC-CRY-001", "SC-CRY-003"].map(ctrl);
    const q = (cid: string, n: number) => ctrl(cid).questions[n]!.id;
    const fixed = (a: Answer, i: number): Answer => ({ ...a, id: `00000000-0000-4000-8000-0000000b${i.toString().padStart(4, "0")}` });
    const answers = [
      answer(q("SC-PER-001", 1), choice("partial"), areaGate),
      answer(q("SC-PER-001", 2), choice("yes"), areaGate),
      answer(q("SC-PER-003", 0), choice("yes"), areaGate),
      answer(q("SC-PER-003", 1), choice("no"), areaGate),
      answer(q("SC-ACC-001", 0), choice("yes"), areaLobby),
      answer(q("SC-ACC-001", 0), choice("partial"), areaGate),
      answer(q("SC-ACC-006", 0), choice("no"), areaLobby),
      answer(q("SC-IDS-001", 0), choice("yes")),
      answer(q("SC-IDS-001", 1), choice("na")),
      answer(q("SC-IDS-003", 0), choice("yes")),
      answer(q("SC-VSS-001", 0), choice("partial"), areaLobby),
      answer(q("SC-PRT-001", 1), choice("yes")),
      answer(q("SC-RCV-001", 0), choice("partial")),
      answer(q("SC-RCV-001", 1), choice("no")),
      answer(q("SC-CRY-001", 0), { kind: "scale", value: 1 }),
      answer(q("SC-CRY-003", 0), choice("no")),
    ].map(fixed);
    const findings: Finding[] = [
      { ...finding(["SC-PER-001", "SC-PER-003"], "high", "confirmed", "Fence fabric cut near gate post"), id: "00000000-0000-4000-8000-0000000f0001", areaId: areaGate },
      { ...finding(["SC-ACC-006"], "medium", "confirmed", "Staff hold the lobby door for visitors"), id: "00000000-0000-4000-8000-0000000f0002", areaId: areaLobby },
      { ...finding(["SC-PRT-001"], "critical", "resolved", "MFA missing on remote access"), id: "00000000-0000-4000-8000-0000000f0003" },
      { ...finding(["SC-RCV-001"], "critical", "draft", "Backups stored on the same domain with no offline copy"), id: "00000000-0000-4000-8000-0000000f0004" },
    ];
    const inputs: ScenarioInput[] = [
      { scenarioId: "theft", likelihood: 4, impact: 3, excluded: false, rationale: "Two thefts from the yard in 2026." },
      { scenarioId: "forced-entry", likelihood: 3, impact: 3, excluded: false },
      { scenarioId: "tailgating", likelihood: 4, impact: 2, excluded: false },
      { scenarioId: "ransomware", likelihood: 3, impact: 5, excluded: false },
      { scenarioId: "harvest-now-decrypt-later", likelihood: 2, impact: 4, excluded: false },
      { scenarioId: "active-threat", likelihood: 1, impact: 5, excluded: true },
    ];
    const r = score({ scenarios: SCENARIOS, inputs, controls, answers, findings });

    // Hand-checked anchors (see docs/risk-method.md worked example).
    const theft = scen(r, "theft");
    // PER-001: q mean (0.5 + 1) / 2 = 0.75, capped by high finding at 0.25. PER-003: (1 + 0) / 2 = 0.5, capped 0.25.
    // ACC-001: lobby 1, gate 0.5 -> 0.75. IDS-001: 1 (N/A excluded). IDS-003: 1. VSS-001: 0.5.
    // weights: ACC-001 3, IDS-003 3, PER-001 2, PER-003 2, IDS-001 2, VSS-001 2 -> (2.25 + 3 + 0.5 + 0.5 + 2 + 1) / 14 = 9.25 / 14
    expect(theft.controlEffectiveness.value).toBeCloseTo(9.25 / 14, 3);
    expect(theft.residual.score).toBeCloseTo(12 * (1 - (Math.round((9.25 / 14) * 1000) / 1000) * 0.8), 1);
    expect(scen(r, "ransomware").controlEffectiveness.contributors.find((c) => c.controlId === "SC-RCV-001")!.effectiveness).toBe(0);
    expect(scen(r, "ransomware").controlEffectiveness.contributors.find((c) => c.controlId === "SC-PRT-001")!.effectiveness).toBe(1);
    await expect(JSON.stringify(r, null, 2) + "\n").toMatchFileSnapshot("./__golden__/small-site.json");
  });
});
