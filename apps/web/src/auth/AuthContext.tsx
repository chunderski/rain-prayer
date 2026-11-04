import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LoginRequest, SessionInfo } from "@sentinel/shared";
import { createApiClient, type ApiClient } from "../api/client";
import { clearDrafts } from "../offline/db";

type Status = "loading" | "signed_out" | "signed_in";

interface AuthValue {
  api: ApiClient;
  status: Status;
  session: SessionInfo | null;
  signIn: (req: LoginRequest) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  const api = useMemo(
    () =>
      client ??
      createApiClient({
        onSession: (s) => {
          setSession(s);
          setStatus(s ? "signed_in" : "signed_out");
        },
      }),
    [client],
  );

  useEffect(() => {
    let cancelled = false;
    api.restore().then((s) => {
      if (cancelled) return;
      setSession(s);
      setStatus(s ? "signed_in" : "signed_out");
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const value = useMemo<AuthValue>(
    () => ({
      api,
      status,
      session,
      async signIn(req) {
        const s = await api.login(req);
        setSession(s);
        setStatus("signed_in");
      },
      async signOut() {
        await api.logout();
        await clearDrafts().catch(() => undefined);
        setSession(null);
        setStatus("signed_out");
      },
    }),
    [api, status, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}

export const useApi = () => useAuth().api;
