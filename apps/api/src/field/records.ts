/**
 * Field records engine: one implementation of validation, versioning, and conflict handling for
 * areas, assets, answers, findings, and photo metadata, used by both the REST routes and sync push.
 *
 * Versioning: every write bumps `version` (trigger) and appends a change_log row (trigger).
 * Conflicts (sync only, when baseVersion is given): field-level last writer wins. Each row keeps
 * `field_clock` {field: clientUpdatedAt of the write that set it}; a conflicting op wins a field only
 * when its clientUpdatedAt is newer than that field's clock. The losing copy goes to sync_conflict.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Answer, Area, Asset, Finding, PhotoMeta, hasRole, type AnswerValue, type SyncEntity,
} from "@sentinel/shared";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { photoKeys, type ObjectStorage } from "../storage/index.js";
import {
  type AssessmentScope, type FieldCtx, requireAssessmentWrite, requireKnownControls, requireSiteWrite, tenantSettings,
} from "./context.js";

type Data = Record<string, unknown>;

interface Meta {
  version: number;
  deleted: boolean;
  clientUpdatedAt: string | null;
  fieldClock: Record<string, string>;
}
export interface Loaded {
  data: Data;
  meta: Meta;
  row: Record<string, unknown>;
}

interface Col {
  col: string;
  json?: boolean;
  time?: boolean;
  /** Omitted from output when null (schema field is optional, not nullable). */
  optional?: boolean;
}

export interface EntityDef {
  entity: SyncEntity;
  table: string;
  scopeKey: "assessmentId" | "siteId";
  schema: z.ZodType<Data>;
  cols: Record<string, Col>;
  /** Child table holding controlIds, if any. */
  controls?: { table: string; fk: string };
  mergeable: string[];
  /** Validates references and normalizes; may return flags. */
  normalize(ctx: FieldCtx, scope: AssessmentScope | null, data: Data, id: string): Promise<{ data: Data; gpsDropped?: boolean }>;
  /** Extra fields included in output (read-only, server-managed). */
  extra?: (row: Record<string, unknown>) => Data;
  beforeDelete?: (ctx: FieldCtx, id: string) => Promise<void>;
  afterDelete?: (ctx: FieldCtx, loaded: Loaded, deps: EngineDeps) => Promise<void>;
}

export interface EngineDeps {
  storage: ObjectStorage;
}

// ---------------------------------------------------------------- helpers

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());

/** Stable JSON for comparisons (sorted object keys). */
function stable(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Data)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const invalid = (path: string, message: string) => new AppError(400, "validation_error", "Request validation failed", [{ path, message }]);

async function checkArea(ctx: FieldCtx, siteId: string, areaId: unknown) {
  if (areaId == null) return;
  const r = await ctx.tx.query("SELECT 1 FROM area WHERE id = $1 AND site_id = $2 AND deleted_at IS NULL", [areaId, siteId]);
  if (!r.rowCount) throw new AppError(400, "invalid_reference", "Area not found at this assessment's site", [{ path: "areaId", message: "unknown area" }]);
}
async function checkInAssessment(ctx: FieldCtx, table: "asset" | "finding", assessmentId: string, id: unknown, path: string) {
  if (id == null) return;
  const r = await ctx.tx.query(`SELECT 1 FROM ${table} WHERE id = $1 AND assessment_id = $2 AND deleted_at IS NULL`, [id, assessmentId]);
  if (!r.rowCount) throw new AppError(400, "invalid_reference", `${table} not found in this assessment`, [{ path, message: `unknown ${table}` }]);
}

