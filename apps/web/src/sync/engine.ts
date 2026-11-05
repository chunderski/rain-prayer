/**
 * Sync engine: drains the local outbox to POST /sync/push, uploads photo bytes once their
 * metadata op is applied, and pulls server changes with a cursor per cached assessment.
 *
 * Order of a run: push (batches of up to 50 ops, at most one op per record per batch so each op
 * carries the version the previous one produced), photo uploads, then pull.
 *
 * Results (docs/api-phase2.md):
 *  - applied, duplicate: op removed, record version updated.
 *  - conflict: op removed; the server's winning record replaces the local copy (unless newer local
 *    ops are queued) and both copies are kept in `conflicts` for review.
 *  - rejected: op kept with status "rejected" and its error; never retried automatically.
 * Network, 5xx, and 429 failures back off exponentially with jitter (2 s doubling, 5 min cap,
 * delay drawn from [d/2, d]). A 401 that cannot be refreshed pauses sync until sign in.
 *
 * Everything lives in IndexedDB, so a reload resumes exactly where the last run stopped: queued
 * ops are re-sent (the server de-duplicates by opId) and photos whose upload was interrupted are
 * PUT again (the content endpoint is idempotent per photo id).
 */
import type { PhotoMeta, SyncOp, SyncOpResult } from "@sentinel/shared";
import { getDb, getMeta, notifyLocalChange, setMeta, uuid, type ConflictEntry, type LocalPhoto, type LocalRecord, type QueuedOp } from "../offline/db";
import { STORE_OF, writeRecord, type WriteCtx } from "../field/repo";
import { TransportError, type SyncTransport } from "./transport";

export type SyncState = "idle" | "syncing" | "offline" | "waiting_auth" | "retrying";

export interface SyncStatus {
  state: SyncState;
  /** Ops waiting to be pushed plus photos waiting to upload. */
  pending: number;
  conflicts: number;
  rejected: number;
  lastSyncedAt: string | null;
  nextRetryAt: number | null;
  lastError: string | null;
}

export interface SyncEngineOptions {
  transport: SyncTransport;
  /** The signed-in user and tenant, or null when there is none. */
  getContext: () => WriteCtx | null;
  isOnline?: () => boolean;
  now?: () => number;
  random?: () => number;
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const PULL_LIMIT = 500;

/** Exponential backoff with jitter: base * 2^(n-1), capped, then a uniform draw from [d/2, d]. */
export function backoffDelay(failures: number, random: () => number, base = 2000, max = 300_000): number {
  const d = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  return Math.floor(d / 2 + random() * (d / 2));
}

export async function getDeviceId(): Promise<string> {
  const existing = await getMeta<string>("deviceId");
  if (existing) return existing;
  const id = uuid();
  await setMeta("deviceId", id);
  return id;
}

export class SyncEngine {
  private readonly o: Required<Omit<SyncEngineOptions, "transport" | "getContext">> & Pick<SyncEngineOptions, "transport" | "getContext">;
  private running: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private retryHandle: unknown = null;
  private listeners = new Set<(s: SyncStatus) => void>();
  private status: SyncStatus = { state: "idle", pending: 0, conflicts: 0, rejected: 0, lastSyncedAt: null, nextRetryAt: null, lastError: null };
  private stopped = false;

  constructor(opts: SyncEngineOptions) {
    this.o = {
      isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
      now: () => Date.now(),
      random: Math.random,
      batchSize: 50,
      baseDelayMs: 2000,
      maxDelayMs: 300_000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** (Re)start after stop(). React StrictMode mounts effects twice in development, so the provider calls this on every mount. */
  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.retryHandle) this.o.clearTimer(this.retryHandle);
    this.retryHandle = null;
  }

  private emit(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of [...this.listeners]) l(this.status);
  }

  /** Recount pending, conflict, and rejected items for the current user and tenant. */
  async refreshCounts(): Promise<SyncStatus> {
    const ctx = this.o.getContext();
    const db = await getDb();
    const ops = (await db.getAll("syncOps")).filter((o) => !ctx || (o.userId === ctx.userId && o.tenantId === ctx.tenantId));
    const photos = (await db.getAll("photos")) as LocalPhoto[];
    // A photo waiting for its metadata op is already counted by that op.
    const uploads = photos.filter((p) => !p.deleted && p.upload === "ready").length;
    const failedUploads = photos.filter((p) => p.lastUploadError && p.upload === "ready" && p.nextUploadAt === Number.MAX_SAFE_INTEGER).length;
    this.emit({
      pending: ops.filter((o) => o.status === "pending").length + uploads,
      rejected: ops.filter((o) => o.status === "rejected").length + failedUploads,
      conflicts: await db.count("conflicts"),
    });
    return this.status;
  }

