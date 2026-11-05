/** Loads packages/frameworks/data/walkthrough.json (section order and asset type hints). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@sentinel/frameworks";
import { ControlDomain, Walkthrough } from "@sentinel/shared";

export type WalkthroughDef = Walkthrough;

/** Returns null when the file is absent or invalid (the API then falls back to one section per domain). */
export function loadWalkthrough(dataDir = DATA_DIR, warn: (m: string) => void = () => {}): WalkthroughDef | null {
  const file = join(dataDir, "walkthrough.json");
  if (!existsSync(file)) return null;
  try {
    const r = Walkthrough.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (r.success) return r.data;
    warn(`walkthrough.json is invalid; using one section per domain: ${r.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`);
  } catch (err) {
    warn(`walkthrough.json could not be read: ${(err as Error).message}`);
  }
  return null;
}

const DOMAIN_TITLES: Record<string, string> = {
  PER: "Perimeter", ACC: "Access control", VSS: "Video surveillance", IDS: "Intrusion detection and alarms",
  LCK: "Locks and hardware", LGT: "Lighting", GRD: "Guard operations", POL: "Physical security policy",
  ENV: "Environmental design", GOV: "Cyber governance", IDN: "Asset and risk identification", PRT: "Cyber protection",
  DET: "Cyber detection", RSP: "Cyber response", RCV: "Cyber recovery", CRY: "Cryptography and PQC readiness",
};

export interface SectionDef {
  id: string;
  title: string;
  description: string;
  order: number;
  domains: string[];
}

/** Section definitions: from walkthrough.json, or one per domain in ControlDomain enum order. */
export function sectionDefs(w: WalkthroughDef | null): SectionDef[] {
  if (w) return [...w.sections].sort((a, b) => a.order - b.order);
  return ControlDomain.options.map((d, i) => ({
    id: d.toLowerCase(),
    title: DOMAIN_TITLES[d] ?? d,
    description: `Walk through the ${(DOMAIN_TITLES[d] ?? d).toLowerCase()} controls for this assessment.`,
    order: i,
    domains: [d],
  }));
}
