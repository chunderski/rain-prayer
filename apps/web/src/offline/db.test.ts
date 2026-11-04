import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { enqueue, getDraft, getLibrary, listOutbox, outboxCount, putLibrary, removeFromOutbox, resetDbForTests, saveDraft, clearDrafts } from "./db";

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
