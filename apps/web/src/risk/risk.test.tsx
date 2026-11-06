import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RiskResult, ScenarioResult, SiteComparison } from "@sentinel/shared";
import { changeSentence, effectivenessText, IMPACT_SCALE, isUnscored, LIKELIHOOD_SCALE, levelFor } from "./levels";
import { BeforeAfter, LevelBadge } from "./RiskViz";
import { OverallSummary, ScenarioCard } from "../screens/RiskResults";
import { ComparisonView } from "../screens/Compare";
import { previewDocument } from "../screens/Report";
import { toPutBody } from "../api/phase3";

const A = "e0000000-0000-4000-8000-000000000001";
const F = "f1000000-0000-4000-8000-000000000001";

const scenario: ScenarioResult = {
  scenarioId: "forced-entry",
  name: "Forced entry",
  category: "physical",
  inherent: { likelihood: 4, impact: 5, score: 20, level: "very_high" },
  controlEffectiveness: {
    value: 0.4,
    coverage: 0.5,
    contributors: [{ controlId: "SC-LGT-001", title: "Exterior lighting", weight: 3, effectiveness: 0.25, evidence: "1 high finding open", findingIds: [F] }],
  },
  residual: { score: 12, level: "medium" },
  confidence: "low",
  explanation: ["Inherent risk is 20 (very high).", "Lighting is weak: one high finding is open."],
};

describe("risk levels and explanations", () => {
  it("prints the level name with the score, never color alone", () => {
    render(<LevelBadge level="high" score={14} />);
    expect(screen.getByText(/High/)).toHaveTextContent("High14");
  });

  it("describes the before and after change in one sentence", () => {
    expect(changeSentence(scenario.inherent, scenario.residual)).toBe("Inherent risk 20 (Very high) reduced to residual risk 12 (Medium) by current controls.");
    render(<BeforeAfter inherent={scenario.inherent} residual={scenario.residual} />);
    const fig = screen.getByRole("figure");
    expect(fig).toHaveTextContent("Very high20");
    expect(fig).toHaveTextContent("Medium12");
  });

  it("uses the risk method anchors and bands", () => {
    expect(LIKELIHOOD_SCALE.map((a) => a.label)).toEqual(["Rare", "Unlikely", "Possible", "Likely", "Almost certain"]);
    expect(IMPACT_SCALE[4]!.label).toBe("Severe");
    expect(levelFor(20)).toBe("very_high");
    expect(effectivenessText(null)).toBe("Not assessed yet");
  });

  it("renders explanation sentences in order and links contributors to controls and findings", () => {
    render(
      <MemoryRouter>
        <ScenarioCard s={scenario} assessmentId={A} findingTitle={() => "Entrance light out"} defaultOpen />
      </MemoryRouter>,
    );
    const items = within(screen.getByTestId("explanation")).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(scenario.explanation);
    expect(screen.getByText("Low confidence")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SC-LGT-001: Exterior lighting" })).toHaveAttribute("href", "/library/SC-LGT-001");
    expect(screen.getByRole("link", { name: "Finding: Entrance light out" })).toHaveAttribute("href", `/assessments/${A}/findings/${F}`);
    expect(screen.getByRole("meter", { name: "Control effectiveness" })).toHaveAttribute("aria-valuenow", "40");
  });

  it("shows Not scored yet instead of the placeholder level when nothing is scored", () => {
    const r: RiskResult = {
      methodVersion: "risk-method@1.0.0",
      assessmentId: A,
      computedAt: "2026-11-05T10:00:00Z",
      scenarios: [],
      overall: { inherent: 0, residual: 0, level: "very_low", explanation: ["No scenario has likelihood and impact yet."] },
      missingInputs: ["forced-entry"],
    };
    expect(isUnscored(r)).toBe(true);
    render(<OverallSummary r={r} locked={false} />);
    expect(screen.getByText("Not scored yet")).toBeInTheDocument();
    expect(screen.queryByText(/Very low/)).toBeNull();
  });

  it("comparison shows caveats, levels as text, and Not scored cells", () => {
    const site = (id: string, name: string, byScenario: SiteComparison["sites"][number]["byScenario"]) => ({
      assessmentId: id,
      siteName: name,
      clientName: "Northwind",
      completedAt: null,
      overall: { inherent: 20, residual: 12, level: "medium" as const, explanation: [] },
      byScenario,
      findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    });
    const c: SiteComparison = {
      methodVersion: "risk-method@1.0.0",
      sites: [site(A, "Warehouse", { "forced-entry": { inherent: 20, residual: 12, level: "medium" } }), site(F, "Office", {})],
      caveats: ["The sites use different frameworks."],
    };
    render(<ComparisonView c={c} scenarioName={() => "Forced entry"} />);
    expect(screen.getByTestId("caveats")).toHaveTextContent("The sites use different frameworks.");
    const row = screen.getByRole("row", { name: /Forced entry/ });
    expect(row).toHaveTextContent("Medium 12");
    expect(row).toHaveTextContent("Not scored");
    expect(screen.getByRole("row", { name: /Overall/ })).toHaveTextContent("Not scored yet");
  });
});

describe("report and inputs helpers", () => {
  it("adds the preview stylesheet to server HTML", () => {
    expect(previewDocument("<html><head><title>x</title></head><body>R</body></html>", "https://app/r.css")).toContain('<head><link rel="stylesheet" href="https://app/r.css"><title>');
    expect(previewDocument("<p>R</p>", "/r.css")).toMatch(/^<!doctype html>.*<body><p>R<\/p><\/body>/);
    // Brand colors are re-linked from /theme.css (the inline style is blocked by the inherited CSP); strict hex only.
    const branded = previewDocument("<html><head><style>:root{--brand-primary:#0b4f6c;--brand-accent:#c8553d;--brand-on-primary:#ffffff}</style></head><body>R</body></html>", "/r.css");
    expect(branded).toContain("/theme.css?p=0b4f6c&amp;a=c8553d");
    expect(previewDocument("<style>:root{--brand-primary:#0b4f6c\"><script>;--brand-accent:#c8553d}</style>", "/r.css")).not.toContain("theme.css");
  });

  it("sends only scored or excluded scenarios", () => {
    expect(
      toPutBody([
        { scenarioId: "a", likelihood: 4, impact: 5, rationale: "Seen", excluded: false },
        { scenarioId: "b", likelihood: 4, impact: null, excluded: false },
        { scenarioId: "c", likelihood: null, impact: null, excluded: true },
      ]),
    ).toEqual({
      scenarios: [
        { scenarioId: "a", likelihood: 4, impact: 5, rationale: "Seen", excluded: false },
        { scenarioId: "c", likelihood: 1, impact: 1, excluded: true },
      ],
    });
  });
});