  /** Run a sync now. Concurrent calls share the run; a call during a run schedules one more. */
  syncNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private scheduleRetry() {
    const delay = backoffDelay(this.failures, this.o.random, this.o.baseDelayMs, this.o.maxDelayMs);
    if (this.retryHandle) this.o.clearTimer(this.retryHandle);
    const at = this.o.now() + delay;
    this.retryHandle = this.o.setTimer(() => {
      this.retryHandle = null;
      void this.syncNow();
    }, delay);
    return at;
  }

  private async runOnce(): Promise<void> {
    const ctx = this.o.getContext();
    if (!ctx) {
      await this.refreshCounts();
      this.emit({ state: "waiting_auth" });
      return;
    }
    if (!this.o.isOnline()) {
      await this.refreshCounts();
      this.emit({ state: "offline" });
      return;
    }
    this.emit({ state: "syncing" });
    try {
      const auth = await this.o.transport.ensureAuth();
      if (auth === "offline") throw new TransportError("network", "No connection");
      if (auth === "signed_out") {
        await this.refreshCounts();
        this.emit({ state: "waiting_auth", lastError: "Sign in again to send your changes." });
        return;
      }
      await this.pushAll(ctx);
      await this.uploadPhotos();
      await this.pullAll();
      this.failures = 0;
      if (this.retryHandle) this.o.clearTimer(this.retryHandle);
      this.retryHandle = null;
      await this.refreshCounts();
      // Photos still backing off keep the engine in retrying mode.
      const waiting = await this.nextPhotoRetry();
      if (waiting !== null) {
        this.failures = Math.max(this.failures, 1);
        this.emit({ state: "retrying", nextRetryAt: this.scheduleRetryAt(waiting), lastSyncedAt: new Date(this.o.now()).toISOString(), lastError: null });
      } else {
        this.emit({ state: "idle", lastSyncedAt: new Date(this.o.now()).toISOString(), nextRetryAt: null, lastError: null });
      }
    } catch (err) {
      const e = err instanceof TransportError ? err : new TransportError("server", err instanceof Error ? err.message : "Sync failed");
      await this.refreshCounts();
      if (e.kind === "auth") {
        this.emit({ state: "waiting_auth", lastError: "Sign in again to send your changes." });
        return;
      }
      this.failures += 1;
      const at = this.scheduleRetry();
      this.emit({ state: this.o.isOnline() && e.kind !== "network" ? "retrying" : "offline", nextRetryAt: at, lastError: e.message });
    } finally {
      notifyLocalChange();
    }
  }

  private scheduleRetryAt(at: number): number {
    const delay = Math.max(0, at - this.o.now());
    if (this.retryHandle) this.o.clearTimer(this.retryHandle);
    this.retryHandle = this.o.setTimer(() => {
      this.retryHandle = null;
      void this.syncNow();
    }, delay);
    return at;
  }

  private async nextPhotoRetry(): Promise<number | null> {
    const photos = (await (await getDb()).getAllFromIndex("photos", "byUpload", "ready")) as LocalPhoto[];
    const times = photos.filter((p) => !p.deleted && p.nextUploadAt > this.o.now() && p.nextUploadAt < Number.MAX_SAFE_INTEGER).map((p) => p.nextUploadAt);
    return times.length ? Math.min(...times) : null;
  }

  // ---------- push ----------

  private async pushAll(ctx: WriteCtx): Promise<void> {
    const deviceId = await getDeviceId();
    for (let round = 0; round < 100; round++) {
      const db = await getDb();
      const queued = (await db.getAllFromIndex("syncOps", "bySeq")).filter(
        (o) => o.status === "pending" && o.userId === ctx.userId && o.tenantId === ctx.tenantId,
      );
      if (!queued.length) return;
      const seen = new Set<string>();
      const batch: QueuedOp[] = [];
      for (const q of queued) {
        if (seen.has(q.op.id)) continue; // one op per record per batch
        seen.add(q.op.id);
        batch.push(q);
        if (batch.length >= this.o.batchSize) break;
      }
      // Mark as attempted (so later edits queue a new op instead of mutating one in flight) and
      // fill baseVersion from the record's current version.
      const ops: SyncOp[] = [];
      {
        const tx = db.transaction(["syncOps", "areas", "assets", "answers", "findings", "photos"], "readwrite");
        for (const q of batch) {
          const rec = (await tx.objectStore(q.store).get(q.op.id)) as LocalRecord | undefined;
          q.attempts += 1;
          q.op = { ...q.op, baseVersion: rec?.version ?? q.op.baseVersion ?? null };
          await tx.objectStore("syncOps").put(q);
          const { opId, entity, action, id, data, baseVersion, clientUpdatedAt } = q.op;
          ops.push({ opId, entity, action, id, ...(data !== undefined ? { data } : {}), baseVersion, clientUpdatedAt });
        }
        await tx.done;
      }
      const results = await this.o.transport.push(deviceId, ops);
      await this.applyResults(batch, results);
      // A server that answered none of our ops: stop for now, they stay queued for the next run.
      if (!results.some((r) => batch.some((q) => q.opId === r.opId))) return;
    }
  }

