/**
 * Seed loader. Runs as the owner role (MIGRATION_DATABASE_URL).
 *  1. Loads the framework library (packages/frameworks/data) into the reference tables.
 *     Idempotent: upserts per framework version and per library release; rows removed from
 *     the data for that same version are deleted.
 *  2. Seeds dev tenants and users (never when NODE_ENV=production).
 *
 * Usage: tsx src/db/seed.ts [--strict] [--library-only] [--data-dir <dir>]
 *   --strict  fail on any library validation or integrity error (always on in production).
 *   Without --strict, a library that fails validation is loaded leniently: invalid files and
 *   dangling crosswalk entries are skipped and reported.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATA_DIR, checkIntegrity, loadLibrary, type Library } from "@sentinel/frameworks";
import { Crosswalk, FrameworkVersion, SharedControlLibrary, type CrosswalkEntry, type SharedControl } from "@sentinel/shared";
import { hashPassword } from "../lib/auth.js";

type Log = (msg: string) => void;

export const DEV_PASSWORD = "Sentinel-dev-2026!";
export const DEV_TENANTS = [
  { slug: "acme-integrators", name: "Acme Integrators" },
  { slug: "bluefield-security", name: "Bluefield Security" },
] as const;
export const DEV_USERS = [
  { email: "owner@acme.test", name: "Avery Owner", tenant: "acme-integrators", role: "owner" },
  { email: "assessor@acme.test", name: "Sam Assessor", tenant: "acme-integrators", role: "assessor" },
  { email: "viewer@acme.test", name: "Vic Viewer", tenant: "acme-integrators", role: "viewer" },
  { email: "owner@bluefield.test", name: "Blair Owner", tenant: "bluefield-security", role: "owner" },
] as const;

// ---------------------------------------------------------------- library loading

const jsonFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".json"))
        .map((d) => join(d.parentPath, d.name))
        .sort()
    : [];

/** Best-effort load: keeps every file that validates, then drops what breaks integrity. */
export function loadLibraryLenient(dataDir: string, log: Log): Library | null {
  const skipped: string[] = [];
  const tryParse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, file: string): T | null => {
    try {
      const r = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (r.success) return r.data as T;
    } catch {
      /* unreadable JSON */
    }
    skipped.push(file);
    return null;
  };
  const frameworks: FrameworkVersion[] = [];
  const seenFw = new Set<string>();
  for (const f of jsonFiles(join(dataDir, "frameworks"))) {
    const fw = tryParse<FrameworkVersion>(FrameworkVersion, f);
    if (fw && !seenFw.has(`${fw.id}@${fw.version}`)) {
      seenFw.add(`${fw.id}@${fw.version}`);
      frameworks.push(fw);
    }
  }
  const controlLibs = jsonFiles(join(dataDir, "controls"))
    .map((f) => tryParse<SharedControlLibrary>(SharedControlLibrary, f))
    .filter((x): x is SharedControlLibrary => !!x);
  const controls: SharedControl[] = [];
  const seenC = new Set<string>();
  const seenQ = new Set<string>();
  for (const c of controlLibs.flatMap((l) => l.controls)) {
    if (seenC.has(c.id) || c.questions.some((q) => seenQ.has(q.id))) {
      skipped.push(`control ${c.id} (duplicate id or question id)`);
      continue;
    }
    seenC.add(c.id);
    c.questions.forEach((q) => seenQ.add(q.id));
    controls.push(c);
  }
  const cwFile = join(dataDir, "crosswalk.json");
  const cw = existsSync(cwFile) ? tryParse<Crosswalk>(Crosswalk, cwFile) : null;
  const reqCodes = new Map<string, Set<string>>();
  for (const f of frameworks) {
    const s = reqCodes.get(f.id) ?? new Set<string>();
    f.requirements.forEach((r) => s.add(r.code));
    reqCodes.set(f.id, s);
  }
  const seenE = new Set<string>();
  const crosswalk: CrosswalkEntry[] = [];
  let dropped = 0;
  for (const e of cw?.entries ?? []) {
    const k = `${e.sharedControlId}->${e.frameworkId}:${e.requirementCode}`;
    if (!seenC.has(e.sharedControlId) || !reqCodes.get(e.frameworkId)?.has(e.requirementCode) || seenE.has(k)) {
      dropped++;
      continue;
    }
    seenE.add(k);
    crosswalk.push(e);
  }
  const versions = [cw?.libraryVersion, ...controlLibs.map((l) => l.libraryVersion)].filter((v): v is string => !!v);
  const libraryVersion = versions.sort(semverCompare).at(-1);
  if (skipped.length) log(`library: skipped ${skipped.length} invalid item(s):\n  - ${skipped.join("\n  - ")}`);
  if (dropped) log(`library: dropped ${dropped} crosswalk entr(ies) with unknown or duplicate references`);
  if (!libraryVersion || (!frameworks.length && !controls.length)) return null;
  const lib: Library = { frameworks, controls, crosswalk, libraryVersion };
  const remaining = checkIntegrity(lib);
  if (remaining.length) log(`library: ${remaining.length} integrity warning(s) remain (loaded anyway):\n  - ${remaining.slice(0, 20).join("\n  - ")}`);
  return lib;
}