/** Checks an answer value against its question's answer type (library is the source of truth). */
export function validateAnswerValue(scope: AssessmentScope, questionId: string, value: AnswerValue) {
  const q = scope.questions.get(questionId);
  if (!q) throw new AppError(400, "unknown_question", "Question is not part of this assessment's frameworks", [{ path: "questionId", message: "unknown question" }]);
  const bad = (m: string) => invalid("value", m);
  const optionValues = new Set((q.options ?? []).map((o) => o.value));
  switch (q.answerType) {
    case "yes_no_na":
      if (value.kind !== "choice" || value.value === "partial") throw bad("expected choice yes, no, or na");
      break;
    case "yes_partial_no_na":
      if (value.kind !== "choice") throw bad("expected choice yes, partial, no, or na");
      break;
    case "scale":
      if (value.kind !== "scale") throw bad("expected scale");
      if (q.scale && (value.value < q.scale.min || value.value > q.scale.max)) throw bad(`scale must be ${q.scale.min} to ${q.scale.max}`);
      break;
    case "number":
      if (value.kind !== "number") throw bad("expected number");
      break;
    case "single_select":
      if (value.kind !== "select" || value.values.length !== 1) throw bad("expected exactly one option");
      if (!value.values.every((v) => optionValues.has(v))) throw bad("unknown option");
      break;
    case "multi_select":
      if (value.kind !== "select") throw bad("expected options");
      if (!value.values.every((v) => optionValues.has(v))) throw bad("unknown option");
      break;
    case "text":
      if (value.kind !== "text") throw bad("expected text");
      break;
    default:
      throw bad(`unsupported answer type ${q.answerType}`);
  }
}

// ---------------------------------------------------------------- entity definitions

