/**
 * Workspace branding for the whole app: loads GET /branding once signed in, exposes it to the
 * header, portal, and settings, and sets the primary color CSS variables on a wrapper element
 * (works in the page and inside the web component's shadow root). Unusable colors keep the default.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { BrandingResponse } from "@sentinel/shared";
import { useAuth } from "../auth/AuthContext";
import { fetchBranding } from "../api/phase4";
import { brandVars, parseBranding, safeLogoUrl } from "./theme";
import { Logo } from "../components/ui";

interface BrandingValue {
  branding: BrandingResponse | null;
  /** Replace after a save so the app updates without a reload. */
  setBranding: (b: BrandingResponse | null) => void;
  reload: () => void;
}

const Ctx = createContext<BrandingValue>({ branding: null, setBranding: () => undefined, reload: () => undefined });

const DARK = "(prefers-color-scheme: dark)";
function subscribeDark(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(DARK);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}
const isDark = () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(DARK).matches);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { api, status, session, locked } = useAuth();
  const [branding, setBrandingState] = useState<BrandingResponse | null>(null);
  const [tick, setTick] = useState(0);
  const dark = useSyncExternalStore(subscribeDark, isDark, () => false);
  const tenantId = session?.tenant.id;

  useEffect(() => {
    if (status !== "signed_in" || locked || !tenantId) {
      setBrandingState(null);
      return;
    }
    let live = true;
    fetchBranding(api).then(
      (r) => live && setBrandingState(parseBranding(r.data)),
      () => live && setBrandingState(null),
    );
    return () => {
      live = false;
    };
  }, [api, status, locked, tenantId, tick]);

  const setBranding = useCallback((b: BrandingResponse | null) => setBrandingState(b ? parseBranding(b) : null), []);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(() => ({ branding, setBranding, reload }), [branding, setBranding, reload]);
  const vars = branding ? brandVars(branding.primaryColor, dark) : null;
  return (
    <Ctx.Provider value={value}>
      <div className="contents" style={(vars ?? undefined) as CSSProperties | undefined} data-brand={vars ? "custom" : "default"}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export const useBranding = () => useContext(Ctx);

/** Header mark: the workspace logo when one loads, otherwise the Sentinel shield. */
export function BrandMark({ size = 36 }: { size?: number }) {
  const { branding } = useBranding();
  const { api } = useAuth();
  const [failed, setFailed] = useState<string | null>(null);
  const url = safeLogoUrl(branding?.logoUrl, api.baseUrl);
  if (!url || failed === url) return <Logo size={size} />;
  return <img src={url} alt="" width={size} height={size} className="shrink-0 rounded-lg bg-white object-contain" style={{ width: size, height: size }} onError={() => setFailed(url)} data-testid="brand-logo" />;
}

export function useBrandName(fallback = "Sentinel Assess") {
  return useBranding().branding?.displayName || fallback;
}
