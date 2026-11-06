import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { quoteTotals, type Quote, type ScenarioResult, type SessionInfo } from "@sentinel/shared";
import type { ApiClient } from "../api/client";
import { AuthProvider, shellFor } from "../auth/AuthContext";
import { App } from "../App";
import { PinSetupPrompt, pinPromptDismissed } from "../auth/PinScreens";
import { ScenarioCard } from "./RiskResults";
import { QuoteEditor, belowMinimum } from "./Quotes";
import { money } from "../api/phase4";
import { accessibleAlternative, brandVars, contrastRatio, parseBranding } from "../branding/theme";
import { frameworkChips } from "../field/labels";
import { trendText } from "./Portfolio";

const T = "a0000000-0000-4000-8000-000000000001";
const session = (role: SessionInfo["role"]): SessionInfo => ({ user: { id: "b0000000-0000-4000-8000-000000000001", email: "x@acme.test", name: "Pat Person" }, tenant: { id: T, slug: "acme", name: "Acme" }, role });

/** A stand-in API client: answers GETs from a route table and records writes. */
function fakeApi(role: SessionInfo["role"], routes: Record<string, unknown>, writes: { path: string; body: unknown }[] = []): ApiClient {
  const answer = async (path: string, opts: { method?: string; body?: unknown; schema?: { parse: (x: unknown) => unknown } } = {}) => {
    if (opts.method && opts.method !== "GET") {
      writes.push({ path, body: opts.body });
      const r = routes[`${opts.method} ${path}`];
      return opts.schema ? opts.schema.parse(r) : r;
    }
    if (!(path in routes)) throw new Error(`no route ${path}`);
    return opts.schema ? opts.schema.parse(routes[path]) : routes[path];
  };
  return {
    baseUrl: "http://localhost:3000",
    restoreDetailed: async () => ({ kind: "ok", session: session(role) }),
    request: (path: string, opts: Parameters<typeof answer>[1]) => answer(path, opts),
    get: (path: string, schema: { parse: (x: unknown) => unknown }) => answer(path, { schema }),
    post: (path: string, body: unknown, schema: { parse: (x: unknown) => unknown }) => answer(path, { method: "POST", body, schema }),
    logout: async () => undefined,
  } as unknown as ApiClient;
}

const scenario: ScenarioResult = {
  scenarioId: "forced-entry",
  name: "Forced entry",
  category: "physical",
  inherent: { likelihood: 4, impact: 5, score: 20, level: "very_high" },
  controlEffectiveness: { value: 0.4, coverage: 0.5, contributors: [] },
  residual: { score: 12, level: "medium" },
  confidence: "low",
  explanation: ["Inherent risk is 20 (very high).", "Lighting is weak."],
};

