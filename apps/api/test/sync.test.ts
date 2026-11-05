/** Offline sync: idempotency, conflicts, per-op isolation, pull cursors and tombstones, tenant checks. */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAppInTenant, auth, createUser, fieldFixture, login, makeApp, type FieldFixture } from "./helpers.js";

let app: FastifyInstance;
let owner: string;
let assessor: string;
let other: string;
let blue: string;
let fx: FieldFixture;
let blueFx: FieldFixture;
let acmeId: string;
const deviceId = randomUUID();

const t = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const push = (ops: unknown[], token = assessor) => app.inject({ method: "POST", url: "/sync/push", headers: auth(token), payload: { deviceId, ops } });
const finding = (id: string, over: Record<string, unknown> = {}, a = fx.assessmentId) => ({
  id, assessmentId: a, title: "Gate left open", severity: "medium", controlIds: ["SC-PER-001"], ...over,
});
const op = (entity: string, id: string, data: unknown, baseVersion: number | null, clientUpdatedAt = t(0), action = "upsert") => ({
  opId: randomUUID(), entity, action, id, data, baseVersion, clientUpdatedAt,
});
const pull = (since?: string, limit = 500, token = assessor) =>
  app.inject({ url: `/sync/pull?assessmentId=${fx.assessmentId}${since ? `&since=${since}` : ""}&limit=${limit}`, headers: auth(token) });

beforeAll(async () => {
  app = await makeApp();
  await createUser("assessor3@acme.test", [{ slug: "acme-integrators", role: "assessor" }]);
  owner = (await login(app, "owner@acme.test")).token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  acmeId = a.body.session.tenant.id;
  other = (await login(app, "assessor3@acme.test")).token;
  blue = (await login(app, "owner@bluefield.test")).token;
  fx = await fieldFixture(app, owner, [a.body.session.user.id], "Sync");
  blueFx = await fieldFixture(app, blue, [], "Blue sync");
});
afterAll(() => app.close());

