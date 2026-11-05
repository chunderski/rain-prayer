import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { getMeta, resetDbForTests, saveDraft, getDraft, setMeta } from "../offline/db";
import { hasPin, PIN_ITERATIONS, PIN_MAX_ATTEMPTS, setPin, shouldLockAfterBackground, validatePin, verifyPin, wrongAttempts } from "./pin";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  await resetDbForTests();
});

describe("local PIN (R2-5)", () => {
  it("accepts 4 to 8 digits only", () => {
    expect(validatePin("1234")).toBeNull();
    expect(validatePin("12345678")).toBeNull();
    for (const bad of ["123", "123456789", "12a4", "", " 1234"]) expect(validatePin(bad)).not.toBeNull();
  });

  it("stores only a salted PBKDF2-SHA256 verifier and verifies the PIN", async () => {
    await setPin("482913");
    const stored = await getMeta<Record<string, unknown>>("pin");
    expect(stored).toMatchObject({ v: 1, iterations: PIN_ITERATIONS });
    expect(PIN_ITERATIONS).toBe(310_000);
    expect(JSON.stringify(stored)).not.toContain("482913");
    expect(atob(stored!.salt as string)).toHaveLength(16);
    expect(atob(stored!.hash as string)).toHaveLength(32);
    expect(await verifyPin("482913")).toEqual({ kind: "ok" });
    expect(await wrongAttempts()).toBe(0);
  });

  it("uses a fresh random salt each time", async () => {
    await setPin("1111");
    const a = await getMeta<{ salt: string; hash: string }>("pin");
    await setPin("1111");
    const b = await getMeta<{ salt: string; hash: string }>("pin");
    expect(a!.salt).not.toBe(b!.salt);
    expect(a!.hash).not.toBe(b!.hash);
  });

  it("counts wrong attempts and resets the count on success", async () => {
    await setPin("2468");
    expect(await verifyPin("1357")).toEqual({ kind: "wrong", remaining: 4 });
    expect(await verifyPin("0000")).toEqual({ kind: "wrong", remaining: 3 });
    expect(await wrongAttempts()).toBe(2);
    expect(await verifyPin("2468")).toEqual({ kind: "ok" });
    expect(await wrongAttempts()).toBe(0);
  });

  it("wipes local data after 5 wrong attempts, including across reloads", async () => {
    await setPin("2468");
    await setMeta("profile", { session: {}, verifiedAt: Date.now() });
    await saveDraft("risk-inputs:x", "risk_inputs", { inputs: [] });
    for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) expect((await verifyPin("9999")).kind).toBe("wrong");
    // A reload does not reset the counter: it lives in IndexedDB.
    await resetDbForTests();
    expect(await wrongAttempts()).toBe(PIN_MAX_ATTEMPTS - 1);
    expect(await verifyPin("9999")).toEqual({ kind: "wiped" });
    expect(await hasPin()).toBe(false);
    expect(await getMeta("profile")).toBeUndefined();
    expect(await getDraft("risk-inputs:x")).toBeUndefined();
    expect(await verifyPin("2468")).toEqual({ kind: "no_pin" });
  });

  it("locks after 5 minutes in the background, not before", () => {
    const t0 = 1_000_000;
    expect(shouldLockAfterBackground(null, t0)).toBe(false);
    expect(shouldLockAfterBackground(t0, t0 + 4 * 60_000)).toBe(false);
    expect(shouldLockAfterBackground(t0, t0 + 5 * 60_000)).toBe(true);
  });
});