describe("tour fixes", () => {
  it("scenario cards start collapsed with the summary and expand on demand", async () => {
    render(
      <MemoryRouter>
        <ScenarioCard s={scenario} assessmentId={T} findingTitle={() => ""} />
      </MemoryRouter>,
    );
    const btn = screen.getByRole("button", { name: "Forced entry" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("scenario-summary")).toHaveTextContent("Very high20");
    expect(screen.getByTestId("scenario-summary")).toHaveTextContent("Medium12");
    expect(screen.getByText("Low confidence")).toBeInTheDocument();
    expect(screen.getByText("Controls are 40% effective, taking 20 down to 12.")).toBeInTheDocument();
    expect(screen.queryByTestId("explanation")).toBeNull();
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByTestId("explanation")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("PIN prompt: Not now hides it for the rest of the session", async () => {
    sessionStorage.clear();
    const api = fakeApi("assessor", {});
    const { unmount } = render(
      <AuthProvider client={api}>
        <PinSetupPrompt />
      </AuthProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Set a PIN for offline work" })).toBeNull();
    expect(pinPromptDismissed()).toBe(true);
    unmount();
    render(
      <AuthProvider client={api}>
        <PinSetupPrompt />
      </AuthProvider>,
    );
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("PIN prompt survives blocked storage", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(pinPromptDismissed()).toBe(false);
    spy.mockRestore();
  });

  it("framework chips use short names and requirement titles", () => {
    const chips = frameworkChips(
      [
        { frameworkId: "carver", shortName: "CARVER", requirementCode: "SA-CARVER-A", relationship: "informs" },
        { frameworkId: "cpted", shortName: "CPTED", requirementCode: "SA-CPTED-NS", relationship: "supports" },
      ],
      (fw, code) => (fw === "carver" && code === "SA-CARVER-A" ? "Accessibility" : undefined),
    );
    expect(chips.map((c) => c.label)).toEqual(["CARVER: Accessibility (SA-CARVER-A)", "CPTED: SA-CPTED-NS"]);
  });
});

describe("branding theme", () => {
  it("checks contrast and falls back to the default theme when unusable", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
    expect(brandVars("#0b3d91", false)).toMatchObject({ "--sa-primary": "#0b3d91", "--sa-on-primary": "#ffffff" });
    expect(brandVars("#ffd700", false)).toBeNull(); // white on gold is unreadable
    expect(brandVars("not-a-color", false)).toBeNull();
    expect(brandVars("#0b3d91", true)).toBeNull(); // too dark to read on the dark surface
    const alt = accessibleAlternative("#ffd700")!;
    expect(contrastRatio(alt, "#ffffff")!).toBeGreaterThanOrEqual(4.5);
    expect(parseBranding({ displayName: "x" })).toBeNull();
  });
});

const QID = "c1000000-0000-4000-8000-000000000001";
const line = (id: string, tier: "good" | "better" | "best" | "all", over: Partial<Quote["lines"][number]> = {}): Quote["lines"][number] => ({
  id,
  findingId: null,
  priceBookItemId: null,
  description: `Line ${id.slice(-1)}`,
  category: "hardware",
  unit: "each",
  quantity: 2,
  materialCost: 100,
  laborHours: 1,
  marginPct: 35,
  tier,
  optional: false,
  needsPricing: false,
  sortOrder: 0,
  ...over,
});
const QUOTE: Quote = {
  id: QID,
  assessmentId: T,
  number: "Q-2026-0001",
  status: "draft",
  currency: "USD",
  title: "Remediation",
  laborRate: 95,
  validUntil: "2026-12-31",
  tiers: ["good", "better"],
  notes: "",
  terms: "",
  lines: [line("d1000000-0000-4000-8000-000000000001", "all"), line("d1000000-0000-4000-8000-000000000002", "good", { marginPct: 10 }), line("d1000000-0000-4000-8000-000000000003", "better", { optional: true })],
  totals: [],
  minMarginPct: 20,
  belowMinMargin: false,
  createdAt: "2026-11-06T10:00:00Z",
  updatedAt: "2026-11-06T10:00:00Z",
  approvedBy: null,
  sentAt: null,
  respondedAt: null,
  respondedBy: null,
};

describe("quote editor", () => {
  beforeEach(() => sessionStorage.clear());

  it("live totals match quoteTotals while editing", async () => {
    const api = fakeApi("assessor", { [`/quotes/${QID}`]: QUOTE, "/price-book": [] });
    render(
      <AuthProvider client={api}>
        <MemoryRouter>
          <QuoteEditor quoteId={QID} assessmentId={T} findingTitle={() => undefined} />
        </MemoryRouter>
      </AuthProvider>,
    );
    const expected = quoteTotals(QUOTE);
    expect(await screen.findByTestId("price-good")).toHaveTextContent(money(expected[0]!.price));
    expect(screen.getByTestId("price-better")).toHaveTextContent(money(expected[1]!.price));
    expect(screen.getByTestId("margin-good")).toHaveTextContent(`${expected[0]!.marginPct}%`);
    expect(belowMinimum(expected, 20)).toEqual(expected.filter((t) => t.marginPct < 20).map((t) => t.tier));

    // Change the quantity of the all-tier line; every tier total follows quoteTotals.
    await userEvent.click(screen.getByRole("button", { name: /Line 1/ }));
    const qty = screen.getByLabelText("Quantity (each)");
    await userEvent.clear(qty);
    await userEvent.type(qty, "5");
    const edited = quoteTotals({ ...QUOTE, lines: QUOTE.lines.map((l, i) => (i === 0 ? { ...l, quantity: 5 } : l)) });
    expect(screen.getByTestId("price-good")).toHaveTextContent(money(edited[0]!.price));
    expect(screen.getByTestId("price-better")).toHaveTextContent(money(edited[1]!.price));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("is read only once submitted", async () => {
    const api = fakeApi("admin", { [`/quotes/${QID}`]: { ...QUOTE, status: "approved" }, "/price-book": [] });
    render(
      <AuthProvider client={api}>
        <MemoryRouter>
          <QuoteEditor quoteId={QID} assessmentId={T} findingTitle={() => undefined} />
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(await screen.findByText(/This quote is locked because it has been submitted/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send to client" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
  });
});

describe("role-based shell", () => {
  it("selects the portal only for client viewers", () => {
    expect(shellFor("client_viewer")).toBe("portal");
    for (const r of ["owner", "admin", "assessor", "viewer"]) expect(shellFor(r)).toBe("workspace");
  });

  it("a client viewer gets the portal shell, with no sync bar or PIN prompt", async () => {
    const api = fakeApi("client_viewer", { "/portal/assessments": [], "/branding": { displayName: "Bluefield Security", primaryColor: "#14532d", accentColor: "#b45309", reportFooter: "", contactEmail: null, contactPhone: null, website: null, showPoweredBy: true, plan: "standard", logoUrl: null } });
    render(<App router="memory" client={api} />);
    expect(await screen.findByText(/No completed assessments yet/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("brand-name")).toHaveTextContent("Bluefield Security"));
    expect(document.querySelector('[data-shell="portal"]')).not.toBeNull();
    expect(screen.queryByTestId("sync-status")).toBeNull();
    expect(screen.queryByRole("region", { name: "Set a PIN for offline work" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });
});

describe("portfolio", () => {
  it("prints the trend in words", () => {
    expect(
      trendText([
        { assessmentId: T, completedAt: "2026-03-01T00:00:00Z", level: "high", residual: 16, inherent: 20 },
        { assessmentId: T, completedAt: "2026-11-01T00:00:00Z", level: "medium", residual: 9, inherent: 20 },
      ]),
    ).toMatch(/^Residual 16 High \(.+\), then 9 Medium \(.+\): improving\.$/);
  });
});

describe("setup link", () => {
  it("reads the token from the fragment first", async () => {
    const { setupTokenFrom } = await import("./Members");
    expect(setupTokenFrom("#token=abc", "")).toBe("abc");
    expect(setupTokenFrom("", "?token=q")).toBe("q");
    expect(setupTokenFrom("", "")).toBe("");
  });
});
