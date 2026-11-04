import type { ControlSummary, FrameworkSummary } from "../api/schemas";

const fw = (id: string, shortName: string, category: FrameworkSummary["category"], needsReviewCount = 0): FrameworkSummary => ({
  id,
  name: `${shortName} framework`,
  shortName,
  kind: "control_framework",
  category,
  description: `${shortName} plain-language description.`,
  publisher: "Test",
  sourceEdition: "1",
  version: "1.0.0",
  requirementCount: 10,
  controlCount: 5,
  needsReviewCount,
});

export const FRAMEWORKS: FrameworkSummary[] = [
  fw("physical-general", "Physical", "physical"),
  fw("cpted", "CPTED", "physical", 2),
  fw("carver", "CARVER", "physical"),
  fw("nist-csf-2", "NIST CSF 2.0", "cyber"),
  fw("pqc-readiness", "PQC readiness", "cyber"),
];

export const control = (id: string, frameworks: string[], questionCount = 2): ControlSummary => ({
  id,
  domain: id.split("-")[1]!,
  title: `Control ${id}`,
  objective: `Objective for ${id}.`,
  defaultSeverity: "medium",
  assetTypes: [],
  status: "approved",
  questionCount,
  mappings: frameworks.map((f) => ({ frameworkId: f, requirementCode: `${f}-1`, relationship: "supports" as const })),
});

/** LGT-001 and PER-001 are shared by physical-general and cpted; CRY-001 by nist and pqc. */
const ALL = [
  control("SC-LGT-001", ["physical-general", "cpted"], 3),
  control("SC-PER-001", ["physical-general", "cpted", "carver"], 2),
  control("SC-ACC-001", ["physical-general"], 4),
  control("SC-ENV-001", ["cpted"], 1),
  control("SC-GOV-001", ["nist-csf-2"], 2),
  control("SC-CRY-001", ["nist-csf-2", "pqc-readiness"], 5),
  control("SC-CRY-002", ["pqc-readiness"], 2),
];

export const CONTROLS_BY_FRAMEWORK: Record<string, ControlSummary[]> = Object.fromEntries(
  FRAMEWORKS.map((f) => [f.id, ALL.filter((c) => c.mappings.some((m) => m.frameworkId === f.id))]),
);
