/**
 * Risk display helpers. Level names, scale anchors (from @sentinel/risk), and formatting live here
 * so every screen (and the tests) render scores the same way.
 */
import type { RiskLevel } from "@sentinel/shared";

export const LEVELS: RiskLevel[] = ["very_low", "low", "medium", "high", "very_high"];

export const LEVEL_LABEL: Record<RiskLevel, string> = {
  very_low: "Very low",
  low: "Low",
  medium: "Medium",
  high: "High",
  very_high: "Very high",
};

/** Tailwind classes per level: soft background, strong border, and the matching bar fill. */
export const LEVEL_CLASS: Record<RiskLevel, { chip: string; fill: string; cell: string }> = {
  very_low: { chip: "bg-lv1-soft border-lv1 text-ink", fill: "bg-lv1", cell: "bg-lv1-soft" },
  low: { chip: "bg-lv2-soft border-lv2 text-ink", fill: "bg-lv2", cell: "bg-lv2-soft" },
  medium: { chip: "bg-lv3-soft border-lv3 text-ink", fill: "bg-lv3", cell: "bg-lv3-soft" },
  high: { chip: "bg-lv4-soft border-lv4 text-ink", fill: "bg-lv4", cell: "bg-lv4-soft" },
  very_high: { chip: "bg-lv5-soft border-lv5 text-ink", fill: "bg-lv5", cell: "bg-lv5-soft" },
};

/** Small glyph per level so the level reads in grayscale too (the text label is always present). */
export const LEVEL_MARK: Record<RiskLevel, string> = { very_low: "▁", low: "▂", medium: "▄", high: "▆", very_high: "█" };

/** Anchored 1 to 5 scales from the risk method (docs/risk-method.md, packages/risk). */
export { LIKELIHOOD_SCALE, IMPACT_SCALE, levelFor, type ScaleAnchor } from "@sentinel/risk";

/** Inherent and residual scores are likelihood times impact on 1 to 5 scales. */
export const SCORE_MAX = 25;

export const formatScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
export const formatPercent = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

export const CONFIDENCE_LABEL = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" } as const;

export const CATEGORY_LABEL = { physical: "Physical", cyber: "Cyber", hybrid: "Physical and cyber" } as const;

/** Share of the bar for a score, clamped, with a sliver for non-zero values so they stay visible. */
export function barShare(score: number, max = SCORE_MAX): number {
  if (!(score > 0)) return 0;
  return Math.max(0.03, Math.min(1, score / max));
}

/** One accessible sentence for a before and after pair, used as the visual's text alternative. */
export function changeSentence(inherent: { score: number; level: RiskLevel }, residual: { score: number; level: RiskLevel }): string {
  const a = `${formatScore(inherent.score)} (${LEVEL_LABEL[inherent.level]})`;
  const b = `${formatScore(residual.score)} (${LEVEL_LABEL[residual.level]})`;
  if (residual.score < inherent.score) return `Inherent risk ${a} reduced to residual risk ${b} by current controls.`;
  return `Inherent risk ${a}; residual risk ${b}: current controls do not reduce it.`;
}

/** Plain-language rendering of an effectiveness value that may be unknown. */
export function effectivenessText(v: number | null): string {
  return v === null ? "Not assessed yet" : `${formatPercent(v)} effective`;
}

/**
 * True when nothing is scored yet: the API then reports a placeholder "very_low" overall level,
 * which must read "Not scored yet" instead (Head of Engineering display rule).
 */
export function isUnscored(r: { scenarios: unknown[] } | { byScenario: Record<string, unknown> }): boolean {
  return "scenarios" in r ? r.scenarios.length === 0 : Object.keys(r.byScenario).length === 0;
}

export const NOT_SCORED = "Not scored yet";
