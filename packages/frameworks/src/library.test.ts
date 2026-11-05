import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssetType, ControlDomain } from "@sentinel/shared";
import { DATA_DIR, checkWalkthrough, loadLibrary, mappingsForControl } from "./index.js";

const lib = loadLibrary();
const fw = (id: string) => {
  const f = lib.frameworks.find((x) => x.id === id);
  if (!f) throw new Error(`framework ${id} missing`);
  return f;
};

describe("framework library", () => {
  it("loads and passes integrity checks", () => {
    expect(lib.libraryVersion).toBe("1.1.0");
    expect(lib.controls.length).toBeGreaterThan(0);
  });

  it("has all five frameworks", () => {
    expect(lib.frameworks.map((f) => f.id).sort()).toEqual(["carver", "cpted", "nist-csf-2", "physical-general", "pqc-readiness"]);
  });

  it("has a control file for every domain", () => {
    const domains = new Set(lib.controls.map((c) => c.domain));
    expect([...domains].sort()).toEqual(["ACC", "CRY", "DET", "ENV", "GOV", "GRD", "IDN", "IDS", "LCK", "LGT", "PER", "POL", "PRT", "RCV", "RSP", "VSS"]);
  });

  it("maps every shared control to at least one requirement", () => {
    const unmapped = lib.controls.filter((c) => mappingsForControl(lib, c.id).length === 0).map((c) => c.id);
    expect(unmapped).toEqual([]);
  });

  it("has the full NIST CSF 2.0 Core: 6 functions, 22 categories, 106 subcategories", () => {
    const csf = fw("nist-csf-2");
    const count = (level: string) => csf.requirements.filter((r) => r.level === level).length;
    expect(count("function")).toBe(6);
    expect(count("category")).toBe(22);
    expect(count("subcategory")).toBe(106);
    for (const r of csf.requirements.filter((x) => x.level === "subcategory")) {
      expect(r.code).toMatch(/^(GV|ID|PR|DE|RS|RC)\.[A-Z]{2}-\d{2}$/);
      expect(r.code.startsWith(`${r.parentCode}-`)).toBe(true);
    }
  });

  it("scores CARVER criteria on a 1 to 10 anchored scale", () => {
    const carver = fw("carver");
    expect(carver.kind).toBe("target_analysis");
    expect(carver.requirements).toHaveLength(6);
    for (const r of carver.requirements) {
      expect(r.scale?.min).toBe(1);
      expect(r.scale?.max).toBe(10);
      expect(r.scale?.anchors.length).toBeGreaterThanOrEqual(5);
    }
    const informs = lib.crosswalk.filter((e) => e.frameworkId === "carver");
    expect(informs.every((e) => e.relationship === "informs")).toBe(true);
  });

  it("uses Sentinel codes for Sentinel-authored frameworks", () => {
    for (const id of ["pqc-readiness", "cpted", "carver", "physical-general"]) {
      for (const r of fw(id).requirements) expect(r.code).toMatch(/^SA-/);
    }
  });

  it("counts at least 10 controls toward two or more frameworks", () => {
    const multi = lib.controls.filter((c) => new Set(mappingsForControl(lib, c.id).map((e) => e.frameworkId)).size >= 2);
    expect(multi.length).toBeGreaterThanOrEqual(10);
  });

  it("maps some physical controls to NIST CSF 2.0 (PR.AA-06 physical access)", () => {
    const physical = lib.crosswalk.filter((e) => e.frameworkId === "nist-csf-2" && e.requirementCode === "PR.AA-06");
    expect(physical.length).toBeGreaterThanOrEqual(3);
  });

  it("flags every unverified citation as needing review", () => {
    for (const f of lib.frameworks) {
      for (const r of f.requirements) if (!r.citation.verified) expect(r.status).toBe("needs_review");
    }
    expect(lib.controls.some((c) => c.status === "approved")).toBe(false);
  });

  it("has no vague opinion questions without a measurable criterion", () => {
    const vague = /\b(adequate(ly)?|sufficient(ly)?|appropriate(ly)?|reasonabl[ey]|proper(ly)?|satisfactor(y|ily)|effective(ly)?|good|enough|acceptabl[ey]|suitabl[ey])\b/i;
    const measurable = /\d/;
    const offenders = lib.controls
      .flatMap((c) => c.questions)
      .filter((q) => vague.test(q.text) && !measurable.test(q.text))
      .map((q) => `${q.id}: ${q.text}`);
    expect(offenders).toEqual([]);
  });

  it("gives every number question a unit and every scale question anchors", () => {
    for (const q of lib.controls.flatMap((c) => c.questions)) {
      if (q.answerType === "number") expect(q.unit).toBeTruthy();
      if (q.answerType === "scale") expect(q.scale?.anchors.length).toBeGreaterThanOrEqual(2);
      expect(q.answerType).not.toBe("text");
    }
  });

  it("contains no em dashes in any data file", () => {
    const files = readdirSync(DATA_DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(20);
    for (const d of files) {
      const text = readFileSync(join(d.parentPath, d.name), "utf8");
      expect(text.includes("—"), `${d.name} contains an em dash`).toBe(false);
    }
  });
  it("defines Partial in the guidance of every yes/partial/no/N/A question", () => {
    const missing = lib.controls
      .flatMap((c) => c.questions)
      .filter((q) => q.answerType === "yes_partial_no_na" && !/\bPartial:/.test(q.guidance))
      .map((q) => q.id);
    expect(missing).toEqual([]);
  });

  it("keeps data-quality notes out of field guidance (uses 'Target to confirm:' instead)", () => {
    const offenders = lib.controls.flatMap((c) => c.questions).filter((q) => /unverified/i.test(q.guidance) || /unverified/i.test(q.text));
    expect(offenders.map((q) => q.id)).toEqual([]);
  });

  it("uses the same release for every control file, the crosswalk, and the walkthrough", () => {
    const versions = readdirSync(join(DATA_DIR, "controls")).map((f) => JSON.parse(readFileSync(join(DATA_DIR, "controls", f), "utf8")).libraryVersion);
    expect(new Set(versions)).toEqual(new Set([lib.libraryVersion]));
    expect(lib.walkthrough?.libraryVersion).toBe(lib.libraryVersion);
  });
});

describe("walkthrough", () => {
  const w = lib.walkthrough!;
  const ids = new Set(lib.controls.map((c) => c.id));

  it("exists and passes its integrity checks", () => {
    expect(w).toBeDefined();
    expect(checkWalkthrough(w, ids, lib.libraryVersion)).toEqual([]);
  });

  it("puts every one of the 16 domains in exactly one section", () => {
    const all = w.sections.flatMap((s) => s.domains);
    expect(all).toHaveLength(16);
    expect([...all].sort()).toEqual([...ControlDomain.options].sort());
  });

  it("orders sections uniquely", () => {
    const orders = w.sections.map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("lists only existing controls for every asset type", () => {
    expect(Object.keys(w.assetTypeControls).sort()).toEqual([...AssetType.options].sort());
    for (const list of Object.values(w.assetTypeControls)) for (const id of list ?? []) expect(ids.has(id), id).toBe(true);
    expect(w.assetTypeControls.camera?.length).toBeGreaterThan(0);
  });

  it("reports a domain listed twice or missing, an unknown control, and a version mismatch", () => {
    const bad = structuredClone(w);
    bad.sections[0]!.domains = [...bad.sections[0]!.domains, "CRY"];
    bad.sections[1]!.domains = ["PER"];
    bad.assetTypeControls.door = ["SC-ACC-999"];
    bad.libraryVersion = "9.9.9";
    const problems = checkWalkthrough(bad, ids, lib.libraryVersion).join("\n");
    expect(problems).toMatch(/domain CRY is in both/);
    expect(problems).toMatch(/domain PER is in both/);
    expect(problems).toMatch(/domain LGT is in no section/);
    expect(problems).toMatch(/unknown control SC-ACC-999/);
    expect(problems).toMatch(/does not match crosswalk/);
  });
});
