import type { AnswerValue, Question } from "@sentinel/shared";
import type { WalkthroughControl, WalkthroughFramework } from "./schemas";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type SeverityValue = (typeof SEVERITIES)[number];
/** Severity always shows a text label and a distinct symbol, never color alone. */
export const SEVERITY: Record<SeverityValue, { label: string; icon: string; tone: "neutral" | "ok" | "warn" | "danger" | "primary" }> = {
  info: { label: "Info", icon: "i", tone: "neutral" },
  low: { label: "Low", icon: "▽", tone: "ok" },
  medium: { label: "Medium", icon: "◆", tone: "warn" },
  high: { label: "High", icon: "▲", tone: "danger" },
  critical: { label: "Critical", icon: "‼", tone: "danger" },
};

export const ASSET_TYPES = [
  "camera", "door", "gate", "lock", "card_reader", "alarm_panel", "sensor", "fence", "barrier", "lighting", "window", "signage",
  "landscaping", "parking", "guard_post", "server_room", "network_device", "server", "endpoint", "application", "cryptographic_asset", "document", "other",
] as const;
export type AssetTypeValue = (typeof ASSET_TYPES)[number];
export const assetTypeLabel = (t: string) => {
  const special: Record<string, string> = { card_reader: "Card reader", alarm_panel: "Alarm panel", guard_post: "Guard post", server_room: "Server room", network_device: "Network device", cryptographic_asset: "Cryptographic asset" };
  return special[t] ?? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ");
};

export const AREA_KINDS = ["exterior", "perimeter", "entrance", "interior", "restricted", "parking", "roof", "it_room", "other"] as const;
export type AreaKindValue = (typeof AREA_KINDS)[number];
export const AREA_KIND_LABEL: Record<AreaKindValue, string> = {
  exterior: "Exterior",
  perimeter: "Perimeter",
  entrance: "Entrance",
  interior: "Interior",
  restricted: "Restricted",
  parking: "Parking",
  roof: "Roof",
  it_room: "IT room",
  other: "Other",
};

/** Confidence in words plus a percentage: below 50 % Low, below 80 % Medium, otherwise High. */
export function confidenceText(c: number): string {
  const pct = Math.round(c * 100);
  const word = c < 0.5 ? "Low" : c < 0.8 ? "Medium" : "High";
  return `${word} (${pct}%)`;
}

const CHOICE_LABEL = { yes: "Yes", partial: "Partial", no: "No", na: "N/A" } as const;

export function answerText(value: AnswerValue | undefined, q?: Question): string {
  if (!value) return "Not answered";
  switch (value.kind) {
    case "choice":
      return CHOICE_LABEL[value.value];
    case "scale": {
      const a = q?.scale?.anchors.find((x) => x.value === value.value);
      return a ? `${value.value}: ${a.label}` : String(value.value);
    }
    case "number":
      return `${value.value} ${value.unit}`;
    case "select":
      return value.values.map((v) => q?.options?.find((o) => o.value === v)?.label ?? v).join(", ");
    case "text":
      return value.value || "Empty";
  }
}

/** True when the answer shows the control is not in place (drives the automatic draft finding). */
export function isDeficient(q: Question, value: AnswerValue): boolean {
  if (value.kind !== "choice") return false;
  const compliant = q.compliantAnswer ?? "yes";
  if (value.value === "na" || value.value === "partial") return false;
  return value.value !== compliant;
}

/** Group a control's framework mappings for "Counts toward" chips: one chip per framework. */
/**
 * One chip per framework requirement, using the framework short name and the requirement title
 * ("CARVER: Accessibility (SA-CARVER-A)"); never a raw framework id (tour fix). Falls back to the
 * requirement code while titles are not loaded.
 */
export function frameworkChips(frameworks: WalkthroughFramework[], titleOf?: (frameworkId: string, code: string) => string | undefined): { key: string; label: string }[] {
  const seen = new Set<string>();
  const out: { key: string; label: string }[] = [];
  for (const f of frameworks) {
    const key = `${f.frameworkId}:${f.requirementCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = titleOf?.(f.frameworkId, f.requirementCode);
    out.push({ key, label: title ? `${f.shortName}: ${title} (${f.requirementCode})` : `${f.shortName}: ${f.requirementCode}` });
  }
  return out;
}

export function controlsFrameworks(controlIds: string[], index: Map<string, WalkthroughControl>): WalkthroughFramework[] {
  return controlIds.flatMap((id) => index.get(id)?.frameworks ?? []);
}

/** Short names of the bundled frameworks, used only when a response leaves the short name out. */
const FRAMEWORK_SHORT: Record<string, string> = {
  carver: "CARVER",
  cpted: "CPTED",
  "nist-csf-2": "NIST CSF 2.0",
  "physical-general": "Physical Security",
  "pqc-readiness": "PQC Readiness",
};
/** Never shows a raw id: unknown frameworks read "Framework" plus a humanized id. */
export function frameworkName(id: string): string {
  return FRAMEWORK_SHORT[id] ?? id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
