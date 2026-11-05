/**
 * Local IndexedDB storage. Nothing token-bearing is ever written here.
 *
 * Version 1 stores:
 *  - library: cached GET responses for reference data and assessment summaries (no tokens).
 *  - drafts: in-progress forms (for example the new assessment wizard), saved on every change.
 *  - outbox: Phase 1 REST writes waiting for a connection (kept for compatibility).
 * Version 2 (Phase 2 field capture) adds:
 *  - walkthroughs: cached GET /assessments/:id/walkthrough structure per assessment.
 *  - areas, assets, answers, findings, photos: local copies of field records with their last
 *    known server version and a count of queued ops (see src/field/repo.ts).
 *  - photoBlobs: photo bytes (ArrayBuffer plus content type) until the server has stored them.
 *  - suggestions: AI suggestions fetched for photos.
 *  - syncOps: the sync outbox (SyncOps bound to user and tenant, QA R-11).
 *  - conflicts: losing copies reported by the server, for the "Conflict: review" screen.
 *  - meta: small key-value items (device id, pull cursors, walkthrough position, cached
 *    non-secret session profile, tenant settings).
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { z } from "zod";

export const DB_NAME = "sentinel-assess";
export const DB_VERSION = 2;

export interface LibraryEntry {
  key: string;
  data: unknown;
  cachedAt: string;
}

export interface Draft<T = unknown> {
  id: string;
  kind: string;
  data: T;
  updatedAt: string;
}

export const OutboxKind = z.enum(["create_client", "create_site", "create_assessment"]);
export type OutboxKind = z.infer<typeof OutboxKind>;

export const OutboxInput = z.object({
  kind: OutboxKind,
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  /** API path, relative to the base URL. Must start with "/" and never be an /auth route. */
  path: z
    .string()
    .startsWith("/")
    .refine((p) => !p.startsWith("//") && !p.includes("\\"), "path must be a plain API path")
    // Check the path as fetch will send it: dot segments and %2e are resolved first, so
    // "/./auth/login" or "/clients/../auth/refresh" cannot slip past the check.
    .refine((p) => !new URL(p, "http://outbox.invalid").pathname.toLowerCase().startsWith("/auth"), "auth requests are never queued"),
  body: z.unknown().optional(),
  /** Client-generated id the server can use to de-duplicate retries. */
  idempotencyKey: z.string().min(8).optional(),
});
export type OutboxInput = z.infer<typeof OutboxInput>;

export interface OutboxItem extends OutboxInput {
  id: string;
  idempotencyKey: string;
  createdAt: string;
  attempts: number;
  status: "pending" | "failed";
  lastError?: string;
}

// ---------- Phase 2 field records ----------

export type FieldStore = "areas" | "assets" | "answers" | "findings" | "photos";

/** A field record as stored on the device. */
export interface LocalRecord<T = unknown> {
  id: string;
  /** Owning assessment; areas belong to a site and use siteId instead. */
  assessmentId: string;
  siteId?: string;
  data: T;
  /** Last server version seen; null until the server has the record. */
  version: number | null;
  /** Number of ops for this record still in the sync outbox. */
  pendingOps: number;
  deleted?: boolean;
  updatedAt: string;
}

export type UploadState = "waiting_meta" | "ready" | "done";
export interface LocalPhoto<T = unknown> extends LocalRecord<T> {
  serverStatus: "pending_upload" | "stored" | null;
  upload: UploadState;
  uploadAttempts: number;
  nextUploadAt: number;
  lastUploadError?: string;
  width?: number | null;
  height?: number | null;
}

export interface PhotoBlob {
  id: string;
  bytes: ArrayBuffer;
  contentType: string;
}

