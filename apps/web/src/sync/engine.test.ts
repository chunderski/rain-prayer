import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Answer, PhotoMeta } from "@sentinel/shared";
import { createApiClient } from "../api/client";
import { getDb, resetDbForTests, type LocalPhoto } from "../offline/db";
import { getRecord, saveAnswer, savePhotoCapture, saveFinding } from "../field/repo";
import { createApiTransport } from "./transport";
import { backoffDelay, SyncEngine } from "./engine";

const USER = "b0000000-0000-4000-8000-000000000001";
const TENANT = "a0000000-0000-4000-8000-000000000001";
const ASSESSMENT = "e0000000-0000-4000-8000-000000000001";
const ctx = { userId: USER, tenantId: TENANT };
const session = { user: { id: USER, email: "a@x.test", name: "Alex" }, tenant: { id: TENANT, slug: "acme", name: "Acme" }, role: "assessor" };

type Handler = (req: { method: string; path: string; body: unknown; headers: Record<string, string> }) => Response | Promise<Response> | "network";
interface Call {
  method: string;
  path: string;
  body: unknown;
  contentType?: string;
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function harness(handler: Handler, opts: { random?: () => number; online?: () => boolean; user?: typeof ctx } = {}) {
  const calls: Call[] = [];
  const timers: number[] = [];
  let clock = 1_000_000;
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    const path = url.pathname + url.search;
    if (url.pathname === "/auth/refresh") return json(200, { accessToken: "tok", session });
    calls.push({ method, path, body, contentType: headers["Content-Type"] });
    const res = await handler({ method, path: url.pathname, body, headers });
    if (res === "network") throw new TypeError("Failed to fetch");
    return res;
  }) as typeof fetch;
  const api = createApiClient({ baseUrl: "http://api.test", fetch: fetchMock });
  const engine = new SyncEngine({
    transport: createApiTransport(api),
    getContext: () => opts.user ?? ctx,
    isOnline: opts.online ?? (() => true),
    random: opts.random ?? (() => 1),
    now: () => clock,
    setTimer: (_fn, ms) => {
      timers.push(ms);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { engine, calls, timers, advance: (ms: number) => (clock += ms) };
}

const pullEmpty = () => json(200, { cursor: "c1", changes: [], hasMore: false });

/** A server that applies every op with version 1 and stores photos. */
const okServer: Handler = ({ method, path, body }) => {
  if (path === "/sync/push") {
    const ops = (body as { ops: { opId: string }[] }).ops;
    return json(200, { results: ops.map((o) => ({ opId: o.opId, status: "applied", version: 1 })) });
  }
  if (method === "PUT" && path.endsWith("/content")) return json(200, photoServer(path.split("/")[2]!));
  if (path === "/sync/pull") return pullEmpty();
  return json(404, { error: { code: "not_found", message: "no mock" } });
};

let photoMetaById: Record<string, PhotoMeta> = {};
const photoServer = (id: string) => ({ ...photoMetaById[id]!, status: "stored", sha256: "a".repeat(64), width: 100, height: 80 });

const answer = (over: Partial<Answer> = {}): Answer => ({
  id: crypto.randomUUID(),
  assessmentId: ASSESSMENT,
  questionId: "Q-LGT-001-01",
  areaId: null,
  value: { kind: "choice", value: "no" },
  answeredAt: new Date().toISOString(),
  ...over,
});

const photoMeta = (): PhotoMeta => {
  const m: PhotoMeta = {
    id: crypto.randomUUID(),
    assessmentId: ASSESSMENT,
    areaId: null,
    assetId: null,
    findingId: null,
    controlIds: ["SC-LGT-001"],
    assetType: "lighting",
    severity: "high",
    capturedAt: new Date().toISOString(),
    gps: null,
    contentType: "image/jpeg",
    byteSize: 4,
  };
  photoMetaById[m.id] = m;
  return m;
};

const pushCalls = (calls: Call[]) => calls.filter((c) => c.path === "/sync/push");

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  photoMetaById = {};
});
afterEach(async () => {
  await resetDbForTests();
});

