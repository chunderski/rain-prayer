/**
 * Framework library loader. Reads every JSON file under data/, validates it
 * against the @sentinel/shared schemas, and checks referential integrity.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Crosswalk,
  FrameworkVersion,
  SharedControlLibrary,
  type CrosswalkEntry,
  type SharedControl,
} from "@sentinel/shared";

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export interface Library {
  frameworks: FrameworkVersion[];
  controls: SharedControl[];
  crosswalk: CrosswalkEntry[];
  libraryVersion: string;
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const jsonFiles = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => join(d.parentPath, d.name))
    .sort();

export function loadLibrary(dataDir = DATA_DIR): Library {
  const frameworks = jsonFiles(join(dataDir, "frameworks")).map((f) => parseOrThrow(FrameworkVersion, f));
  const controlFiles = jsonFiles(join(dataDir, "controls")).map((f) => parseOrThrow(SharedControlLibrary, f));
  const cw = parseOrThrow(Crosswalk, join(dataDir, "crosswalk.json"));
  const lib: Library = {
    frameworks,
    controls: controlFiles.flatMap((c) => c.controls),
    crosswalk: cw.entries,
    libraryVersion: cw.libraryVersion,
  };
  const problems = checkIntegrity(lib);
  if (problems.length) throw new Error(`Framework library integrity errors:\n- ${problems.join("\n- ")}`);
  return lib;
}

function parseOrThrow<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }, file: string): T {
  const r = schema.safeParse(readJson(file));
  if (!r.success) {
    const msg = r.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid library file ${file}:\n  ${msg}`);
  }
  return r.data;
}

/** Returns a list of human-readable integrity problems (empty means valid). */
export function checkIntegrity(lib: Library): string[] {
  const problems: string[] = [];
  const dup = <T>(items: T[], key: (t: T) => string, what: string) => {
    const seen = new Set<string>();
    for (const i of items) {
      const k = key(i);
      if (seen.has(k)) problems.push(`duplicate ${what}: ${k}`);
      seen.add(k);
    }
  };
  dup(lib.frameworks, (f) => `${f.id}@${f.version}`, "framework version");
  dup(lib.controls, (c) => c.id, "shared control");
  dup(lib.controls.flatMap((c) => c.questions), (q) => q.id, "question");
  for (const c of lib.controls) {
    for (const q of c.questions) {
      if (!q.id.startsWith(c.id.replace(/^SC-/, "Q-") + "-")) problems.push(`question ${q.id} does not belong to ${c.id}`);
    }
    if (!c.id.startsWith(`SC-${c.domain}-`)) problems.push(`control ${c.id} id does not match domain ${c.domain}`);
  }
  const reqs = new Map<string, Set<string>>();
  for (const f of lib.frameworks) {
    const codes = new Set(f.requirements.map((r) => r.code));
    dup(f.requirements, (r) => r.code, `requirement in ${f.id}`);
    for (const r of f.requirements) {
      if (r.parentCode && !codes.has(r.parentCode)) problems.push(`${f.id} ${r.code}: parent ${r.parentCode} not found`);
      if (!f.levels.includes(r.level)) problems.push(`${f.id} ${r.code}: level ${r.level} not in levels`);
    }
    const existing = reqs.get(f.id) ?? new Set<string>();
    codes.forEach((c) => existing.add(c));
    reqs.set(f.id, existing);
  }
  const controlIds = new Set(lib.controls.map((c) => c.id));
  dup(lib.crosswalk, (e) => `${e.sharedControlId}->${e.frameworkId}:${e.requirementCode}`, "crosswalk entry");
  for (const e of lib.crosswalk) {
    if (!controlIds.has(e.sharedControlId)) problems.push(`crosswalk: unknown control ${e.sharedControlId}`);
    const codes = reqs.get(e.frameworkId);
    if (!codes) problems.push(`crosswalk: unknown framework ${e.frameworkId}`);
    else if (!codes.has(e.requirementCode)) problems.push(`crosswalk: ${e.frameworkId} has no requirement ${e.requirementCode}`);
  }
  return problems;
}

/** All framework requirements a shared control counts toward. */
export function mappingsForControl(lib: Library, controlId: string): CrosswalkEntry[] {
  return lib.crosswalk.filter((e) => e.sharedControlId === controlId);
}

/** Shared controls that apply to an assessment with the given frameworks selected. */
export function controlsForFrameworks(lib: Library, frameworkIds: string[]): SharedControl[] {
  const wanted = new Set(frameworkIds);
  const ids = new Set(lib.crosswalk.filter((e) => wanted.has(e.frameworkId)).map((e) => e.sharedControlId));
  return lib.controls.filter((c) => ids.has(c.id));
}
