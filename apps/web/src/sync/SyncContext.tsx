/**
 * Wires the sync engine into the app: one engine per signed-in session, run on app start, on
 * `online`, when the page becomes visible, every 30 s while visible and online, after local
 * writes (debounced), and when the service worker relays a Background Sync event. Background
 * Sync only wakes an open page (the access token lives in page memory, never in the worker), so
 * the timer and the online event are the fallback everywhere.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { onFieldWrite } from "../field/repo";
import { createApiTransport } from "./transport";
import { SyncEngine, type SyncStatus } from "./engine";
import { flushAllRiskDrafts } from "../risk/inputsStore";

export const SYNC_TAG = "sentinel-sync";
export const SYNC_INTERVAL_MS = 30_000;

interface SyncValue {
  engine: SyncEngine | null;
  status: SyncStatus;
  syncNow: () => void;
}

const EMPTY: SyncStatus = { state: "idle", pending: 0, conflicts: 0, rejected: 0, lastSyncedAt: null, nextRetryAt: null, lastError: null };
const SyncContext = createContext<SyncValue>({ engine: null, status: EMPTY, syncNow: () => undefined });

/** Ask the browser to wake us when connectivity returns, where Background Sync exists. */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    if (!("serviceWorker" in navigator)) return false;
    const reg = (await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 1000))])) as
      | (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })
      | null;
    if (!reg?.sync) return false;
    await reg.sync.register(SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

export function SyncProvider({ children, intervalMs = SYNC_INTERVAL_MS }: { children: ReactNode; intervalMs?: number }) {
  const { api, session, status: authStatus } = useAuth();
  const [status, setStatus] = useState<SyncStatus>(EMPTY);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const engine = useMemo(() => {
    if (authStatus !== "signed_in") return null;
    return new SyncEngine({
      transport: createApiTransport(api),
      getContext: () => (sessionRef.current ? { userId: sessionRef.current.user.id, tenantId: sessionRef.current.tenant.id } : null),
    });
  }, [api, authStatus]);

  useEffect(() => {
    if (!engine) {
      setStatus(EMPTY);
      return;
    }
    engine.start();
    const unsub = engine.subscribe(setStatus);
    const run = () => {
      void engine.syncNow();
      // Risk inputs are REST writes saved locally first (src/risk/inputsStore.ts).
      if (navigator.onLine && api.hasToken()) void flushAllRiskDrafts(api).catch(() => undefined);
    };
    void engine.refreshCounts();
    run(); // app start

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unsubWrite = onFieldWrite(() => {
      void engine.refreshCounts();
      if (!navigator.onLine) {
        void registerBackgroundSync();
        return;
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 800);
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === SYNC_TAG) run();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) run();
    }, intervalMs);
    window.addEventListener("online", run);
    window.addEventListener("offline", run);
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener?.("message", onMessage);
    return () => {
      unsub();
      unsubWrite();
      if (debounce) clearTimeout(debounce);
      clearInterval(timer);
      window.removeEventListener("online", run);
      window.removeEventListener("offline", run);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener?.("message", onMessage);
      engine.stop();
    };
  }, [engine, intervalMs, api]);

  // A session restored after an offline start: sync as soon as the token exists.
  useEffect(() => {
    if (engine && session) void engine.syncNow();
  }, [engine, session]);

  const value = useMemo<SyncValue>(() => ({ engine, status, syncNow: () => void engine?.syncNow() }), [engine, status]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export const useSync = () => useContext(SyncContext);

export type SyncSummary = { tone: "ok" | "warn" | "error" | "info"; text: string };

/** Plain-language status line shown in the header. */
export function summarize(s: SyncStatus, online: boolean): SyncSummary {
  if (s.conflicts > 0) return { tone: "error", text: `Conflict: review (${s.conflicts})` };
  if (s.rejected > 0) return { tone: "error", text: `${s.rejected} ${s.rejected === 1 ? "change was" : "changes were"} not accepted: review` };
  if (s.pending > 0) {
    const n = `${s.pending} ${s.pending === 1 ? "change" : "changes"}`;
    if (!online || s.state === "offline") return { tone: "warn", text: `${n} waiting for signal` };
    if (s.state === "waiting_auth") return { tone: "warn", text: `${n} waiting: sign in again to send` };
    if (s.state === "syncing") return { tone: "info", text: `Sending ${n}` };
    return { tone: "warn", text: `${n} waiting to send` };
  }
  if (s.state === "syncing") return { tone: "info", text: "Checking for changes" };
  return { tone: "ok", text: "All changes saved to server" };
}