const AREA: EntityDef = {
  entity: "area",
  table: "area",
  scopeKey: "siteId",
  schema: Area as unknown as z.ZodType<Data>,
  cols: { siteId: { col: "site_id" }, name: { col: "name" }, kind: { col: "kind" }, sortOrder: { col: "sort_order" } },
  mergeable: ["name", "kind", "sortOrder"],
  async normalize(_ctx, _scope, data) {
    return { data };
  },
  async beforeDelete(ctx, id) {
    const r = await ctx.tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM answer WHERE area_id = $1 AND deleted_at IS NULL)
            + (SELECT count(*) FROM finding WHERE area_id = $1 AND deleted_at IS NULL)
            + (SELECT count(*) FROM photo WHERE area_id = $1 AND deleted_at IS NULL)
            + (SELECT count(*) FROM asset WHERE area_id = $1 AND deleted_at IS NULL) AS n`,
      [id],
    );
    if (Number(r.rows[0]?.n) > 0) throw new AppError(409, "area_in_use", "Answers, findings, photos, or assets still reference this area");
  },
};

const ASSET: EntityDef = {
  entity: "asset",
  table: "asset",
  scopeKey: "assessmentId",
  schema: Asset as unknown as z.ZodType<Data>,
  cols: {
    assessmentId: { col: "assessment_id" }, areaId: { col: "area_id" }, assetType: { col: "asset_type" },
    label: { col: "label" }, notes: { col: "notes", optional: true },
  },
  mergeable: ["areaId", "assetType", "label", "notes"],
  async normalize(ctx, scope, data) {
    await checkArea(ctx, scope!.siteId, data.areaId);
    return { data };
  },
};

const ANSWER: EntityDef = {
  entity: "answer",
  table: "answer",
  scopeKey: "assessmentId",
  schema: Answer as unknown as z.ZodType<Data>,
  cols: {
    assessmentId: { col: "assessment_id" }, questionId: { col: "question_id" }, areaId: { col: "area_id" },
    value: { col: "value", json: true }, notes: { col: "notes", optional: true }, answeredAt: { col: "answered_at", time: true },
  },
  mergeable: ["areaId", "value", "notes", "answeredAt"],
  async normalize(ctx, scope, data, id) {
    validateAnswerValue(scope!, data.questionId as string, data.value as AnswerValue);
    await checkArea(ctx, scope!.siteId, data.areaId);
    const dup = await ctx.tx.query<{ id: string }>(
      `SELECT id FROM answer WHERE assessment_id = $1 AND question_id = $2 AND area_id IS NOT DISTINCT FROM $3
          AND deleted_at IS NULL AND id <> $4`,
      [data.assessmentId, data.questionId, data.areaId ?? null, id],
    );
    if (dup.rows[0]) {
      const existing = await loadRecord(ctx, ANSWER, dup.rows[0].id);
      throw new AppError(409, "answer_exists", "This question already has an answer for this area; update that answer instead", {
        id: dup.rows[0].id, server: existing ? toOutput(ANSWER, existing) : undefined,
      });
    }
    return { data: { ...data, answeredAt: iso(data.answeredAt) } };
  },
};

const FINDING: EntityDef = {
  entity: "finding",
  table: "finding",
  scopeKey: "assessmentId",
  schema: Finding as unknown as z.ZodType<Data>,
  cols: {
    assessmentId: { col: "assessment_id" }, areaId: { col: "area_id" }, assetId: { col: "asset_id" }, title: { col: "title" },
    description: { col: "description" }, recommendation: { col: "recommendation", optional: true }, severity: { col: "severity" },
    status: { col: "status" }, source: { col: "source" }, suggestionId: { col: "suggestion_id" },
  },
  controls: { table: "finding_control", fk: "finding_id" },
  mergeable: ["areaId", "assetId", "title", "description", "recommendation", "severity", "status", "controlIds"],
  async normalize(ctx, scope, data) {
    await checkArea(ctx, scope!.siteId, data.areaId);
    await checkInAssessment(ctx, "asset", scope!.id, data.assetId, "assetId");
    return { data: { ...data, controlIds: requireKnownControls(scope!, data.controlIds as string[]) } };
  },
  async afterDelete(ctx, loaded) {
    // Photos linked to a deleted finding are unlinked (and so re-synced).
    await ctx.tx.query("UPDATE photo SET finding_id = NULL, updated_by = $2 WHERE finding_id = $1 AND deleted_at IS NULL", [loaded.data.id, ctx.auth.userId]);
  },
};

const PHOTO: EntityDef = {
  entity: "photo_meta",
  table: "photo",
  scopeKey: "assessmentId",
  schema: PhotoMeta as unknown as z.ZodType<Data>,
  cols: {
    assessmentId: { col: "assessment_id" }, areaId: { col: "area_id" }, assetId: { col: "asset_id" }, findingId: { col: "finding_id" },
    assetType: { col: "asset_type" }, severity: { col: "severity" }, notes: { col: "notes", optional: true },
    capturedAt: { col: "captured_at", time: true }, gps: { col: "gps", json: true }, contentType: { col: "content_type" },
    byteSize: { col: "byte_size" },
  },
  controls: { table: "photo_control", fk: "photo_id" },
  mergeable: ["areaId", "assetId", "findingId", "controlIds", "assetType", "severity", "notes"],
  extra: (row) => ({
    status: row.status,
    sha256: row.sha256 ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
  }),
  async normalize(ctx, scope, data) {
    await checkArea(ctx, scope!.siteId, data.areaId);
    await checkInAssessment(ctx, "asset", scope!.id, data.assetId, "assetId");
    await checkInAssessment(ctx, "finding", scope!.id, data.findingId, "findingId");
    const settings = await tenantSettings(ctx);
    const gpsDropped = data.gps != null && !settings.allowGps;
    return {
      data: {
        ...data,
        capturedAt: iso(data.capturedAt),
        gps: gpsDropped ? null : data.gps,
        controlIds: requireKnownControls(scope!, (data.controlIds as string[]) ?? []),
      },
      gpsDropped,
    };
  },
  async afterDelete(ctx, loaded, deps) {
    const keys = photoKeys(ctx.auth.tenantId, loaded.data.id as string);
    await ctx.tx.query(
      "UPDATE photo SET storage_key = NULL, thumb_key = NULL, notes = NULL, gps = NULL, updated_by = $2 WHERE id = $1",
      [loaded.data.id, ctx.auth.userId],
    );
    ctx.afterCommit.push(async () => {
      await deps.storage.delete(keys.full);
      await deps.storage.delete(keys.thumb);
    });
  },
};

export const ENTITIES: Record<SyncEntity, EntityDef> = { area: AREA, asset: ASSET, answer: ANSWER, finding: FINDING, photo_meta: PHOTO };

// ---------------------------------------------------------------- load and output

function rowToLoaded(def: EntityDef, row: Record<string, unknown>, controlIds?: string[]): Loaded {
  const data: Data = { id: row.id };
  for (const [field, c] of Object.entries(def.cols)) {
    const v = row[c.col];
    data[field] = c.time ? iso(v) : v ?? null;
  }
  if (def.controls) data.controlIds = controlIds ?? [];
  return {
    data,
    row,
    meta: {
      version: row.version as number,
      deleted: row.deleted_at != null,
      clientUpdatedAt: iso(row.client_updated_at),
      fieldClock: (row.field_clock as Record<string, string>) ?? {},
    },
  };
}

async function controlMap(ctx: FieldCtx, def: EntityDef, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!def.controls || !ids.length) return out;
  const cr = await ctx.tx.query<{ owner: string; control_id: string }>(
    `SELECT ${def.controls.fk} AS owner, control_id FROM ${def.controls.table} WHERE ${def.controls.fk} = ANY($1::uuid[]) ORDER BY control_id`,
    [ids],
  );
  for (const r of cr.rows) out.set(r.owner, [...(out.get(r.owner) ?? []), r.control_id]);
  return out;
}

export async function loadRecord(ctx: FieldCtx, def: EntityDef, id: string, lock = false): Promise<Loaded | null> {
  const { rows } = await ctx.tx.query(`SELECT * FROM ${def.table} WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  const row = rows[0];
  if (!row) return null;
  const cm = await controlMap(ctx, def, [row.id]);
  return rowToLoaded(def, row, cm.get(row.id));
}