  private async applyResults(batch: QueuedOp[], results: SyncOpResult[]): Promise<void> {
    const byId = new Map(results.map((r) => [r.opId, r]));
    const db = await getDb();
    const tx = db.transaction(["syncOps", "conflicts", "areas", "assets", "answers", "findings", "photos", "photoBlobs"], "readwrite");
    for (const q of batch) {
      const r = byId.get(q.opId);
      if (!r) continue; // left pending, retried next run
      const recStore = tx.objectStore(q.store);
      const rec = (await recStore.get(q.op.id)) as LocalPhoto | undefined;
      if (r.status === "rejected") {
        await tx.objectStore("syncOps").put({ ...q, status: "rejected", error: r.error ?? { code: "rejected", message: "The server rejected this change." } });
        continue;
      }
      await tx.objectStore("syncOps").delete(q.opId);
      if (!rec) continue;
      const next: LocalPhoto = { ...rec, pendingOps: Math.max(0, rec.pendingOps - 1) };
      if (r.version !== null && r.version !== undefined) next.version = r.version;
      if (r.status === "conflict") {
        const entry: ConflictEntry = {
          id: q.opId,
          opId: q.opId,
          assessmentId: q.assessmentId,
          store: q.store,
          entity: q.op.entity,
          recordId: q.op.id,
          local: q.op.data ?? null,
          server: r.server ?? null,
          serverVersion: r.version ?? null,
          at: new Date(this.o.now()).toISOString(),
        };
        await tx.objectStore("conflicts").put(entry);
        // Show the winning copy unless the user has made newer edits that are still queued.
        if (next.pendingOps === 0 && r.server && typeof r.server === "object") {
          const { version: _v, ...data } = r.server as Record<string, unknown>;
          next.data = data;
          next.deleted = false;
        }
      }
      if (q.store === "photos" && next.upload === "waiting_meta") next.upload = "ready";
      if (next.deleted && next.pendingOps === 0) {
        await recStore.delete(next.id);
        if (q.store === "photos") await tx.objectStore("photoBlobs").delete(next.id);
      } else {
        await recStore.put(next);
      }
    }
    await tx.done;
  }

  // ---------- photo bytes ----------

