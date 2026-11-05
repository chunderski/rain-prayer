/**
 * Report template engine (D-060): one typed document model, built once from report data and rendered
 * to HTML (preview) or Google Docs batchUpdate requests (export). Builders never emit markup; every
 * string in the model is plain text and each renderer escapes or inserts it literally.
 */
import type { RiskLevel, RiskResult } from "@sentinel/shared";

/** Bump when the structure or wording of the template changes; recorded on every export. */
export const TEMPLATE_VERSION = "report-template@1.0.0";

export type NarrativeSection = "executive_summary" | "methodology" | "key_findings" | "recommendations";
export const NARRATIVE_SECTIONS: NarrativeSection[] = ["executive_summary", "methodology", "key_findings", "recommendations"];

export interface ReportImage {
  photoId: string;
  storageKey: string;
  caption: string;
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string; tone?: "normal" | "muted" | "notice"; level?: RiskLevel }
  | { type: "bullets"; items: string[] }
  /** variant "risk" marks the risk summary; rowLevels gives each row's residual level (for level-* classes). */
  | { type: "table"; header: string[]; rows: string[][]; variant?: "risk"; rowLevels?: RiskLevel[] }
  | { type: "image"; image: ReportImage }
  | { type: "placeholder"; text: string }
  /** One finding in the register: its title and body blocks (renderers may wrap it). */
  | { type: "finding"; title: string; severity: string; blocks: Block[] };

export interface ReportDoc {
  templateVersion: string;
  title: string;
  subtitle: string;
  /** Tenant branding placeholder (integrator name until Phase 4 branding lands). */
  brandName: string;
  generatedAt: string;
  blocks: Block[];
}

export interface ReportFinding {
  id: string;
  title: string;
  description: string;
  recommendation?: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  status: string;
  areaName: string | null;
  controlIds: string[];
  frameworks: { frameworkId: string; requirementCode: string; relationship: string }[];
  photos: ReportImage[];
}

export interface ReportData {
  tenantName: string;
  assessment: {
    id: string;
    title: string;
    status: string;
    clientName: string;
    siteName: string;
    siteAddress: string | null;
    libraryVersion: string | null;
    frameworks: { frameworkId: string; version: string; shortName: string; name: string }[];
  };
  generatedAt: string;
  risk: RiskResult | null;
  riskError: string | null;
  /** Confirmed and resolved findings only; drafts are counted, not shown. */
  findings: ReportFinding[];
  draftFindingCount: number;
  narratives: Partial<Record<NarrativeSection, { text: string; status: "ai_draft" | "edited" | "approved" }>>;
  review: { requirementsPending: number; controlsPending: number };
}

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
const SEVERITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Informational" };
const LEVEL_LABEL: Record<string, string> = { very_low: "Very low", low: "Low", medium: "Medium", high: "High", very_high: "Very high" };
const SECTION_TITLE: Record<NarrativeSection, string> = {
  executive_summary: "Executive summary",
  methodology: "Methodology",
  key_findings: "Key findings",
  recommendations: "Recommendations",
};

export const DRAFT_PLACEHOLDER = "An AI draft exists for this section but has not been reviewed; it is not shown until a person edits or approves it.";
const EMPTY_PLACEHOLDER = "This section has not been written yet.";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * Human text for a narrative section. Only edited or approved text is used (D-060); an ai_draft
 * becomes a placeholder in the preview and is left out of exports.
 */
function narrativeBlocks(data: ReportData, section: NarrativeSection, mode: "preview" | "export", fallback?: Block[]): Block[] {
  const n = data.narratives[section];
  if (n && (n.status === "edited" || n.status === "approved")) {
    return n.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((text) => ({ type: "paragraph" as const, text }));
  }
  if (fallback) return fallback;
  if (mode === "preview") return [{ type: "placeholder", text: n?.status === "ai_draft" ? DRAFT_PLACEHOLDER : EMPTY_PLACEHOLDER }];
  return [];
}

function methodologyFallback(data: ReportData): Block[] {
  const method = data.risk?.methodVersion ?? "the current risk method";
  return [
    { type: "paragraph", text: "The assessor walked the site and answered the questions of each shared control in scope, recording findings and photo evidence. Each finding maps to every framework requirement its controls count toward." },
    { type: "paragraph", text: `Risk is scored per threat scenario with ${method}. Inherent risk is likelihood times impact, each on an anchored 1 to 5 scale. Control effectiveness comes from the answers and open findings of the controls that mitigate the scenario. Residual risk is inherent risk reduced by that effectiveness. Each scenario below lists the evidence behind its numbers.` },
  ];
}

