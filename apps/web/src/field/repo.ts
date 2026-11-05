/**
 * Local-first field repository. Every field write goes to IndexedDB first and then into the sync
 * outbox (store `syncOps`) as a SyncOp with a client UUID, the last server version seen, and the
 * client timestamp. The sync engine (src/sync/engine.ts) drains the outbox.
 *
 * Ops are bound to the user and tenant that made them (QA R-11): the engine only pushes ops of the
 * signed-in user and tenant, and sign out clears the outbox.
 */
import { Answer, Area, Asset, Finding, PhotoMeta } from "@sentinel/shared";
import { getDb, notifyLocalChange, uuid, type FieldStore, type LocalPhoto, type LocalRecord, type QueuedOp } from "../offline/db";

export interface WriteCtx {
  userId: string;
  tenantId: string;
}

export const ENTITY_OF: Record<FieldStore, QueuedOp["op"]["entity"]> = {
  areas: "area",
  assets: "asset",
  answers: "answer",
  findings: "finding",
  photos: "photo_meta",
};
export const STORE_OF: Record<QueuedOp["op"]["entity"], FieldStore> = {
  area: "areas",
  asset: "assets",
  answer: "answers",
  finding: "findings",
  photo_meta: "photos",
};

const SCHEMA = { areas: Area, assets: Asset, answers: Answer, findings: Finding, photos: PhotoMeta } as const;

let seqCounter = 0;
/** Monotonic across reloads: milliseconds times 1000 plus a rolling counter. */
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);

type WriteListener = () => void;
const writeListeners = new Set<WriteListener>();
/** The sync layer subscribes here to schedule a push after local writes. */
export function onFieldWrite(cb: WriteListener): () => void {
  writeListeners.add(cb);
  return () => writeListeners.delete(cb);
}

interface WriteInput<T> {
  id: string;
  assessmentId: string;
  siteId?: string;
  data: T;
  action?: "upsert" | "delete";
  /** Extra local-only fields (photos: upload state). */
  extra?: Partial<LocalPhoto>;
}

/**
 * Validate, store locally, and queue a SyncOp. A queued op that was never sent is updated in place
 * (one op per record until it is attempted), so editing a note ten times sends one op.
 */
export async function writeRecord<T>(ctx: WriteCtx, store: FieldStore, input: WriteInput<T>): Promise<LocalRecord<T>> {
  const action = input.action ?? "upsert";
  const data = action === "upsert" ? (SCHEMA[store].parse(input.data) as T) : input.data;
  const now = new Date().toISOString();
  const db = await getDb();
  const tx = db.transaction([store, "syncOps"], "readwrite");
  const recStore = tx.objectStore(store);
  const opStore = tx.objectStore("syncOps");
  const existing = (await recStore.get(input.id)) as LocalRecord<T> | undefined;
  const ops = await opStore.getAll();
  const reusable = ops.find(
    (o) => o.op.id === input.id && o.status === "pending" && o.attempts === 0 && o.userId === ctx.userId && o.tenantId === ctx.tenantId,
  );
  let pendingOps = existing?.pendingOps ?? 0;
  if (reusable) {
    reusable.op = { ...reusable.op, action, data: action === "upsert" ? data : undefined, clientUpdatedAt: now };
    await opStore.put(reusable);
  } else {
    const opId = uuid();
    await opStore.put({
      opId,
      seq: nextSeq(),
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      assessmentId: input.assessmentId,
      store,
      op: {
        opId,
        entity: ENTITY_OF[store],
        action,
        id: input.id,
        data: action === "upsert" ? data : undefined,
        // Filled in from the record's current version when the batch is sent.
        baseVersion: existing?.version ?? null,
        clientUpdatedAt: now,
      },
      status: "pending",
      attempts: 0,
    });
    pendingOps += 1;
  }
  const record = {
    ...(existing ?? {}),
    ...(input.extra ?? {}),
    id: input.id,
    assessmentId: input.assessmentId,
    ...(input.siteId ? { siteId: input.siteId } : {}),
    data: action === "upsert" ? data : (existing?.data ?? data),
    version: existing?.version ?? null,
    pendingOps,
    deleted: action === "delete",
    updatedAt: now,
  } as LocalRecord<T>;
  await recStore.put(record as LocalRecord);
  await tx.done;
  notifyLocalChange();
  for (const l of [...writeListeners]) l();
  return record;
}

// ---------- reads ----------

export async function listRecords<T>(store: Exclude<FieldStore, "areas">, assessmentId: string): Promise<LocalRecord<T>[]> {
  const all = (await (await getDb()).getAllFromIndex(store, "byAssessment", assessmentId)) as LocalRecord<T>[];
  return all.filter((r) => !r.deleted);
}