function semverCompare(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---------------------------------------------------------------- reference upserts

const j = (v: unknown) => JSON.stringify(v);

export async function seedLibrary(db: pg.ClientBase, lib: Library, log: Log): Promise<void> {
  await db.query("BEGIN");
  try {
    await db.query(
      "INSERT INTO library_release (version) VALUES ($1) ON CONFLICT (version) DO UPDATE SET loaded_at = now()",
      [lib.libraryVersion],
    );
    for (const f of lib.frameworks) {
      await db.query(
        `INSERT INTO framework (id, name, short_name, kind, category) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name,
           kind = EXCLUDED.kind, category = EXCLUDED.category, updated_at = now()`,
        [f.id, f.name, f.shortName, f.kind, f.category],
      );
      await db.query(
        `INSERT INTO framework_version (framework_id, version, name, short_name, kind, category, description, publisher,
                                        source_edition, sources, levels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (framework_id, version) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name,
           kind = EXCLUDED.kind, category = EXCLUDED.category, description = EXCLUDED.description,
           publisher = EXCLUDED.publisher, source_edition = EXCLUDED.source_edition, sources = EXCLUDED.sources,
           levels = EXCLUDED.levels`,
        [f.id, f.version, f.name, f.shortName, f.kind, f.category, f.description, f.publisher, f.sourceEdition, j(f.sources), j(f.levels)],
      );
      const reqs = f.requirements.map((r, i) => ({
        code: r.code, parent_code: r.parentCode ?? null, level: r.level, title: r.title, text: r.text,
        citation: r.citation, status: r.status, scale: r.scale ?? null, sort_order: i,
      }));
      await db.query(
        `INSERT INTO requirement (framework_id, version, code, parent_code, level, title, text, citation, status, scale, sort_order)
         SELECT $1, $2, x.code, x.parent_code, x.level, x.title, x.text, x.citation, x.status, x.scale, x.sort_order
           FROM jsonb_to_recordset($3::jsonb) AS x(code text, parent_code text, level text, title text, text text,
                                                   citation jsonb, status text, scale jsonb, sort_order int)
         ON CONFLICT (framework_id, version, code) DO UPDATE SET parent_code = EXCLUDED.parent_code, level = EXCLUDED.level,
           title = EXCLUDED.title, text = EXCLUDED.text, citation = EXCLUDED.citation, status = EXCLUDED.status,
           scale = EXCLUDED.scale, sort_order = EXCLUDED.sort_order`,
        [f.id, f.version, j(reqs)],
      );
      await db.query("DELETE FROM requirement WHERE framework_id = $1 AND version = $2 AND NOT (code = ANY($3::text[]))", [
        f.id, f.version, f.requirements.map((r) => r.code),
      ]);
    }

    const v = lib.libraryVersion;
    const ctrls = lib.controls.map((c) => ({
      id: c.id, domain: c.domain, title: c.title, objective: c.objective, asset_types: c.assetTypes,
      default_severity: c.defaultSeverity, evidence: c.evidence, references: c.references, status: c.status,
    }));
    await db.query(
      `INSERT INTO shared_control (id, library_version, domain, title, objective, asset_types, default_severity, evidence, "references", status)
       SELECT x.id, $1, x.domain, x.title, x.objective, ARRAY(SELECT jsonb_array_elements_text(x.asset_types)),
              x.default_severity, x.evidence, x."references", x.status
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, domain text, title text, objective text, asset_types jsonb,
                                                 default_severity text, evidence jsonb, "references" jsonb, status text)
       ON CONFLICT (id, library_version) DO UPDATE SET domain = EXCLUDED.domain, title = EXCLUDED.title,
         objective = EXCLUDED.objective, asset_types = EXCLUDED.asset_types, default_severity = EXCLUDED.default_severity,
         evidence = EXCLUDED.evidence, "references" = EXCLUDED."references", status = EXCLUDED.status`,
      [v, j(ctrls)],
    );
    await db.query("DELETE FROM shared_control WHERE library_version = $1 AND NOT (id = ANY($2::text[]))", [v, lib.controls.map((c) => c.id)]);

    const qs = lib.controls.flatMap((c) =>
      c.questions.map((q, i) => ({
        id: q.id, shared_control_id: c.id, text: q.text, answer_type: q.answerType, compliant_answer: q.compliantAnswer ?? null,
        options: q.options ?? null, scale: q.scale ?? null, unit: q.unit ?? null, guidance: q.guidance,
        photo_on_deficiency: q.photoOnDeficiency, sort_order: i,
      })),
    );
    await db.query(
      `INSERT INTO question (id, library_version, shared_control_id, text, answer_type, compliant_answer, options, scale, unit,
                             guidance, photo_on_deficiency, sort_order)
       SELECT x.id, $1, x.shared_control_id, x.text, x.answer_type, x.compliant_answer, x.options, x.scale, x.unit,
              x.guidance, x.photo_on_deficiency, x.sort_order
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, shared_control_id text, text text, answer_type text,
              compliant_answer text, options jsonb, scale jsonb, unit text, guidance text, photo_on_deficiency boolean, sort_order int)
       ON CONFLICT (id, library_version) DO UPDATE SET shared_control_id = EXCLUDED.shared_control_id, text = EXCLUDED.text,
         answer_type = EXCLUDED.answer_type, compliant_answer = EXCLUDED.compliant_answer, options = EXCLUDED.options,
         scale = EXCLUDED.scale, unit = EXCLUDED.unit, guidance = EXCLUDED.guidance,
         photo_on_deficiency = EXCLUDED.photo_on_deficiency, sort_order = EXCLUDED.sort_order`,
      [v, j(qs)],
    );
    await db.query("DELETE FROM question WHERE library_version = $1 AND NOT (id = ANY($2::text[]))", [v, qs.map((q) => q.id)]);

    // Crosswalk entries name a framework, not a version: map to every loaded version that has the code.
    const rows = lib.crosswalk.flatMap((e) =>
      lib.frameworks
        .filter((f) => f.id === e.frameworkId && f.requirements.some((r) => r.code === e.requirementCode))
        .map((f) => ({ c: e.sharedControlId, f: f.id, v: f.version, r: e.requirementCode, rel: e.relationship, why: e.rationale })),
    );
    await db.query("DELETE FROM crosswalk WHERE library_version = $1", [v]);
    await db.query(
      `INSERT INTO crosswalk (library_version, shared_control_id, framework_id, version, requirement_code, relationship, rationale)
       SELECT $1, x.c, x.f, x.v, x.r, x.rel, x.why
         FROM jsonb_to_recordset($2::jsonb) AS x(c text, f text, v text, r text, rel text, why text)`,
      [v, j(rows)],
    );
    await db.query("COMMIT");
    log(`library ${v}: ${lib.frameworks.length} framework version(s), ${lib.controls.length} control(s), ${qs.length} question(s), ${rows.length} crosswalk row(s)`);
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------- dev tenants and users

export async function seedDevData(db: pg.ClientBase, log: Log): Promise<Record<string, string>> {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed dev users when NODE_ENV=production");
  const tenantIds: Record<string, string> = {};
  for (const t of DEV_TENANTS) {
    await db.query("BEGIN");
    try {
      // The owner role can read every tenant row (owner_read policy) but writes only under a tenant context.
      const existing = await db.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [t.slug]);
      const id = existing.rows[0]?.id ?? (await db.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await db.query(
        "INSERT INTO tenant (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
        [id, t.slug, t.name],
      );
      await db.query("COMMIT");
      tenantIds[t.slug] = id;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  for (const u of DEV_USERS) {
    const hash = await hashPassword(DEV_PASSWORD);
    const tenantId = tenantIds[u.tenant]!;
    await db.query("BEGIN");
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, name, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
           failed_login_count = 0, locked_until = NULL, disabled_at = NULL
         RETURNING id`,
        [u.email, u.name, hash],
      );
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await db.query(
        "INSERT INTO membership (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        [tenantId, rows[0]!.id, u.role],
      );
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  log(`dev data: ${DEV_TENANTS.length} tenants, ${DEV_USERS.length} users (password ${DEV_PASSWORD}; dev only)`);
  return tenantIds;
}

export interface SeedOptions {
  databaseUrl: string;
  dataDir?: string;
  strict?: boolean;
  devData?: boolean;
  log?: Log;
}

export async function seed(opts: SeedOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const dataDir = opts.dataDir ?? DATA_DIR;
  const strict = opts.strict || process.env.NODE_ENV === "production";
  let lib: Library | null;
  try {
    lib = loadLibrary(dataDir);
  } catch (err) {
    if (strict) throw err;
    log(`library: strict load failed, falling back to lenient load.\n${(err as Error).message.split("\n").slice(0, 10).join("\n")}`);
    lib = loadLibraryLenient(dataDir, log);
  }
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    if (lib) await seedLibrary(client, lib, log);
    else log("library: no valid library data found; reference tables left unchanged");
    if (opts.devData !== false) {
      if (process.env.NODE_ENV === "production") log("dev data: skipped (NODE_ENV=production; dev users are never seeded in production)");
      else await seedDevData(client, log);
    }
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL is required (owner role connection string).");
    process.exit(1);
  }
  const dirIdx = args.indexOf("--data-dir");
  seed({
    databaseUrl: url,
    dataDir: dirIdx >= 0 ? resolve(args[dirIdx + 1] ?? "") : undefined,
    strict: args.includes("--strict"),
    devData: !args.includes("--library-only"),
  }).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