describe("backoffDelay", () => {
  it("doubles from the base, caps, and jitters within [d/2, d]", () => {
    expect(backoffDelay(1, () => 1)).toBe(2000);
    expect(backoffDelay(2, () => 1)).toBe(4000);
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(30, () => 1)).toBe(300_000);
    expect(backoffDelay(30, () => 0)).toBe(150_000);
  });
});

describe("sync engine push", () => {
  it("applied: sends the op with client id, null baseVersion, and timestamp, then stores the version", async () => {
    const h = harness(okServer);
    const a = answer();
    await saveAnswer(ctx, a);
    expect((await h.engine.refreshCounts()).pending).toBe(1);
    await h.engine.syncNow();
    const [push] = pushCalls(h.calls);
    const sent = (push!.body as { deviceId: string; ops: Record<string, unknown>[] });
    expect(sent.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.ops).toHaveLength(1);
    expect(sent.ops[0]).toMatchObject({ entity: "answer", action: "upsert", id: a.id, baseVersion: null, data: { id: a.id, value: { kind: "choice", value: "no" } } });
    expect(sent.ops[0]!.clientUpdatedAt).toEqual(expect.any(String));
    const rec = await getRecord("answers", a.id);
    expect(rec).toMatchObject({ version: 1, pendingOps: 0 });
    expect(h.engine.getStatus()).toMatchObject({ state: "idle", pending: 0, conflicts: 0, rejected: 0 });
  });

  it("coalesces unsent edits of one record into one op and sends the latest version next time", async () => {
    const h = harness(okServer);
    const a = answer();
    await saveAnswer(ctx, a);
    await saveAnswer(ctx, { ...a, value: { kind: "choice", value: "yes" } });
    await h.engine.syncNow();
    const ops = (pushCalls(h.calls)[0]!.body as { ops: { data: Answer }[] }).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.data.value).toEqual({ kind: "choice", value: "yes" });
    await saveAnswer(ctx, { ...a, value: { kind: "choice", value: "partial" } });
    await h.engine.syncNow();
    expect((pushCalls(h.calls)[1]!.body as { ops: { baseVersion: number }[] }).ops[0]!.baseVersion).toBe(1);
  });

  it("duplicate: treated as delivered", async () => {
    const h = harness(({ path, body }) => {
      if (path === "/sync/push") return json(200, { results: (body as { ops: { opId: string }[] }).ops.map((o) => ({ opId: o.opId, status: "duplicate", version: 3 })) });
      return pullEmpty();
    });
    const a = answer();
    await saveAnswer(ctx, a);
    await h.engine.syncNow();
    expect(await getRecord("answers", a.id)).toMatchObject({ version: 3, pendingOps: 0 });
    expect(await (await getDb()).count("syncOps")).toBe(0);
  });

  it("conflict: shows the server's winning copy, keeps both for review, and can re-send mine", async () => {
    let round = 0;
    const h = harness(({ path, body }) => {
      if (path !== "/sync/push") return pullEmpty();
      round++;
      const ops = (body as { ops: { opId: string; data: Answer; baseVersion: number | null }[] }).ops;
      if (round === 1) {
        const server = { ...ops[0]!.data, value: { kind: "choice", value: "yes" }, version: 4 };
        return json(200, { results: [{ opId: ops[0]!.opId, status: "conflict", version: 4, server }] });
      }
      expect(ops[0]!.baseVersion).toBe(4);
      return json(200, { results: [{ opId: ops[0]!.opId, status: "applied", version: 5 }] });
    });
    const a = answer();
    await saveAnswer(ctx, a);
    await h.engine.syncNow();
    const rec = await getRecord<Answer>("answers", a.id);
    expect(rec!.data.value).toEqual({ kind: "choice", value: "yes" });
    expect(rec!.version).toBe(4);
    expect(h.engine.getStatus().conflicts).toBe(1);
    const [conflict] = await (await getDb()).getAll("conflicts");
    expect(conflict).toMatchObject({ recordId: a.id, local: { value: { kind: "choice", value: "no" } }, server: { value: { kind: "choice", value: "yes" } } });

    await h.engine.useMine(ctx, conflict!.id);
    await h.engine.syncNow();
    const after = await getRecord<Answer>("answers", a.id);
    expect(after!.data.value).toEqual({ kind: "choice", value: "no" });
    expect(after!.version).toBe(5);
    expect(h.engine.getStatus().conflicts).toBe(0);
  });

  it("rejected: kept with its error, not retried, and can be discarded", async () => {
    const h = harness(({ path, body }) => {
      if (path !== "/sync/push") return pullEmpty();
      const ops = (body as { ops: { opId: string }[] }).ops;
      return json(200, { results: ops.map((o) => ({ opId: o.opId, status: "rejected", version: null, error: { code: "forbidden", message: "Not assigned" } })) });
    });
    await saveAnswer(ctx, answer());
    await h.engine.syncNow();
    expect(h.engine.getStatus()).toMatchObject({ rejected: 1, pending: 0 });
    const [op] = await (await getDb()).getAll("syncOps");
    expect(op).toMatchObject({ status: "rejected", error: { code: "forbidden" } });
    await h.engine.syncNow();
    expect(pushCalls(h.calls)).toHaveLength(1);
    await h.engine.discardRejected(op!.opId);
    expect(h.engine.getStatus().rejected).toBe(0);
  });

  it("only pushes ops of the signed-in user and tenant (QA R-11)", async () => {
    const h = harness(okServer, { user: { userId: "b0000000-0000-4000-8000-000000000009", tenantId: TENANT } });
    await saveAnswer(ctx, answer());
    await h.engine.syncNow();
    expect(pushCalls(h.calls)).toHaveLength(0);
  });

  it("retries with exponential backoff and jitter, then resets after a success", async () => {
    let fail = 3;
    const h = harness(
      (req) => {
        if (fail > 0) {
          fail--;
          return fail === 2 ? "network" : json(503, { error: { code: "unavailable", message: "Down" } });
        }
        return okServer(req);
      },
      { random: () => 1 },
    );
    await saveAnswer(ctx, answer());
    await h.engine.syncNow();
    expect(h.engine.getStatus().state).toBe("offline");
    await h.engine.syncNow();
    expect(h.engine.getStatus().state).toBe("retrying");
    await h.engine.syncNow();
    expect(h.timers).toEqual([2000, 4000, 8000]);
    expect(h.engine.getStatus().nextRetryAt).toBe(1_000_000 + 8000);
    expect(h.engine.getStatus().pending).toBe(1);
    await h.engine.syncNow();
    expect(h.engine.getStatus()).toMatchObject({ state: "idle", pending: 0, nextRetryAt: null });
  });

  it("does nothing but count while the device is offline", async () => {
    const h = harness(okServer, { online: () => false });
    await saveAnswer(ctx, answer());
    await h.engine.syncNow();
    expect(h.calls).toHaveLength(0);
    expect(h.engine.getStatus()).toMatchObject({ state: "offline", pending: 1 });
  });
});

