import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useOnline } from "../offline/useOnline";
import { summarize, useSync } from "../sync/SyncContext";
import { Banner, Button } from "./ui";
import { BrandMark, useBrandName } from "../branding/BrandingContext";
import { pendingLocalCount } from "../offline/db";
import { PinSetupPrompt } from "../auth/PinScreens";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/compare", label: "Compare", end: false },
  { to: "/clients", label: "Clients", end: false },
  { to: "/library", label: "Library", end: false },
];

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="px-4 pt-3">
      <Banner tone="warn" title="You are offline" live>
        Walkthrough answers, photos, and findings are saved on this device and sync when you are back online. The library works from the saved copy; creating clients and assessments needs a connection.
      </Banner>
    </div>
  );
}

/** Field review P1-4: warn before sign out deletes unsaved work on this device. */
async function confirmSignOut(signOut: () => Promise<void>) {
  const pending = await pendingLocalCount().catch(() => 0);
  if (
    pending > 0 &&
    !window.confirm(
      `You have ${pending} unsaved ${pending === 1 ? "item" : "items"} on this device. Signing out deletes them. Sign out anyway?`,
    )
  )
    return;
  await signOut();
}

const STATUS_STYLE = {
  ok: { cls: "border-ok bg-ok-soft text-ok", icon: "✓" },
  info: { cls: "border-primary bg-primary-soft text-ink", icon: "↻" },
  warn: { cls: "border-warn bg-warn-soft text-warn", icon: "!" },
  error: { cls: "border-danger bg-danger-soft text-danger", icon: "!" },
} as const;

/** Header sync status: plain-language state, link to the review screen, and a Sync now button. */
export function SyncStatusBar() {
  const { status, syncNow } = useSync();
  const online = useOnline();
  const s = summarize(status, online);
  const st = STATUS_STYLE[s.tone];
  return (
    <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 pb-2">
      <div role="status" className="flex min-w-0 flex-1">
        <Link to="/sync" data-testid="sync-status" className={"inline-flex min-h-12 flex-1 items-center gap-2 rounded-lg border-2 px-3 font-semibold no-underline " + st.cls}>
          <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-current text-base">
            {st.icon}
          </span>
          {s.text}
        </Link>
      </div>
      <Button variant="secondary" disabled={!online || status.state === "syncing"} onClick={syncNow}>
        Sync now
      </Button>
    </div>
  );
}

/** Full-screen field flows hide the bottom nav so their own action bar owns the thumb zone (UX P2-3). */
const FOCUS_ROUTES = [/\/walkthrough\/[^/]+$/, /\/photos\/[^/]+\/tag$/, /\/findings\/(new|[^/]+)$/, /^\/assessments\/new$/];

export function AppShell() {
  const { session, signOut, offlineSession } = useAuth();
  const { pathname } = useLocation();
  const focus = FOCUS_ROUTES.some((r) => r.test(pathname));
  const brandName = useBrandName();
  return (
    <div className={"flex min-h-dvh flex-col bg-bg text-lg text-ink sm:pb-0 " + (focus ? "pb-4" : "pb-24")}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-3">
        Skip to content
      </a>
      <header className="border-b-2 border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <BrandMark size={36} />
            <div className="min-w-0">
              <p className="font-bold leading-tight" data-testid="brand-name">{brandName}</p>
              {session && <p className="truncate text-base text-muted">{session.tenant.name}</p>}
            </div>
          </div>
          <Button variant="secondary" onClick={() => void confirmSignOut(signOut)}>
            Sign out
          </Button>
        </div>
        <SyncStatusBar />
        <nav aria-label="Main" className={(focus ? "hidden sm:block " : "") + "fixed inset-x-0 bottom-0 z-40 border-t-2 border-line bg-surface sm:static sm:border-t-0"}>
          <ul className="mx-auto flex max-w-5xl">
            {NAV.map((n) => (
              <li key={n.to} className="flex-1 sm:flex-none">
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    "flex min-h-14 items-center justify-center border-t-4 px-4 font-semibold sm:border-t-0 sm:border-b-4 " +
                    (isActive ? "border-primary text-ink underline underline-offset-4" : "border-transparent text-muted")
                  }
                >
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <OfflineBanner />
      <PinSetupPrompt />
      {offlineSession && (
        <div className="px-4 pt-3">
          <Banner tone="info" title={`Working offline as ${session?.user.name ?? "you"}`}>
            Your work is saved on this device. It is sent once you are back online and your sign in is confirmed.
          </Banner>
        </div>
      )}
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