describe("push", () => {
  it("applies and replays idempotently by opId", async () => {
    const id = randomUUID();
    const o = op("finding", id, finding(id), null);
    const first = (await push([o])).json().results[0];
    expect(first).toEqual({ opId: o.opId, status: "applied", version: 1 });
    const again = (await push([o])).json().results[0];
    expect(again).toEqual({ opId: o.opId, status: "duplicate", version: 1 });
    const list = (await app.inject({ url: `/assessments/${fx.assessmentId}/findings`, headers: auth(assessor) })).json();
    expect(list.filter((f: { id: string }) => f.id === id)).toHaveLength(1);
    expect(list.find((f: { id: string }) => f.id === id).version).toBe(1);
  });

  it("one rejected op does not fail the batch; rejections replay as duplicates", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const bad = op("finding", randomUUID(), { title: "x" }, null);
    const res = await push([op("asset", a, { id: a, assessmentId: fx.assessmentId, assetType: "gate", label: "Gate 1" }, null), bad, op("finding", b, finding(b), null)]);
    expect(res.statusCode).toBe(200);
    const r = res.json().results;
    expect(r.map((x: { status: string }) => x.status)).toEqual(["applied", "rejected", "applied"]);
    expect(r[1].error.code).toBe("validation_error");
    expect((await push([bad])).json().results[0]).toMatchObject({ status: "duplicate", error: { code: "validation_error" } });
  });

  it("conflict, server wins: stale op with an older clientUpdatedAt keeps the server copy and logs the losing copy", async () => {
    const id = randomUUID();
    await push([op("finding", id, finding(id), null, t(-60_000))]);
    // Online edit on the server (version 2, clock = now).
    await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor), payload: finding(id, { title: "Server title" }) });
    const o = op("finding", id, finding(id, { title: "Offline title" }), 1, t(-30_000));
    const r = (await push([o])).json().results[0];
    expect(r).toMatchObject({ opId: o.opId, status: "conflict", version: 2 });
    expect(r.server).toMatchObject({ id, title: "Server title", version: 2 });
    await asAppInTenant(acmeId, async (q) => {
      const c = (await q("SELECT winner, losing, lost_fields FROM sync_conflict WHERE op_id = $1", [o.opId])).rows[0];
      expect(c).toMatchObject({ winner: "server", lost_fields: ["title"] });
      expect(c.losing.title).toBe("Offline title");
    });
  });

  it("conflict, client wins: newer clientUpdatedAt is applied and the server copy is logged", async () => {
    const id = randomUUID();
    await push([op("finding", id, finding(id), null, t(-60_000))]);
    await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor), payload: finding(id, { title: "Server title" }) });
    const o = op("finding", id, finding(id, { title: "Newer offline title" }), 1, t(60_000));
    const r = (await push([o])).json().results[0];
    expect(r).toMatchObject({ status: "conflict", version: 3, server: { title: "Newer offline title" } });
    await asAppInTenant(acmeId, async (q) => {
      const c = (await q("SELECT winner, losing FROM sync_conflict WHERE op_id = $1", [o.opId])).rows[0];
      expect(c.winner).toBe("client");
      expect(c.losing.title).toBe("Server title");
    });
  });

  it("field-level: each field goes to its newest writer", async () => {
    const id = randomUUID();
    await push([op("finding", id, finding(id), null, t(-120_000))]);
    await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor), payload: finding(id, { title: "Server title" }) });
    // Offline device edited title and severity 60 s ago: title is older than the server's edit, severity is not.
    const r = (await push([op("finding", id, finding(id, { title: "Offline title", severity: "critical" }), 1, t(-60_000))])).json().results[0];
    expect(r.status).toBe("conflict");
    expect(r.server).toMatchObject({ title: "Server title", severity: "critical" });
  });

  it("baseVersion null for an existing record is a conflict; delete conflicts too", async () => {
    const id = randomUUID();
    await push([op("finding", id, finding(id), null)]);
    const r = (await push([op("finding", id, finding(id, { title: "Dup create" }), null, t(-1000))])).json().results[0];
    expect(r.status).toBe("conflict");
    // Stale delete older than the last write: server keeps the record.
    await app.inject({ method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${id}`, headers: auth(assessor), payload: finding(id, { title: "Changed" }) });
    const del = (await push([op("finding", id, undefined, 1, t(-60_000), "delete")])).json().results[0];
    expect(del).toMatchObject({ status: "conflict", server: { title: "Changed" } });
    const del2 = (await push([op("finding", id, undefined, del.version, t(0), "delete")])).json().results[0];
    expect(del2.status).toBe("applied");
  });

  it("rejects ops on another tenant's records and on unassigned assessments as forbidden", async () => {
    const id = randomUUID();
    const areaId = randomUUID();
    const res = (await push([op("finding", id, finding(id, {}, blueFx.assessmentId), null), op("area", areaId, { id: areaId, siteId: blueFx.siteId, name: "x" }, null)])).json().results;
    expect(res.map((r: { status: string; error: { code: string } }) => [r.status, r.error.code])).toEqual([["rejected", "forbidden"], ["rejected", "forbidden"]]);
    const blueFindings = (await app.inject({ url: `/assessments/${blueFx.assessmentId}/findings`, headers: auth(blue) })).json();
    expect(blueFindings).toEqual([]);
    const id2 = randomUUID();
    const r2 = (await push([op("finding", id2, finding(id2), null)], other)).json().results[0];
    expect(r2).toMatchObject({ status: "rejected", error: { code: "forbidden" } });
    const log = (await app.inject({ url: "/audit?limit=50", headers: auth(owner) })).json();
    expect(log.some((r: { action: string; entityId: string }) => r.action === "access.denied" && r.entityId === id2)).toBe(true);
  });

  it("a record id taken in another tenant cannot be overwritten", async () => {
    const id = randomUUID();
    await app.inject({ method: "PUT", url: `/assessments/${blueFx.assessmentId}/findings/${id}`, headers: auth(blue), payload: finding(id, {}, blueFx.assessmentId) });
    const r = (await push([op("finding", id, finding(id, { title: "Hijack" }), null)])).json().results[0];
    expect(r).toMatchObject({ status: "rejected", error: { code: "id_conflict" } });
    const b = (await app.inject({ url: `/assessments/${blueFx.assessmentId}/findings`, headers: auth(blue) })).json();
    expect(b[0].title).toBe("Gate left open");
  });

  it("viewers cannot push", async () => {
    const v = (await login(app, "viewer@acme.test")).token;
    expect((await push([op("finding", randomUUID(), {}, null)], v)).statusCode).toBe(403);
  });
});

describe("pull", () => {
  it("pages by cursor in change order and returns tombstones", async () => {
    const all = (await pull()).json();
    expect(all.hasMore).toBe(false);
    expect(all.changes.length).toBeGreaterThan(3);
    // Paging with limit 2 returns the same set of records.
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const page = (await pull(cursor, 2)).json();
      page.changes.forEach((c: { id: string }) => seen.add(c.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(new Set(all.changes.map((c: { id: string }) => c.id)));

    // A new change and a delete after the cursor.
    const id = randomUUID();
    await push([op("finding", id, finding(id), null)]);
    const area = (await app.inject({ method: "POST", url: `/sites/${fx.siteId}/areas`, headers: auth(assessor), payload: { name: "Dock" } })).json();
    const after = (await pull(cursor)).json();
    expect(after.changes.map((c: { entity: string; id: string }) => `${c.entity}:${c.id}`)).toEqual([`finding:${id}`, `area:${area.id}`]);
    expect(after.changes[0]).toMatchObject({ deleted: false, version: 1, data: { id, title: "Gate left open" } });

    await push([op("finding", id, undefined, 1, t(0), "delete")]);
    const tomb = (await pull(after.cursor)).json();
    expect(tomb.changes).toEqual([{ entity: "finding", id, version: 2, deleted: true, data: null }]);
    expect((await pull(tomb.cursor)).json()).toMatchObject({ changes: [], hasMore: false, cursor: tomb.cursor });
  });

  it("only returns the requested tenant's changes and rejects bad cursors", async () => {
    expect((await app.inject({ url: `/sync/pull?assessmentId=${blueFx.assessmentId}`, headers: auth(assessor) })).statusCode).toBe(404);
    expect((await pull("bm9wZQ")).json().error.code).toBe("invalid_cursor");
  });
});
