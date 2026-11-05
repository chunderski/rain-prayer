import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LoginRequest, SessionInfo } from "@sentinel/shared";
import { createApiClient, type ApiClient } from "../api/client";
import { clearClientData } from "../offline/db";
import { loadProfile, saveProfile } from "./profile";

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
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [offlineSession, setOfflineSession] = useState(false);

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
          setSession(profile);
          setOfflineSession(true);
          setStatus("signed_in");
          return;
        }
      }
      setSession(null);
      setStatus("signed_out");
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const value = useMemo<AuthValue>(
    () => ({
      api,
      status,
      session,
      offlineSession,
      async signIn(req) {
        const previous = await loadProfile({ ignoreAge: true }).catch(() => null);
        const s = await api.login(req);
        // Field data on this device belongs to the previous user and workspace; never show it to someone else.
        if (previous && (previous.user.id !== s.user.id || previous.tenant.id !== s.tenant.id)) {
          await clearClientData().catch(() => undefined);
        }
        await saveProfile(s).catch(() => undefined);
        setSession(s);
        setOfflineSession(false);
        setStatus("signed_in");
      },
      async signOut() {
        await api.logout();
        // Drafts, queued changes, cached field records, photos, and the cached profile (QA R-11).
        await clearClientData().catch(() => undefined);
        setSession(null);
        setOfflineSession(false);
        setStatus("signed_out");
      },
    }),
    [api, status, session, offlineSession],
  );

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
  return !!session && session.role !== "viewer";
}