/** Loads records by id (including tombstones), keyed by id. */
export async function loadMany(ctx: FieldCtx, def: EntityDef, ids: string[]): Promise<Map<string, Loaded>> {
  if (!ids.length) return new Map();
  const { rows } = await ctx.tx.query(`SELECT * FROM ${def.table} WHERE id = ANY($1::uuid[])`, [ids]);
  const cm = await controlMap(ctx, def, rows.map((r) => r.id));
  return new Map(rows.map((r) => [r.id as string, rowToLoaded(def, r, cm.get(r.id))]));
}

/** Live (not deleted) records where column = value, in a stable order. */
export async function listLive(ctx: FieldCtx, entity: SyncEntity, column: "assessment_id" | "site_id", value: string, orderBy = "created_at, id"): Promise<Data[]> {
  const def = ENTITIES[entity];
  const { rows } = await ctx.tx.query(`SELECT * FROM ${def.table} WHERE ${column} = $1 AND deleted_at IS NULL ORDER BY ${orderBy}`, [value]);
  const cm = await controlMap(ctx, def, rows.map((r) => r.id));
  return rows.map((r) => toOutput(def, rowToLoaded(def, r, cm.get(r.id))));
}

/** Public shape: the shared schema's fields (optional nulls omitted) plus version. */
export function toOutput(def: EntityDef, l: Loaded): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(l.data)) {
    if (v === null && def.cols[k]?.optional) continue;
    out[k] = v;
  }
  return { ...out, ...(def.extra?.(l.row) ?? {}), version: l.meta.version };
}

// ---------------------------------------------------------------- writes

async function writeControls(ctx: FieldCtx, def: EntityDef, id: string, ids: string[]) {
  if (!def.controls) return;
  await ctx.tx.query(`DELETE FROM ${def.controls.table} WHERE ${def.controls.fk} = $1`, [id]);
  if (ids.length) {
    await ctx.tx.query(
      `INSERT INTO ${def.controls.table} (tenant_id, ${def.controls.fk}, control_id) SELECT $1, $2, unnest($3::text[])`,
      [ctx.auth.tenantId, id, ids],
    );
  }
}