export function buildReportDoc(data: ReportData, mode: "preview" | "export"): ReportDoc {
  const a = data.assessment;
  const blocks: Block[] = [];
  const h = (level: 1 | 2 | 3, text: string) => blocks.push({ type: "heading", level, text });
  const p = (text: string, tone: "normal" | "muted" | "notice" = "normal", level?: RiskLevel) =>
    blocks.push({ type: "paragraph", text, tone, ...(level ? { level } : {}) });

  // Title page details.
  p(`Prepared by ${data.tenantName} for ${a.clientName}`);
  p(`Site: ${a.siteName}${a.siteAddress ? `, ${a.siteAddress}` : ""}`);
  p(`Assessment status: ${a.status.replace("_", " ")}. Generated ${data.generatedAt.slice(0, 10)}.`, "muted");

  h(1, SECTION_TITLE.executive_summary);
  blocks.push(...narrativeBlocks(data, "executive_summary", mode));

  h(1, "Scope and frameworks");
  blocks.push({
    type: "table",
    header: ["Framework", "Version"],
    rows: a.frameworks.map((f) => [`${f.shortName}: ${f.name}`, f.version]),
  });
  p(`Control library version ${a.libraryVersion ?? "unknown"}.`, "muted");

  h(1, SECTION_TITLE.methodology);
  blocks.push(...narrativeBlocks(data, "methodology", mode, methodologyFallback(data)));

  h(1, "Risk summary");
  const r = data.risk;
  if (!r) {
    blocks.push({ type: "placeholder", text: `Risk scores are not available${data.riskError ? `: ${data.riskError}` : ""}.` });
  } else {
    p(`Overall residual risk: ${LEVEL_LABEL[r.overall.level] ?? r.overall.level} (inherent ${num(r.overall.inherent)}, residual ${num(r.overall.residual)}). Method ${r.methodVersion}.`, "normal", r.overall.level);
    for (const line of r.overall.explanation) p(line, "muted");
    blocks.push({
      type: "table",
      variant: "risk",
      rowLevels: r.scenarios.map((s) => s.residual.level),
      header: ["Scenario", "Inherent", "Control effectiveness", "Residual", "Level", "Confidence"],
      rows: r.scenarios.map((s) => [
        s.name, `${num(s.inherent.score)} (L${s.inherent.likelihood} x I${s.inherent.impact})`, pct(s.controlEffectiveness.value),
        num(s.residual.score), LEVEL_LABEL[s.residual.level] ?? s.residual.level, s.confidence,
      ]),
    });
    if (r.missingInputs.length) p(`Scenarios without likelihood and impact inputs: ${r.missingInputs.length}.`, "notice");
    h(2, "Scenario explanations");
    for (const s of r.scenarios) {
      h(3, s.name);
      blocks.push({ type: "bullets", items: s.explanation });
    }
  }

  h(1, SECTION_TITLE.key_findings);
  blocks.push(...narrativeBlocks(data, "key_findings", mode));

  h(1, "Findings register");
  if (data.draftFindingCount) p(`${data.draftFindingCount} draft finding(s) are not included until an assessor confirms them.`, "muted");
  if (!data.findings.length) p("No confirmed findings.", "muted");
  for (const sev of SEVERITY_ORDER) {
    const list = data.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    h(2, `${SEVERITY_LABEL[sev]} (${list.length})`);
    for (const f of list) {
      const body: Block[] = [];
      const meta = [`Severity: ${SEVERITY_LABEL[f.severity]}`, `Status: ${f.status}`, f.areaName ? `Area: ${f.areaName}` : null].filter(Boolean).join("; ");
      body.push({ type: "paragraph", text: meta, tone: "muted" });
      if (f.description) body.push({ type: "paragraph", text: f.description });
      if (f.recommendation) body.push({ type: "paragraph", text: `Recommendation: ${f.recommendation}` });
      const reqs = f.frameworks.map((x) => `${x.frameworkId} ${x.requirementCode} (${x.relationship})`);
      body.push({ type: "paragraph", text: `Counts toward: ${reqs.length ? reqs.join(", ") : "no mapped framework requirement"}. Controls: ${f.controlIds.join(", ")}.`, tone: "muted" });
      for (const img of f.photos) body.push({ type: "image", image: img });
      blocks.push({ type: "finding", title: f.title, severity: f.severity, blocks: body });
    }
  }

  h(1, SECTION_TITLE.recommendations);
  blocks.push(...narrativeBlocks(data, "recommendations", mode, []));
  h(2, "Remediation list");
  const remediation = data.findings.filter((f) => f.status !== "resolved" && f.recommendation);
  if (remediation.length) {
    blocks.push({
      type: "table",
      header: ["Priority", "Finding", "Severity", "Recommendation"],
      rows: remediation.map((f, i) => [String(i + 1), f.title, SEVERITY_LABEL[f.severity]!, f.recommendation!]),
    });
  } else {
    p("No open findings with recommendations.", "muted");
  }

  h(1, "Appendix: library review status");
  p(
    `This report uses the Sentinel Assess control library version ${a.libraryVersion ?? "unknown"}. The library is pending expert review: ` +
      `${data.review.requirementsPending} framework requirement(s) and ${data.review.controlsPending} shared control(s) in scope are not yet verified ` +
      "against the source standards. Treat framework wording and mappings as unverified until review is complete.",
    "notice",
  );
  p(`Template ${TEMPLATE_VERSION}.`, "muted");

  return {
    templateVersion: TEMPLATE_VERSION,
    title: a.title,
    subtitle: `${a.clientName}, ${a.siteName}`,
    brandName: data.tenantName,
    generatedAt: data.generatedAt,
    blocks,
  };
}

/** Every image in the document, in order. */
export const docImages = (doc: ReportDoc): ReportImage[] => {
  const walk = (bs: Block[]): ReportImage[] => bs.flatMap((b) => (b.type === "image" ? [b.image] : b.type === "finding" ? walk(b.blocks) : []));
  return walk(doc.blocks);
};
