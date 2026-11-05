import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { enqueue, getDraft, getLibrary, listOutbox, outboxCount, putLibrary, removeFromOutbox, resetDbForTests, saveDraft, clearDrafts, DB_NAME, getDb, setMeta, getMeta, clearClientData } from "./db";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  await resetDbForTests();
});

describe("outbox", () => {
  it("enqueues typed items as pending with an id and idempotency key", async () => {
    const item = await enqueue({ kind: "create_client", method: "POST", path: "/clients", body: { name: "Acme" } });
    expect(item).toMatchObject({ kind: "create_client", method: "POST", path: "/clients", status: "pending", attempts: 0 });
    expect(item.id).toBeTruthy();
    expect(item.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(await outboxCount()).toBe(1);
  });

  it("lists items oldest first and removes them", async () => {
    const a = await enqueue({ kind: "create_client", method: "POST", path: "/clients", body: { name: "A" } });
    await new Promise((r) => setTimeout(r, 2));
    const b = await enqueue({ kind: "create_site", method: "POST", path: "/sites", body: { name: "B" } });
    expect((await listOutbox()).map((i) => i.id)).toEqual([a.id, b.id]);
    await removeFromOutbox(a.id);
    expect((await listOutbox()).map((i) => i.id)).toEqual([b.id]);
  });

  it("keeps a caller-supplied idempotency key", async () => {
    const item = await enqueue({ kind: "create_assessment", method: "POST", path: "/assessments", idempotencyKey: "fixed-key-123" });
    expect(item.idempotencyKey).toBe("fixed-key-123");
  });

  it("refuses to queue auth requests or unknown kinds", async () => {
    await expect(enqueue({ kind: "create_client", method: "POST", path: "/auth/login" })).rejects.toThrow();
    for (const path of ["/./auth/login", "/%2e/auth/refresh", "/clients/../auth/logout", "//auth/login", "/AUTH/login", "/clients\\..\\auth"]) {
      await expect(enqueue({ kind: "create_client", method: "POST", path })).rejects.toThrow();
    }
    // @ts-expect-error unknown kind
    await expect(enqueue({ kind: "delete_everything", method: "POST", path: "/x" })).rejects.toThrow();
    await expect(enqueue({ kind: "create_client", method: "POST", path: "clients" })).rejects.toThrow();
    expect(await outboxCount()).toBe(0);
  });

  it("persists across connections", async () => {
    await enqueue({ kind: "create_client", method: "POST", path: "/clients" });
    await resetDbForTests();
    expect(await outboxCount()).toBe(1);
  });
});

describe("library cache and drafts", () => {
  it("stores library responses by path", async () => {
    await putLibrary("/frameworks", [{ id: "cpted" }]);
    const hit = await getLibrary("/frameworks");
    expect(hit?.data).toEqual([{ id: "cpted" }]);
    expect(hit?.cachedAt).toMatch(/^\d{4}-/);
  });

  it("saves drafts and clears them on sign out", async () => {
    await saveDraft("new-assessment", "assessment_wizard", { step: 2 });
    expect((await getDraft<{ step: number }>("new-assessment"))?.data.step).toBe(2);
    await clearDrafts();
    expect(await getDraft("new-assessment")).toBeUndefined();
  });
});

describe("version 2 migration", () => {
  it("upgrades a version 1 database without losing the library cache or drafts", async () => {
    const { openDB } = await import("idb");
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("library", { keyPath: "key" });
        db.createObjectStore("drafts", { keyPath: "id" }).createIndex("byKind", "kind");
        db.createObjectStore("outbox", { keyPath: "id" }).createIndex("byCreatedAt", "createdAt");
      },
    });
    await v1.put("library", { key: "/frameworks", data: [1], cachedAt: "t" });
    await v1.put("drafts", { id: "wizard", kind: "assessment_wizard", data: { step: 2 }, updatedAt: "t" });
    v1.close();
    expect((await getLibrary("/frameworks"))?.data).toEqual([1]);
    expect((await getDraft("wizard"))?.data).toEqual({ step: 2 });
    const db = await getDb();
    expect(db.version).toBe(2);
    for (const s of ["walkthroughs", "areas", "assets", "answers", "findings", "photos", "photoBlobs", "suggestions", "syncOps", "conflicts", "meta"]) {
      expect(db.objectStoreNames.contains(s as never)).toBe(true);
    }
  });

  it("clearClientData wipes field data and the cached profile but keeps the library cache", async () => {
    await putLibrary("/frameworks", [1]);
    await setMeta("profile", { x: 1 });
    await saveDraft("d", "k", {});
    await clearClientData();
    expect(await getMeta("profile")).toBeUndefined();
    expect(await getDraft("d")).toBeUndefined();
    expect((await getLibrary("/frameworks"))?.data).toEqual([1]);
  });
});