export async function listAreas(siteId: string): Promise<LocalRecord<Area>[]> {
  const all = (await (await getDb()).getAllFromIndex("areas", "bySite", siteId)) as LocalRecord<Area>[];
  return all.filter((r) => !r.deleted).sort((a, b) => a.data.sortOrder - b.data.sortOrder || a.data.name.localeCompare(b.data.name));
}

export async function getRecord<T>(store: FieldStore, id: string): Promise<LocalRecord<T> | undefined> {
  const r = (await (await getDb()).get(store, id)) as LocalRecord<T> | undefined;
  return r && !r.deleted ? r : undefined;
}

export async function getPhoto(id: string): Promise<LocalPhoto<PhotoMeta> | undefined> {
  return (await getRecord<PhotoMeta>("photos", id)) as LocalPhoto<PhotoMeta> | undefined;
}

export async function getPhotoBytes(id: string): Promise<Blob | undefined> {
  const b = await (await getDb()).get("photoBlobs", id);
  return b ? new Blob([b.bytes], { type: b.contentType }) : undefined;
}

// ---------- typed writes ----------

export function saveAnswer(ctx: WriteCtx, answer: Answer) {
  return writeRecord(ctx, "answers", { id: answer.id, assessmentId: answer.assessmentId, data: answer });
}

export function saveFinding(ctx: WriteCtx, finding: Finding) {
  return writeRecord(ctx, "findings", { id: finding.id, assessmentId: finding.assessmentId, data: finding });
}

export function deleteFinding(ctx: WriteCtx, finding: Finding) {
  return writeRecord(ctx, "findings", { id: finding.id, assessmentId: finding.assessmentId, data: finding, action: "delete" });
}

export function saveAsset(ctx: WriteCtx, asset: Asset) {
  return writeRecord(ctx, "assets", { id: asset.id, assessmentId: asset.assessmentId, data: asset });
}

export function saveArea(ctx: WriteCtx, assessmentId: string, area: Area) {
  return writeRecord(ctx, "areas", { id: area.id, assessmentId, siteId: area.siteId, data: area });
}

/** Store a captured photo's bytes and metadata locally and queue its metadata op. Bytes upload once that op is applied. */
export async function savePhotoCapture(ctx: WriteCtx, meta: PhotoMeta, bytes: ArrayBuffer, dims?: { width: number; height: number }) {
  const parsed = PhotoMeta.parse(meta);
  await (await getDb()).put("photoBlobs", { id: parsed.id, bytes, contentType: parsed.contentType });
  return writeRecord(ctx, "photos", {
    id: parsed.id,
    assessmentId: parsed.assessmentId,
    data: parsed,
    extra: { serverStatus: null, upload: "waiting_meta", uploadAttempts: 0, nextUploadAt: 0, width: dims?.width ?? null, height: dims?.height ?? null },
  });
}

/** Retag a photo: the metadata op is queued again; bytes are not re-uploaded. */
export function updatePhotoTags(ctx: WriteCtx, meta: PhotoMeta) {
  return writeRecord(ctx, "photos", { id: meta.id, assessmentId: meta.assessmentId, data: meta });
}

/** Records seeded from a server response (walkthrough, review). Never overwrites a record with queued ops. */
export async function putServerRecords(
  store: FieldStore,
  assessmentId: string,
  rows: { id: string; version?: number | null; siteId?: string; status?: string; width?: number | null; height?: number | null }[],
): Promise<void> {
  if (!rows.length) return;
  const db = await getDb();
  const tx = db.transaction([store, "photoBlobs"], "readwrite");
  const s = tx.objectStore(store);
  for (const row of rows) {
    const existing = (await s.get(row.id)) as LocalPhoto | undefined;
    if (existing && existing.pendingOps > 0) continue;
    const { version, ...data } = row;
    const base: LocalRecord = {
      id: row.id,
      assessmentId,
      ...(row.siteId ? { siteId: row.siteId } : {}),
      data,
      version: version ?? existing?.version ?? null,
      pendingOps: 0,
      updatedAt: new Date().toISOString(),
    };
    if (store === "photos") {
      const stored = row.status === "stored";
      const photo: LocalPhoto = {
        ...base,
        serverStatus: stored ? "stored" : "pending_upload",
        // A server record that still waits for bytes is uploaded from here if this device holds them.
        upload: stored ? "done" : existing?.upload === "waiting_meta" || existing?.upload === "ready" ? "ready" : (existing?.upload ?? "done"),
        uploadAttempts: existing?.uploadAttempts ?? 0,
        nextUploadAt: existing?.nextUploadAt ?? 0,
        width: row.width ?? existing?.width ?? null,
        height: row.height ?? existing?.height ?? null,
      };
      await s.put(photo);
    } else {
      await s.put(base);
    }
  }
  await tx.done;
  notifyLocalChange();
}
