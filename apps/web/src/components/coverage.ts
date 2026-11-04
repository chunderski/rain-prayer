import type { ControlSummary } from "../api/schemas";

export interface Coverage {
  /** Distinct shared controls across the selected frameworks (what the assessor actually checks). */
  controlCount: number;
  /** Shared controls that count toward two or more of the selected frameworks. */
  overlapCount: number;
  /** Sum of per-framework control counts, i.e. the work without a shared library. */
  separateCount: number;
  /** Distinct questions across the distinct controls. */
  questionCount: number;
  /** False while any selected framework's controls are still loading. */
  complete: boolean;
}

export function computeCoverage(selected: string[], controlsByFramework: Record<string, ControlSummary[] | undefined>): Coverage {
  const hits = new Map<string, { count: number; questions: number }>();
  let separateCount = 0;
  let complete = true;
  for (const fw of selected) {
    const list = controlsByFramework[fw];
    if (!list) {
      complete = false;
      continue;
    }
    const seen = new Set<string>();
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      separateCount += 1;
      const h = hits.get(c.id);
      if (h) h.count += 1;
      else hits.set(c.id, { count: 1, questions: c.questionCount });
    }
  }
  let overlapCount = 0;
  let questionCount = 0;
  for (const h of hits.values()) {
    if (h.count > 1) overlapCount += 1;
    questionCount += h.questions;
  }
  return { controlCount: hits.size, overlapCount, separateCount, questionCount, complete };
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  /** null means every available framework. */
  frameworkIds: string[] | null;
}

export const PRESETS: Preset[] = [
  {
    id: "physical",
    label: "Physical site survey",
    description: "General physical security, CPTED, and CARVER",
    frameworkIds: ["physical-general", "cpted", "carver"],
  },
  { id: "cyber", label: "Cyber and PQC", description: "NIST CSF 2.0 and PQC readiness", frameworkIds: ["nist-csf-2", "pqc-readiness"] },
  { id: "full", label: "Full converged", description: "Every framework, physical and cyber", frameworkIds: null },
];

export function presetSelection(preset: Preset, available: string[]): string[] {
  return preset.frameworkIds === null ? [...available] : available.filter((id) => preset.frameworkIds!.includes(id));
}

export const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