describe("photo upload", () => {
  it("uploads bytes only after the metadata op is applied, then pulls", async () => {
    const h = harness(okServer);
    const m = photoMeta();
    const finding = { id: crypto.randomUUID(), assessmentId: ASSESSMENT, areaId: null, assetId: null, title: "Dark entrance", description: "", severity: "high" as const, status: "draft" as const, source: "assessor" as const, controlIds: ["SC-LGT-001"], suggestionId: null };
    await saveFinding(ctx, finding);
    await savePhotoCapture(ctx, { ...m, findingId: finding.id }, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
    expect((await h.engine.refreshCounts()).pending).toBe(2); // finding op and photo metadata op
    await h.engine.syncNow();
    expect(h.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual(["POST /sync/push", `PUT /photos/${m.id}/content`]);
    const ops = (h.calls[0]!.body as { ops: { entity: string }[] }).ops;
    expect(ops.map((o) => o.entity)).toEqual(["finding", "photo_meta"]);
    expect(h.calls[1]!.contentType).toBe("image/jpeg");
    const p = (await getRecord("photos", m.id)) as LocalPhoto;
    expect(p).toMatchObject({ upload: "done", serverStatus: "stored", version: 1 });
    expect(h.engine.getStatus().pending).toBe(0);
  });

  it("does not upload bytes when the metadata op was rejected", async () => {
    const h = harness(({ path, body }) => {
      if (path === "/sync/push") return json(200, { results: (body as { ops: { opId: string }[] }).ops.map((o) => ({ opId: o.opId, status: "rejected", version: null, error: { code: "invalid", message: "Bad" } })) });
      return pullEmpty();
    });
    await savePhotoCapture(ctx, photoMeta(), new ArrayBuffer(4));
    await h.engine.syncNow();
    expect(h.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("creates the photo record and retries when the content endpoint answers 404", async () => {
    let created = false;
    const h = harness((req) => {
      if (req.method === "PUT" && !created) return json(404, { error: { code: "not_found", message: "No photo" } });
      if (req.method === "POST" && /\/assessments\/.+\/photos$/.test(req.path)) {
        created = true;
        return json(201, { ...(req.body as object), status: "pending_upload", sha256: null, width: null, height: null });
      }
      return okServer(req);
    });
    const m = photoMeta();
    await savePhotoCapture(ctx, m, new ArrayBuffer(4));
    await h.engine.syncNow();
    expect(h.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "POST /sync/push",
      `PUT /photos/${m.id}/content`,
      `POST /assessments/${ASSESSMENT}/photos`,
      `PUT /photos/${m.id}/content`,
    ]);
  });

  it("resumes an interrupted upload after a reload without re-sending applied ops", async () => {
    let drop = true;
    const first = harness((req) => (req.method === "PUT" && drop ? "network" : okServer(req)));
    const m = photoMeta();
    await savePhotoCapture(ctx, m, new Uint8Array([1, 2, 3, 4]).buffer);
    await first.engine.syncNow();
    expect(((await getRecord("photos", m.id)) as LocalPhoto).upload).toBe("ready");
    first.engine.stop();

    // "Reload": close the database connection and start a fresh engine on the same storage.
    await resetDbForTests();
    drop = false;
    const second = harness(okServer);
    await second.engine.refreshCounts();
    expect(second.engine.getStatus().pending).toBe(1);
    await second.engine.syncNow();
    expect(second.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([`PUT /photos/${m.id}/content`]);
    expect(((await getRecord("photos", m.id)) as LocalPhoto).upload).toBe("done");
  });

  it("backs off a photo after a server error without blocking other work", async () => {
    const h = harness((req) => (req.method === "PUT" ? json(500, { error: { code: "boom", message: "Storage down" } }) : okServer(req)));
    const m = photoMeta();
    await savePhotoCapture(ctx, m, new ArrayBuffer(4));
    await h.engine.syncNow();
    const p = (await getRecord("photos", m.id)) as LocalPhoto;
    expect(p).toMatchObject({ upload: "ready", uploadAttempts: 1, nextUploadAt: 1_000_000 + 2000 });
    expect(h.engine.getStatus().state).toBe("retrying");
  });
});

describe("pull", () => {
  it("applies server changes, saves the cursor, and never overwrites queued local edits", async () => {
    const remote = answer({ value: { kind: "choice", value: "yes" } });
    const mine = answer({ questionId: "Q-LGT-001-02" });
    const pulls: string[] = [];
    const h = harness(({ path }) => {
      if (path === "/sync/pull") {
        pulls.push(path);
        return json(200, {
          cursor: "c9",
          hasMore: false,
          changes: [
            { entity: "answer", id: remote.id, version: 7, deleted: false, data: remote },
            { entity: "answer", id: mine.id, version: 9, deleted: false, data: { ...mine, value: { kind: "choice", value: "na" } } },
          ],
        });
      }
      return json(200, { results: [] });
    });
    await (await getDb()).put("walkthroughs", { assessmentId: ASSESSMENT, data: {}, cachedAt: "x" });
    await saveAnswer(ctx, mine);
    await h.engine.syncNow();
    expect(await getRecord("answers", remote.id)).toMatchObject({ version: 7, pendingOps: 0 });
    expect((await getRecord<Answer>("answers", mine.id))!.data.value).toEqual({ kind: "choice", value: "no" });
    expect(h.calls.find((c) => c.path.startsWith("/sync/pull"))!.path).toContain(`assessmentId=${ASSESSMENT}`);
    expect((await (await getDb()).get("meta", `cursor:${ASSESSMENT}`))!.value).toBe("c9");
  });
});
