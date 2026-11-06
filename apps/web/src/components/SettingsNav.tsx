import { NavLink } from "react-router-dom";

const ITEMS = [
  { to: "/settings/branding", label: "Branding" },
  { to: "/settings/members", label: "Members" },
  { to: "/settings/price-book", label: "Price book" },
  { to: "/settings/integrations", label: "Integrations" },
];

/** Settings sections (admins). Wraps on phones; every link is a 48px target. */
export function SettingsNav() {
  return (
    <nav aria-label="Settings" className="mb-4">
      <ul className="flex flex-wrap gap-2">
        {ITEMS.map((i) => (
          <li key={i.to}>
            <NavLink
              to={i.to}
              className={({ isActive }) =>
                "inline-flex min-h-12 items-center rounded-lg border-2 px-4 font-semibold no-underline " + (isActive ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink")
              }
            >
              {i.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
