import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ApiError, NetworkError, type ApiClient } from "../api/client";
import { resetDbForTests } from "../offline/db";
import { flushRiskDraft, loadRiskDraft, saveRiskDraft } from "../risk/inputsStore";
import { LOCKED_MESSAGE, refusalMessage } from "./Lock";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  await resetDbForTests();
});

const fakeApi = (impl: () => Promise<unknown>) => ({ request: impl }) as unknown as ApiClient;
const inputs = [{ scenarioId: "forced-entry", likelihood: 3, impact: 4, excluded: false }];

describe("assessment lock", () => {
  it("explains assessment_locked refusals in plain language", () => {
    expect(refusalMessage("assessment_locked", "409")).toBe(LOCKED_MESSAGE);
    expect(refusalMessage("forbidden")).toMatch(/not assigned/);
    expect(refusalMessage("other", "Server text")).toBe("Server text");
  });

  it("risk inputs refused because the assessment is locked keep the local copy and the reason", async () => {
    await saveRiskDraft("a1", inputs);
    const r = await flushRiskDraft(fakeApi(() => Promise.reject(new ApiError(409, "assessment_locked", "Assessment is complete"))), "a1");
    expect(r).toBe("refused");
    const d = await loadRiskDraft("a1");
    expect(d).toMatchObject({ dirty: true, inputs, error: { code: "assessment_locked" } });
  });

  it("risk inputs stay queued offline and are marked sent once the server accepts them", async () => {
    await saveRiskDraft("a1", inputs);
    expect(await flushRiskDraft(fakeApi(() => Promise.reject(new NetworkError(new TypeError("fetch")))), "a1")).toBe("offline");
    expect((await loadRiskDraft("a1"))?.dirty).toBe(true);
    let sent: unknown;
    const ok = fakeApi(async (...args: unknown[]) => {
      sent = args[1];
      return { scenarios: inputs };
    });
    expect(await flushRiskDraft(ok, "a1")).toBe("sent");
    expect(sent).toMatchObject({ method: "PUT", body: { scenarios: [{ scenarioId: "forced-entry", likelihood: 3, impact: 4 }] } });
    expect((await loadRiskDraft("a1"))?.dirty).toBe(false);
    expect(await flushRiskDraft(ok, "a1")).toBe("nothing");
  });
});
