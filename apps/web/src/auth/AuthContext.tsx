import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LoginRequest, SessionInfo } from "@sentinel/shared";
import { createApiClient, type ApiClient } from "../api/client";
import { clearClientData } from "../offline/db";
import { loadProfile, saveProfile } from "./profile";
import { hasPin, shouldLockAfterBackground } from "./pin";
import { hasRole } from "@sentinel/shared";

type Status = "loading" | "signed_out" | "signed_in";

interface AuthValue {
  api: ApiClient;
  status: Status;
  session: SessionInfo | null;
  /**
   * True when the session comes from the cached profile because the server could not be reached
   * at start. The user can read and write cached field work; nothing syncs until a token is issued.
   */
  offlineSession: boolean;
  signIn: (req: LoginRequest) => Promise<void>;
  /** Set a password from a setup link (POST /auth/setup), then continue signed in. */
  completeSetup: (token: string, password: string) => Promise<void>;
  /** Signs out and wipes local data; `notice` is shown on the sign-in screen. */
  signOut: (notice?: string) => Promise<void>;
  /** The local PIN screen covers the app (offline start or after 5 minutes in the background). */
  locked: boolean;
  unlock: () => void;
  /** Message for the sign-in screen (PIN wipe, offline access without a PIN). */
  notice: string | null;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [offlineSession, setOfflineSession] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const api = useMemo(
    () =>
      client ??
      createApiClient({
        onSession: (s) => {
          setSession(s);
          setStatus(s ? "signed_in" : "signed_out");
          if (s) {
            setOfflineSession(false);
            saveProfile(s).catch(() => undefined);
          }
        },
      }),
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.restoreDetailed();
      if (cancelled) return;
      if (r.kind === "ok") {
        setSession(r.session);
        setStatus("signed_in");
        saveProfile(r.session).catch(() => undefined);
        return;
      }
      if (r.kind === "offline") {
        const profile = await loadProfile().catch(() => null);
        if (cancelled) return;
        if (profile) {
          // R2-5: cached work opens offline only behind the local PIN.
          if (await hasPin().catch(() => false)) {
            if (cancelled) return;
            setSession(profile);
            setOfflineSession(true);
            setLocked(true);
            setStatus("signed_in");
            return;
          }
          if (cancelled) return;
          setNotice("You are offline. Work saved on this device opens offline only after you set a PIN; sign in when you are back online.");
        }
      }
      setSession(null);
      setStatus("signed_out");
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Lock again after 5 minutes in the background when a PIN is set.
  useEffect(() => {
    if (status !== "signed_in") return;
    let hiddenAt: number | null = null;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (shouldLockAfterBackground(hiddenAt, Date.now())) {
        void hasPin().then((p) => p && setLocked(true), () => undefined);
      }
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [status]);

  const value = useMemo<AuthValue>(() => {
    async function adopt(getSession: () => Promise<SessionInfo>) {
      const previous = await loadProfile({ ignoreAge: true }).catch(() => null);
      const s = await getSession();
      // Field data on this device belongs to the previous user and workspace; never show it to someone else.
      if (previous && (previous.user.id !== s.user.id || previous.tenant.id !== s.tenant.id)) {
        await clearClientData().catch(() => undefined);
      }
      await saveProfile(s).catch(() => undefined);
      setSession(s);
      setOfflineSession(false);
      setLocked(false);
      setNotice(null);
      setStatus("signed_in");
    }
    return {
      api,
      status,
      session,
      offlineSession,
      locked,
      notice,
      unlock: () => setLocked(false),
      async signIn(req) {
        await adopt(() => api.login(req));
      },
      async completeSetup(token, password) {
        await adopt(() => api.completeSetup({ token, password }));
      },
      async signOut(message) {
        await api.logout();
        // Drafts, queued changes, cached field records, photos, and the cached profile (QA R-11).
        await clearClientData().catch(() => undefined);
        clearPinPromptSession();
        setSession(null);
        setOfflineSession(false);
        setLocked(false);
        setNotice(message ?? null);
        setStatus("signed_out");
      },
    };
  }, [api, status, session, offlineSession, locked, notice]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}

export const useApi = () => useAuth().api;

/** The user and tenant that field writes are bound to. */
export function useWriteCtx() {
  const { session } = useAuth();
  return useMemo(() => (session ? { userId: session.user.id, tenantId: session.tenant.id } : null), [session]);
}

export function useCanAdmin(): boolean {
  const { session } = useAuth();
  return session?.role === "admin" || session?.role === "owner";
}

export function useCanWrite(): boolean {
  const { session } = useAuth();
  return !!session && hasRole(session.role, "assessor");
}

export function useIsOwner(): boolean {
  return useAuth().session?.role === "owner";
}

/** Which shell a session gets: client viewers see only the client portal (D-081). */
export function shellFor(role: string | undefined | null): "portal" | "workspace" {
  return role === "client_viewer" ? "portal" : "workspace";
}

/** Same key as PinScreens; kept here to avoid an import cycle. */
function clearPinPromptSession() {
  try {
    window.sessionStorage.removeItem("sa.pinPromptDismissed");
  } catch {
    /* ignore */
  }
}
