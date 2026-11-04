import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useOnline } from "../offline/useOnline";
import { Banner, Button, Logo } from "./ui";

const NAV = [
  { to: "/", label: "Assessments", end: true },
  { to: "/clients", label: "Clients", end: false },
  { to: "/library", label: "Library", end: false },
];

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="px-4 pt-3">
      <Banner tone="warn" title="You are offline" live>
        Saved library data still works. New records need a connection in this release.
      </Banner>
    </div>
  );
}

export function AppShell() {
  const { session, signOut } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-24 text-lg text-ink sm:pb-0">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-3">
        Skip to content
      </a>
      <header className="border-b-2 border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Logo size={36} />
            <div className="min-w-0">
              <p className="font-bold leading-tight">Sentinel Assess</p>
              {session && <p className="truncate text-base text-muted">{session.tenant.name}</p>}
            </div>
          </div>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-line bg-surface sm:static sm:border-t-0">
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
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