const dbValue = (c: Col, v: unknown) => (v === undefined ? null : c.json && v !== null ? JSON.stringify(v) : v);

async function insertRecord(ctx: FieldCtx, def: EntityDef, id: string, data: Data, at: string) {
  const fields = Object.keys(def.cols);
  const cols = ["id", "tenant_id", "created_by", "updated_by", "client_updated_at", "field_clock", ...fields.map((f) => def.cols[f]!.col)];
  const clock = Object.fromEntries(def.mergeable.map((f) => [f, at]));
  const values = [id, ctx.auth.tenantId, ctx.auth.userId, ctx.auth.userId, at, JSON.stringify(clock), ...fields.map((f) => dbValue(def.cols[f]!, data[f]))];
  try {
    await ctx.tx.query(`INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, values);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new AppError(409, "id_conflict", "A record with this id already exists");
    throw err;
  }
  if (def.controls) await writeControls(ctx, def, id, (data.controlIds as string[]) ?? []);
}

/** Updates the given fields; resurrect clears a tombstone. Returns false when nothing changed. */
async function updateRecord(ctx: FieldCtx, def: EntityDef, id: string, fields: Data, at: string, resurrect: boolean): Promise<boolean> {
  const keys = Object.keys(fields);
  if (!keys.length && !resurrect) return false;
  const sets: string[] = [];
  const values: unknown[] = [id, ctx.auth.userId, at];
  for (const k of keys) {
    const c = def.cols[k];
    if (!c) continue; // controlIds
    values.push(dbValue(c, fields[k]));
    sets.push(`${c.col} = $${values.length}`);
  }
  values.push(JSON.stringify(Object.fromEntries(keys.filter((k) => def.mergeable.includes(k)).map((k) => [k, at]))));
  sets.push(`field_clock = field_clock || $${values.length}::jsonb`);
  if (resurrect) sets.push("deleted_at = NULL");
  await ctx.tx.query(
    `UPDATE ${def.table} SET ${sets.join(", ")}, updated_by = $2,
            client_updated_at = GREATEST(COALESCE(client_updated_at, $3::timestamptz), $3::timestamptz)
      WHERE id = $1`,
    values,
  );
  if ("controlIds" in fields) await writeControls(ctx, def, id, fields.controlIds as string[]);
  return true;
}

async function deleteRecord(ctx: FieldCtx, def: EntityDef, loaded: Loaded, at: string, deps: EngineDeps) {
  await def.beforeDelete?.(ctx, loaded.data.id as string);
  await ctx.tx.query(`UPDATE ${def.table} SET deleted_at = now(), updated_by = $2, client_updated_at = $3 WHERE id = $1`, [
    loaded.data.id, ctx.auth.userId, at,
  ]);
  await def.afterDelete?.(ctx, loaded, deps);
}

// ---------------------------------------------------------------- the one write path

export interface WriteOp {
  action: "upsert" | "delete";
  id: string;
  data?: unknown;
  /** undefined: online REST write (no conflict check). null: client believes the record is new. */
  baseVersion?: number | null;
  clientUpdatedAt: string;
  /** Sync bookkeeping for the conflict log. */
  opId?: string;
  deviceId?: string;
  /** REST: fields the client did not send keep their stored values (PATCH). */
  partial?: boolean;
  /** Server-only: provenance for findings created by the AI review endpoint. Never taken from client input. */
  provenance?: { source: "ai_accepted" | "ai_edited"; suggestionId: string };
}

export interface WriteResult {
  status: "applied" | "conflict";
  record: Data | null;
  version: number | null;
  created: boolean;
  gpsDropped: boolean;
}

/** Checks write access for the record's scope; returns the assessment scope when it has one. */
async function authorize(ctx: FieldCtx, def: EntityDef, scopeId: string): Promise<AssessmentScope | null> {
  if (def.scopeKey === "siteId") {
    await requireSiteWrite(ctx, scopeId);
    return null;
  }
  return requireAssessmentWrite(ctx, scopeId);
}

const after = (a: string, b: string | null | undefined) => !b || Date.parse(a) > Date.parse(b);

export async function applyWrite(ctx: FieldCtx, entity: SyncEntity, op: WriteOp, deps: EngineDeps): Promise<WriteResult> {
  const def = ENTITIES[entity];
  // QA Phase 2: a device clock in the future must not pin field clocks forever, so clamp to server time.
  const at = new Date(Math.min(Date.parse(op.clientUpdatedAt), Date.now())).toISOString();
  const existing = await loadRecord(ctx, def, op.id, true);

  // ---- delete
  if (op.action === "delete") {
    if (!existing) return { status: "applied", record: null, version: null, created: false, gpsDropped: false };
    await authorize(ctx, def, existing.data[def.scopeKey] as string);
    // QA Phase 2: DELETE /areas is admin only; sync must not be a way around that.
    if (entity === "area" && !hasRole(ctx.auth.role, "admin")) throw new AppError(403, "forbidden", "Requires role admin or higher");
    if (existing.meta.deleted) return { status: "applied", record: null, version: existing.meta.version, created: false, gpsDropped: false };
    checkBaseAhead(op, existing);
    if (isConflict(op, existing)) {
      const latest = latestClock(existing);
      const clientWins = after(at, latest);
      if (clientWins) await deleteRecord(ctx, def, existing, at, deps);
      await logConflict(ctx, def, op, existing, clientWins ? "client" : "server", clientWins ? toOutput(def, existing) : { deleted: true, id: op.id }, []);
      return conflictResult(ctx, def, op.id);
    }
    await deleteRecord(ctx, def, existing, at, deps);
    const now = await loadRecord(ctx, def, op.id);
    return { status: "applied", record: null, version: now!.meta.version, created: false, gpsDropped: false };
  }

  // ---- upsert
  let input = op.data;
  if (op.partial && existing && input && typeof input === "object") {
    input = { ...toOutput(def, existing), ...(input as Data) };
  }
  const parsed = def.schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Request validation failed", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const raw = parsed.data;
  if (raw.id !== op.id) throw invalid("id", "must match the record id");
  if (existing && existing.data[def.scopeKey] !== raw[def.scopeKey]) {
    throw new AppError(409, "id_conflict", `This record belongs to a different ${def.scopeKey === "siteId" ? "site" : "assessment"}`);
  }
  if (existing && entity === "answer" && existing.data.questionId !== raw.questionId) {
    throw new AppError(409, "id_conflict", "An answer cannot move to a different question");
  }
  const scope = await authorize(ctx, def, raw[def.scopeKey] as string);
  // Server-controlled fields: AI provenance only comes from the review endpoint.
  if (entity === "finding") {
    raw.source = existing?.data.source ?? op.provenance?.source ?? "assessor";
    raw.suggestionId = existing?.data.suggestionId ?? op.provenance?.suggestionId ?? null;
  }
  const { data, gpsDropped = false } = await def.normalize(ctx, scope, raw, op.id);

  if (!existing) {
    if (op.baseVersion != null) throw new AppError(409, "not_found_on_server", "The record does not exist on the server; send baseVersion null to create it");
    await insertRecord(ctx, def, op.id, data, at);
    const now = await loadRecord(ctx, def, op.id);
    return { status: "applied", record: toOutput(def, now!), version: now!.meta.version, created: true, gpsDropped };
  }

  checkBaseAhead(op, existing);
  const changed = def.mergeable.filter((f) => !same(data[f], existing.data[f]));

  if (!isConflict(op, existing)) {
    const fields = existing.meta.deleted ? pick(data, Object.keys(def.cols).concat(def.controls ? ["controlIds"] : []).filter((f) => def.mergeable.includes(f))) : pick(data, changed);
    await updateRecord(ctx, def, op.id, fields, at, existing.meta.deleted);
    const now = await loadRecord(ctx, def, op.id);
    return { status: "applied", record: toOutput(def, now!), version: now!.meta.version, created: false, gpsDropped };
  }

  // ---- conflict
  if (existing.meta.deleted) {
    const clientWins = after(at, existing.meta.clientUpdatedAt);
    if (clientWins) await updateRecord(ctx, def, op.id, pick(data, def.mergeable), at, true);
    await logConflict(ctx, def, op, existing, clientWins ? "client" : "server", clientWins ? { deleted: true, id: op.id } : data, clientWins ? [] : def.mergeable);
    return conflictResult(ctx, def, op.id, gpsDropped ?? false);
  }
  const won = changed.filter((f) => after(at, existing.meta.fieldClock[f] ?? existing.meta.clientUpdatedAt));
  const lost = changed.filter((f) => !won.includes(f));
  if (won.length) await updateRecord(ctx, def, op.id, pick(data, won), at, false);
  const winner = lost.length === 0 ? "client" : won.length === 0 ? "server" : "merged";
  // The losing copy: the client's values for fields it lost, or the server's for fields it overwrote.
  const losing = winner === "client" ? pick(existing.data, won) : pick(data, lost);
  await logConflict(ctx, def, op, existing, winner, { id: op.id, ...losing }, lost);
  return conflictResult(ctx, def, op.id, gpsDropped ?? false);
}

const pick = (d: Data, keys: string[]) => Object.fromEntries(keys.map((k) => [k, d[k] ?? null]));

function isConflict(op: WriteOp, existing: Loaded) {
  if (op.baseVersion === undefined) return false;
  return op.baseVersion === null || op.baseVersion < existing.meta.version;
}

function checkBaseAhead(op: WriteOp, existing: Loaded) {
  if (op.baseVersion != null && op.baseVersion > existing.meta.version) {
    throw new AppError(409, "version_ahead", `baseVersion ${op.baseVersion} is newer than the server version ${existing.meta.version}`);
  }
}

function latestClock(l: Loaded): string | null {
  const all = [l.meta.clientUpdatedAt, ...Object.values(l.meta.fieldClock)].filter((x): x is string => !!x);
  return all.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

async function conflictResult(ctx: FieldCtx, def: EntityDef, id: string, gpsDropped = false): Promise<WriteResult> {
  const now = await loadRecord(ctx, def, id);
  return {
    status: "conflict",
    record: now!.meta.deleted ? { id, deleted: true } : toOutput(def, now!),
    version: now!.meta.version,
    created: false,
    gpsDropped,
  };
}

async function logConflict(ctx: FieldCtx, def: EntityDef, op: WriteOp, existing: Loaded, winner: "client" | "server" | "merged", losing: Data, lostFields: string[]) {
  await ctx.tx.query(
    `INSERT INTO sync_conflict (tenant_id, assessment_id, site_id, op_id, user_id, device_id, entity, entity_id, action,
                                base_version, server_version, winner, losing, lost_fields, client_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      ctx.auth.tenantId,
      def.scopeKey === "assessmentId" ? existing.data.assessmentId : null,
      def.scopeKey === "siteId" ? existing.data.siteId : null,
      op.opId ?? randomUUID(), ctx.auth.userId, op.deviceId ?? randomUUID(), def.entity, op.id, op.action,
      op.baseVersion ?? null, existing.meta.version, winner, JSON.stringify(losing), lostFields, op.clientUpdatedAt,
    ],
  );
  await audit(ctx.tx, {
    tenantId: ctx.auth.tenantId, actorUserId: ctx.auth.userId, actorEmail: ctx.auth.user.email, action: "sync.conflict",
    entityType: def.entity, entityId: op.id, ip: ctx.ip, userAgent: ctx.userAgent, details: { winner, lostFields, opId: op.opId },
  });
}