export interface QueuedOp {
  opId: string;
  /** Monotonic order across reloads (Date.now based plus counter). */
  seq: number;
  userId: string;
  tenantId: string;
  assessmentId: string;
  store: FieldStore;
  op: {
    opId: string;
    entity: "area" | "asset" | "answer" | "finding" | "photo_meta";
    action: "upsert" | "delete";
    id: string;
    data?: unknown;
    baseVersion: number | null;
    clientUpdatedAt: string;
  };
  status: "pending" | "rejected";
  attempts: number;
  error?: { code: string; message: string };
}

export interface ConflictEntry {
  id: string;
  opId: string;
  assessmentId: string;
  store: FieldStore;
  entity: QueuedOp["op"]["entity"];
  recordId: string;
  local: unknown;
  server: unknown;
  serverVersion: number | null;
  at: string;
}

export interface WalkthroughEntry {
  assessmentId: string;
  data: unknown;
  cachedAt: string;
}

export interface SuggestionEntry {
  id: string;
  photoId: string;
  data: unknown;
}

interface SentinelDB extends DBSchema {
  library: { key: string; value: LibraryEntry };
  drafts: { key: string; value: Draft; indexes: { byKind: string } };
  outbox: { key: string; value: OutboxItem; indexes: { byCreatedAt: string } };
  walkthroughs: { key: string; value: WalkthroughEntry };
  areas: { key: string; value: LocalRecord; indexes: { bySite: string; byAssessment: string } };
  assets: { key: string; value: LocalRecord; indexes: { byAssessment: string } };
  answers: { key: string; value: LocalRecord; indexes: { byAssessment: string } };
  findings: { key: string; value: LocalRecord; indexes: { byAssessment: string } };
  photos: { key: string; value: LocalPhoto; indexes: { byAssessment: string; byUpload: string } };
  photoBlobs: { key: string; value: PhotoBlob };
  suggestions: { key: string; value: SuggestionEntry; indexes: { byPhoto: string } };
  syncOps: { key: string; value: QueuedOp; indexes: { bySeq: number } };
  conflicts: { key: string; value: ConflictEntry; indexes: { byAssessment: string } };
  meta: { key: string; value: { key: string; value: unknown } };
}

export const FIELD_STORES: FieldStore[] = ["areas", "assets", "answers", "findings", "photos"];
/** Stores that hold client data and are wiped at sign out. */
const CLIENT_DATA_STORES = ["drafts", "outbox", "walkthroughs", ...FIELD_STORES, "photoBlobs", "suggestions", "syncOps", "conflicts", "meta"] as const;