  private async uploadPhotos(): Promise<void> {
    const db = await getDb();
    const ready = ((await db.getAllFromIndex("photos", "byUpload", "ready")) as LocalPhoto<PhotoMeta>[])
      .filter((p) => !p.deleted && p.nextUploadAt <= this.o.now())
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const p of ready) {
      const blob = await db.get("photoBlobs", p.id);
      if (!blob) {
        await this.patchPhoto(p.id, { upload: "done" });
        continue;
      }
      const body = new Blob([blob.bytes], { type: blob.contentType });
      try {
        let stored;
        try {
          stored = await this.o.transport.uploadPhoto(p.id, body, blob.contentType);
        } catch (err) {
          // The record is missing on the server (for example it was restored from a backup):
          // create it from the local metadata, then send the bytes again.
          if (!(err instanceof TransportError) || err.kind !== "not_found") throw err;
          await this.o.transport.createPhoto(p.data);
          stored = await this.o.transport.uploadPhoto(p.id, body, blob.contentType);
        }
        await this.patchPhoto(p.id, {
          upload: "done",
          serverStatus: stored.status,
          width: stored.width,
          height: stored.height,
          lastUploadError: undefined,
          dataPatch: { status: stored.status, sha256: stored.sha256, width: stored.width, height: stored.height },
        });
      } catch (err) {
        const e = err instanceof TransportError ? err : new TransportError("server", "Upload failed");
        if (e.kind === "network" || e.kind === "auth") throw e;
        const attempts = p.uploadAttempts + 1;
        // Client errors (unsupported type, too large) are not retried automatically.
        const nextUploadAt = e.kind === "client" ? Number.MAX_SAFE_INTEGER : this.o.now() + backoffDelay(attempts, this.o.random, this.o.baseDelayMs, this.o.maxDelayMs);
        await this.patchPhoto(p.id, { uploadAttempts: attempts, nextUploadAt, lastUploadError: e.message });
      }
    }
  }

  private async patchPhoto(id: string, patch: Partial<LocalPhoto> & { dataPatch?: Record<string, unknown> }) {
    const db = await getDb();
    const p = (await db.get("photos", id)) as LocalPhoto | undefined;
    if (!p) return;
    const { dataPatch, ...rest } = patch;
    await db.put("photos", { ...p, ...rest, data: dataPatch ? { ...(p.data as object), ...dataPatch } : p.data });
  }

  // ---------- pull ----------

  private async pullAll(): Promise<void> {
    const db = await getDb();
    const ids = await db.getAllKeys("walkthroughs");
    for (const assessmentId of ids) {
      let cursor = (await getMeta<string>(`cursor:${assessmentId}`)) ?? null;
      for (let page = 0; page < 50; page++) {
        const res = await this.o.transport.pull(assessmentId, cursor, PULL_LIMIT);
        await this.applyChanges(assessmentId, res.changes);
        cursor = res.cursor;
        await setMeta(`cursor:${assessmentId}`, cursor);
        if (!res.hasMore) break;
      }
    }
  }

  private async applyChanges(assessmentId: string, changes: { entity: QueuedOp["op"]["entity"]; id: string; version: number; deleted: boolean; data: unknown }[]) {
    if (!changes.length) return;
    const db = await getDb();
    const tx = db.transaction(["areas", "assets", "answers", "findings", "photos", "photoBlobs"], "readwrite");
    for (const c of changes) {
      const store = STORE_OF[c.entity];
      const s = tx.objectStore(store);
      const existing = (await s.get(c.id)) as LocalPhoto | undefined;
      if (existing && existing.pendingOps > 0) continue; // local edits win until pushed; the server resolves conflicts
      if (c.deleted) {
        await s.delete(c.id);
        if (store === "photos") await tx.objectStore("photoBlobs").delete(c.id);
        continue;
      }
      const data = (c.data ?? {}) as Record<string, unknown>;
      const rec: LocalPhoto = {
        ...(existing ?? { serverStatus: null, upload: "done", uploadAttempts: 0, nextUploadAt: 0 }),
        id: c.id,
        assessmentId: typeof data.assessmentId === "string" ? data.assessmentId : assessmentId,
        ...(typeof data.siteId === "string" ? { siteId: data.siteId } : {}),
        data,
        version: c.version,
        pendingOps: 0,
        deleted: false,
        updatedAt: new Date(this.o.now()).toISOString(),
      };
      if (store === "photos") {
        rec.serverStatus = data.status === "stored" ? "stored" : "pending_upload";
        if (rec.serverStatus === "stored") rec.upload = "done";
        else if (existing?.upload === "waiting_meta") rec.upload = "ready";
      }
      await s.put(rec);
    }
    await tx.done;
  }

  // ---------- user actions ----------

  /** Keep the server copy: drop the conflict entry. */
  async keepServer(conflictId: string): Promise<void> {
    await (await getDb()).delete("conflicts", conflictId);
    await this.refreshCounts();
    notifyLocalChange();
  }

  /** Use my copy: queue it again on top of the server version, then drop the conflict entry. */
  async useMine(ctx: WriteCtx, conflictId: string): Promise<void> {
    const db = await getDb();
    const c = await db.get("conflicts", conflictId);
    if (!c) return;
    if (c.local && typeof c.local === "object") {
      const rec = await db.get(c.store, c.recordId);
      await writeRecord(ctx, c.store, { id: c.recordId, assessmentId: c.assessmentId, siteId: rec?.siteId, data: c.local });
    }
    await db.delete("conflicts", conflictId);
    await this.refreshCounts();
    void this.syncNow();
  }

  /** Discard a rejected op. A record the server never had is removed from the device. */
  async discardRejected(opId: string): Promise<void> {
    const db = await getDb();
    const q = await db.get("syncOps", opId);
    if (!q) return;
    const tx = db.transaction(["syncOps", q.store], "readwrite");
    await tx.objectStore("syncOps").delete(opId);
    const rec = (await tx.objectStore(q.store).get(q.op.id)) as LocalRecord | undefined;
    if (rec) {
      const pendingOps = Math.max(0, rec.pendingOps - 1);
      if (pendingOps === 0 && rec.version === null) await tx.objectStore(q.store).delete(rec.id);
      else await tx.objectStore(q.store).put({ ...rec, pendingOps });
    }
    await tx.done;
    await this.refreshCounts();
    notifyLocalChange();
  }
}

export async function listConflicts(): Promise<ConflictEntry[]> {
  return (await getDb()).getAll("conflicts");
}

export async function listRejected(ctx: WriteCtx | null): Promise<QueuedOp[]> {
  return (await (await getDb()).getAll("syncOps")).filter((o) => o.status === "rejected" && (!ctx || (o.userId === ctx.userId && o.tenantId === ctx.tenantId)));
}
