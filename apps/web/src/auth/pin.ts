/**
 * Local PIN for offline access (QA R2-5, CW approved; amends D-039).
 *
 * Only a PBKDF2-SHA256 verifier is stored (WebCrypto, 310000 iterations, 16 byte random salt),
 * never the PIN. The wrong-attempt counter is written before each check, so closing the tab during
 * a check still counts it. Five wrong attempts wipe all client data on the device.
 */
import { clearClientData, deleteMeta, getMeta, setMeta } from "../offline/db";

export const PIN_ITERATIONS = 310_000;
export const PIN_MAX_ATTEMPTS = 5;
/** Lock again after this long in the background. */
export const PIN_BACKGROUND_LOCK_MS = 5 * 60 * 1000;
export const PIN_PATTERN = /^\d{4,8}$/;

const PIN_KEY = "pin";
const ATTEMPTS_KEY = "pinAttempts";

interface StoredPin {
  v: 1;
  salt: string;
  hash: string;
  iterations: number;
  createdAt: string;
}

export type VerifyResult = { kind: "ok" } | { kind: "wrong"; remaining: number } | { kind: "wiped" } | { kind: "no_pin" };

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function validatePin(pin: string): string | null {
  return PIN_PATTERN.test(pin) ? null : "Use 4 to 8 digits.";
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function setPin(pin: string): Promise<void> {
  const err = validatePin(pin);
  if (err) throw new Error(err);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, PIN_ITERATIONS);
  await setMeta(PIN_KEY, { v: 1, salt: b64(salt), hash: b64(hash), iterations: PIN_ITERATIONS, createdAt: new Date().toISOString() } satisfies StoredPin);
  await setMeta(ATTEMPTS_KEY, 0);
}

export async function hasPin(): Promise<boolean> {
  return !!(await getMeta<StoredPin>(PIN_KEY));
}

export async function wrongAttempts(): Promise<number> {
  return (await getMeta<number>(ATTEMPTS_KEY)) ?? 0;
}

export async function clearPin(): Promise<void> {
  await deleteMeta(PIN_KEY);
  await deleteMeta(ATTEMPTS_KEY);
}

export async function verifyPin(pin: string): Promise<VerifyResult> {
  const stored = await getMeta<StoredPin>(PIN_KEY);
  if (!stored) return { kind: "no_pin" };
  const attempts = (await wrongAttempts()) + 1;
  await setMeta(ATTEMPTS_KEY, attempts); // counted before checking
  const ok = PIN_PATTERN.test(pin) && equal(await derive(pin, unb64(stored.salt), stored.iterations), unb64(stored.hash));
  if (ok) {
    await setMeta(ATTEMPTS_KEY, 0);
    return { kind: "ok" };
  }
  if (attempts >= PIN_MAX_ATTEMPTS) {
    await wipeDevice();
    return { kind: "wiped" };
  }
  return { kind: "wrong", remaining: PIN_MAX_ATTEMPTS - attempts };
}

/** Deletes every store holding client data, including the profile, PIN, and attempt counter. */
export async function wipeDevice(): Promise<void> {
  await clearClientData();
}

/** True when the app was hidden long enough to require the PIN again. */
export function shouldLockAfterBackground(hiddenAt: number | null, now: number, limit = PIN_BACKGROUND_LOCK_MS): boolean {
  return hiddenAt !== null && now - hiddenAt >= limit;
}
