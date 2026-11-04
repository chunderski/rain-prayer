import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createApiClient } from "./client";
import { fetchControls, fetchFrameworks } from "./library";
import { resetDbForTests } from "../offline/db";
import { CONTROLS_BY_FRAMEWORK, FRAMEWORKS } from "../test/fixtures";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  await resetDbForTests();
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("library offline cache", () => {
  it("serves cached frameworks and filtered controls when the network is down", async () => {
    let online = true;
    const all = Object.values(CONTROLS_BY_FRAMEWORK).flat().filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!online) throw new TypeError("Failed to fetch");
      const u = new URL(String(input));
      if (u.pathname === "/frameworks") return ok(FRAMEWORKS);
      if (u.pathname === "/controls") return ok(all);
      throw new Error(String(input));
    });
    const api = createApiClient({ baseUrl: "http://api.test", fetch });
    expect((await fetchFrameworks(api)).fromCache).toBe(false);
    await fetchControls(api);
    await new Promise((r) => setTimeout(r, 10)); // cache writes are fire and forget

    online = false;
    const fw = await fetchFrameworks(api);
    expect(fw.fromCache).toBe(true);
    expect(fw.data).toHaveLength(5);
    const pqc = await fetchControls(api, { framework: "pqc-readiness" });
    expect(pqc.fromCache).toBe(true);
    expect(pqc.data.map((c) => c.id).sort()).toEqual(["SC-CRY-001", "SC-CRY-002"]);
  });
});