let dbPromise: Promise<IDBPDatabase<SentinelDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<SentinelDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SentinelDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Version 1: Phase 1 stores.
        if (oldVersion < 1) {
          db.createObjectStore("library", { keyPath: "key" });
          db.createObjectStore("drafts", { keyPath: "id" }).createIndex("byKind", "kind");
          db.createObjectStore("outbox", { keyPath: "id" }).createIndex("byCreatedAt", "createdAt");
        }
        // Version 2: Phase 2 field capture. Additive only, so existing library cache and drafts survive.
        if (oldVersion < 2) {
          db.createObjectStore("walkthroughs", { keyPath: "assessmentId" });
          const areas = db.createObjectStore("areas", { keyPath: "id" });
          areas.createIndex("bySite", "siteId");
          areas.createIndex("byAssessment", "assessmentId");
          for (const name of ["assets", "answers", "findings"] as const) {
            db.createObjectStore(name, { keyPath: "id" }).createIndex("byAssessment", "assessmentId");
          }
          const photos = db.createObjectStore("photos", { keyPath: "id" });
          photos.createIndex("byAssessment", "assessmentId");
          photos.createIndex("byUpload", "upload");
          db.createObjectStore("photoBlobs", { keyPath: "id" });
          db.createObjectStore("suggestions", { keyPath: "id" }).createIndex("byPhoto", "photoId");
          db.createObjectStore("syncOps", { keyPath: "opId" }).createIndex("bySeq", "seq");
          db.createObjectStore("conflicts", { keyPath: "id" }).createIndex("byAssessment", "assessmentId");
          db.createObjectStore("meta", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

/** For tests: close and forget the connection. */
export async function resetDbForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

/** UUID v4 (field record ids, op ids, device id). */
export function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const newId = uuid;

// ---------- change notifications ----------

type Listener = () => void;
const listeners = new Set<Listener>();
/** Subscribe to local data changes (writes, sync results). Returns an unsubscribe function. */
export function onLocalChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function notifyLocalChange(): void {
  for (const l of [...listeners]) l();
}

// ---------- meta ----------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await getDb()).get("meta", key))?.value as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await getDb()).put("meta", { key, value });
}
export async function deleteMeta(key: string): Promise<void> {
  await (await getDb()).delete("meta", key);
}

/** Library cache keys that hold global reference data (no tenant content). */
const isReferenceKey = (key: string) => /^\/(frameworks|controls)(\/|\?|$)/.test(key);

/** Wipe every store that can hold client data (sign out, or a different user signing in). */
export async function clearClientData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([...CLIENT_DATA_STORES], "readwrite");
  await Promise.all([...CLIENT_DATA_STORES.map((s) => tx.objectStore(s).clear()), tx.done]);
  // QA Phase 2: the library store also caches tenant data (/assessments list and detail). Keep only
  // global reference data (framework library) so nothing of the previous workspace survives sign out.
  const lib = db.transaction("library", "readwrite");
  for (const key of await lib.store.getAllKeys()) {
    if (!isReferenceKey(String(key))) await lib.store.delete(key);
  }
  await lib.done;
  notifyLocalChange();
}

// ---------- library cache ----------

export async function putLibrary(key: string, data: unknown): Promise<void> {
  await (await getDb()).put("library", { key, data, cachedAt: new Date().toISOString() });
}

export async function getLibrary(key: string): Promise<LibraryEntry | undefined> {
  return (await getDb()).get("library", key);
}

// ---------- drafts ----------

export async function saveDraft<T>(id: string, kind: string, data: T): Promise<void> {
  await (await getDb()).put("drafts", { id, kind, data, updatedAt: new Date().toISOString() });
}

export async function getDraft<T>(id: string): Promise<Draft<T> | undefined> {
  return (await getDb()).get("drafts", id) as Promise<Draft<T> | undefined>;
}

export async function deleteDraft(id: string): Promise<void> {
  await (await getDb()).delete("drafts", id);
}

/** Drafts can hold client data, so they are cleared on sign out. */
export async function clearDrafts(): Promise<void> {
  await (await getDb()).clear("drafts");
}

/** Number of unsaved items (drafts plus queued changes) that sign out would delete. */
export async function pendingLocalCount(): Promise<number> {
  const db = await getDb();
  const uploads = (await db.countFromIndex("photos", "byUpload", "ready"));
  return (await db.count("drafts")) + (await db.count("outbox")) + (await db.count("syncOps")) + uploads;
}

/** Queued changes can hold client data, so they are cleared on sign out too (QA R-11). */
export async function clearOutbox(): Promise<void> {
  await (await getDb()).clear("outbox");
}

// ---------- outbox ----------

export async function enqueue(input: OutboxInput): Promise<OutboxItem> {
  const parsed = OutboxInput.parse(input);
  const item: OutboxItem = {
    ...parsed,
    id: newId(),
    idempotencyKey: parsed.idempotencyKey ?? newId(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: "pending",
  };
  await (await getDb()).add("outbox", item);
  return item;
}

/** Oldest first, the order the Phase 2 sync worker will send them in. */
export async function listOutbox(): Promise<OutboxItem[]> {
  return (await getDb()).getAllFromIndex("outbox", "byCreatedAt");
}

export async function outboxCount(): Promise<number> {
  return (await getDb()).count("outbox");
}

export async function removeFromOutbox(id: string): Promise<void> {
  await (await getDb()).delete("outbox", id);
}
