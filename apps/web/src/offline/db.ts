/**
 * Local IndexedDB storage.
 *
 * Stores:
 *  - library: cached GET /frameworks and /controls responses (reference data, no tokens), so the
 *    library browser and framework picker work offline once loaded.
 *  - drafts: in-progress forms (for example the new assessment wizard), saved on every change.
 *  - outbox: writes waiting to be sent to the API. Phase 1 only enqueues and lists; the sync
 *    worker that drains it with retries is Phase 2.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { z } from "zod";

export const DB_NAME = "sentinel-assess";
export const DB_VERSION = 1;

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

interface SentinelDB extends DBSchema {
  library: { key: string; value: LibraryEntry };
  drafts: { key: string; value: Draft; indexes: { byKind: string } };
  outbox: { key: string; value: OutboxItem; indexes: { byCreatedAt: string } };
}

let dbPromise: Promise<IDBPDatabase<SentinelDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<SentinelDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SentinelDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("library")) db.createObjectStore("library", { keyPath: "key" });
        if (!db.objectStoreNames.contains("drafts")) {
          db.createObjectStore("drafts", { keyPath: "id" }).createIndex("byKind", "kind");
        }
        if (!db.objectStoreNames.contains("outbox")) {
          db.createObjectStore("outbox", { keyPath: "id" }).createIndex("byCreatedAt", "createdAt");
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

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

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
  return (await db.count("drafts")) + (await db.count("outbox"));
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
