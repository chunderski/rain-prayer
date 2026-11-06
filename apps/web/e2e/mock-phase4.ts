/**
 * Phase 4 additions to the mocked API (docs/api-phase4.md), enforcing the same rules as the real
 * API: role minimums (client_viewer below viewer), owner-only approve, admin-only send, draft-only
 * edits (409 quote_locked), status transitions, needs-pricing blocks submit (422), the minimum
 * margin sends a quote to pending_approval, client scoping in the portal, contrast and plan checks
 * on branding, the last active owner rule, single-use setup tokens, and unique SKUs. Totals are
 * computed with quoteTotals from @sentinel/shared, exactly like the API.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Route } from "@playwright/test";
import { quoteTotals, QuoteInput, type Quote, type QuoteLine, type Tier } from "@sentinel/shared";
import { API, type MockState, type MockUser } from "./mock-api";
import { ASSESSMENT_ID, SEEDED_ASSESSMENT } from "./mock-field";
import { FINDING_ID } from "./mock-phase3";
import { contrastRatio } from "../src/branding/theme";

export const NORTHWIND = "c0000000-0000-4000-8000-000000000001";
export const OTHER_CLIENT = "c0000000-0000-4000-8000-000000000009";
const ACME = { id: "a0000000-0000-4000-8000-000000000001", slug: "acme-integrators", name: "Acme Integrators" };

export const USERS: Record<"owner" | "admin" | "estimator" | "carmen" | "viewer", MockUser> = {
  owner: { id: "b0000000-0000-4000-8000-0000000000a1", email: "owner@acme.test", name: "Olivia Owner", role: "owner", status: "active" },
  admin: { id: "b0000000-0000-4000-8000-000000000001", email: "assessor@acme.test", name: "Alex Assessor", role: "admin", status: "active" },
  estimator: { id: "b0000000-0000-4000-8000-0000000000a2", email: "est@acme.test", name: "Erin Estimator", role: "assessor", status: "active" },
  carmen: { id: "b0000000-0000-4000-8000-0000000000a3", email: "carmen@northwind.test", name: "Carmen Diaz", role: "client_viewer", clientId: NORTHWIND, status: "active" },
  viewer: { id: "b0000000-0000-4000-8000-0000000000a4", email: "viewer@acme.test", name: "Vic Viewer", role: "viewer", status: "active" },
};

const RANK: Record<string, number> = { client_viewer: 0, viewer: 1, assessor: 2, admin: 3, owner: 4 };

export const FINDINGS = [
  { id: FINDING_ID, title: "Fence gap at the loading dock", severity: "high", controlIds: ["SC-PER-001"], description: "A 2 m gap in the chain-link fence behind the dock.", recommendation: "Repair the fence fabric." },
  { id: "f1000000-0000-4000-8000-000000000002", title: "Dock entrance light out", severity: "high", controlIds: ["SC-LGT-001"], description: "The wall pack above the dock door is dark.", recommendation: "Replace the fixture." },
  { id: "f1000000-0000-4000-8000-000000000003", title: "Shrubs block the entrance view", severity: "low", controlIds: ["SC-ENV-001"], description: "Overgrown shrubs hide the side entrance.", recommendation: "Trim to below 1 m." },
];

type Item = { id: string; sku: string; name: string; description: string; category: string; unit: string; materialCost: number; laborHours: number; defaultMarginPct: number; controlIds: string[]; assetTypes: string[]; tier: string; active: boolean; fromTemplate?: boolean };
const item = (n: number, sku: string, name: string, over: Partial<Item>): Item => ({
  id: `90000000-0000-4000-8000-00000000000${n}`,
  sku,
  name,
  description: "",
  category: "hardware",
  unit: "each",
  materialCost: 100,
  laborHours: 1,
  defaultMarginPct: 35,
  controlIds: [],
  assetTypes: [],
  tier: "any",
  active: true,
  ...over,
});

const TEMPLATE = [
  item(5, "TPL-SIGN", "Perimeter warning sign", { controlIds: ["SC-PER-001"], materialCost: 40, laborHours: 0.5, fromTemplate: true }),
  item(3, "TPL-LED-WP", "Exterior LED wall pack, installed", { controlIds: ["SC-LGT-001"], materialCost: 300, laborHours: 1, fromTemplate: true }),
];

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

export interface Phase4Options {
  plan?: "standard" | "partner";
  /** Assessment status, owned by the Phase 3 mock. */
  assessmentStatus: () => string;
  /** Risk result for the portal, from the Phase 3 mock. */
  risk: () => unknown;
}

export function createPhase4Mock(opts: Phase4Options) {
  let api: MockState | null = null;
  const state = {
    plan: opts.plan ?? "standard",
    branding: { displayName: "Acme Integrators", primaryColor: "#0b3d91", accentColor: "#b45309", reportFooter: "", contactEmail: null as string | null, contactPhone: null as string | null, website: null as string | null, showPoweredBy: true },
    logo: null as Buffer | null,
    logoVersion: 0,
    members: Object.values(USERS).map((u) => ({ ...u })),
    tokens: new Map<string, string>(), // token -> userId
    passwords: new Map<string, string>(),
    priceBook: [
      item(1, "FEN-REPAIR", "Chain-link fabric repair", { controlIds: ["SC-PER-001"], tier: "good", unit: "lot", materialCost: 1200, laborHours: 4 }),
      item(2, "FEN-REPLACE", "Fence section replacement, anti-climb mesh", { controlIds: ["SC-PER-001"], tier: "best", unit: "lot", materialCost: 4800, laborHours: 16 }),
      { ...TEMPLATE[1]! },
      item(4, "FEN-OLD", "Discontinued fence kit", { controlIds: ["SC-PER-001"], tier: "better", active: false }),
    ] as Item[],
    quotes: new Map<string, Quote>(),
    counter: 0,
    actions: [] as { quoteId: string; body: Record<string, unknown>; by: string }[],
    puts: [] as QuoteInput[],
  };

  const user = () => api!.user;
  const rank = () => RANK[user().role] ?? -1;
  const clientOf = () => state.members.find((m) => m.id === user().id)?.clientId ?? null;

  const withTotals = (q: Quote, minMargin = 20): Quote => {
    const totals = quoteTotals(q);
    return { ...q, totals, minMarginPct: minMargin, belowMinMargin: totals.some((t) => t.marginPct < minMargin), updatedAt: new Date().toISOString() };
  };
  const member = (m: (typeof state.members)[number]) => ({ userId: m.id, email: m.email, name: m.name, role: m.role, clientId: m.clientId ?? null, clientName: m.clientId === NORTHWIND ? "Northwind Logistics" : null, status: m.status ?? "active" });
  const brandingResponse = () => ({ ...state.branding, plan: state.plan, logoUrl: state.logo ? `${API}/files/branding/logo.png?v=${state.logoVersion}` : null });

  function newQuote(lines: QuoteLine[], over: Partial<Quote> = {}): Quote {
    state.counter++;
    const now = new Date().toISOString();
    const q = withTotals({
      id: randomUUID(),
      assessmentId: ASSESSMENT_ID,
      number: `Q-2026-${String(state.counter).padStart(4, "0")}`,
      status: "draft",
      currency: "USD",
      title: SEEDED_ASSESSMENT.title,
      laborRate: 95,
      validUntil: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
      tiers: ["good", "better", "best"],
      notes: "",
      terms: "Net 30.",
      lines,
      totals: [],
      minMarginPct: 20,
      belowMinMargin: false,
      createdAt: now,
      updatedAt: now,
      approvedBy: null,
      sentAt: null,
      respondedAt: null,
      respondedBy: null,
      ...over,
    });
    state.quotes.set(q.id, q);
    return q;
  }

  /** The API's suggestion rule: active items whose controls intersect the finding's; none gives a needs-pricing line. */
  function suggest(tiers: Tier[]): QuoteLine[] {
    const lines: QuoteLine[] = [];
    for (const f of FINDINGS) {
      const matches = state.priceBook.filter((i) => i.active && i.controlIds.some((c) => f.controlIds.includes(c)));
      if (!matches.length) {
        lines.push({ id: randomUUID(), findingId: f.id, priceBookItemId: null, description: f.recommendation, category: "service", unit: "lot", quantity: 1, materialCost: 0, laborHours: 0, marginPct: 35, tier: "all", optional: false, needsPricing: true, sortOrder: lines.length });
        continue;
      }
      for (const i of matches) {
        const tier = i.tier === "any" ? "all" : (i.tier as Tier);
        if (tier !== "all" && !tiers.includes(tier)) continue;
        lines.push({ id: randomUUID(), findingId: f.id, priceBookItemId: i.id, description: i.description || i.name, category: i.category as QuoteLine["category"], unit: i.unit as QuoteLine["unit"], quantity: 1, materialCost: i.materialCost, laborHours: i.laborHours, marginPct: i.defaultMarginPct, tier, optional: false, needsPricing: false, sortOrder: lines.length });
      }
    }
    return lines;
  }

  /** Seed a quote in any status (portal and expiry specs). */
  function seedQuote(status: Quote["status"], over: Partial<Quote> = {}) {
    const lines = suggest(["good", "better", "best"]).map((l) => (l.needsPricing ? { ...l, needsPricing: false, materialCost: 250 } : l));
    return newQuote(lines, { status, ...(status === "sent" ? { sentAt: new Date().toISOString() } : {}), ...over });
  }

  const visibleToClient = (q: Quote) => ["sent", "accepted", "declined", "expired"].includes(q.status);
  const portalAssessment = () => ({
    id: ASSESSMENT_ID,
    title: SEEDED_ASSESSMENT.title,
    siteName: SEEDED_ASSESSMENT.siteName,
    completedAt: "2026-11-05T10:00:00Z",
    overall: { level: "medium", residual: 12 },
    openFindings: { high: 2, low: 1 },
    quotes: [...state.quotes.values()].filter(visibleToClient).map((q) => ({ id: q.id, number: q.number, title: q.title, status: q.status })),
  });

  type Reply = (status: number, body?: unknown) => Promise<void>;
  const done = (p: Promise<void>) => p.then(() => true);

  async function handle(route: Route, req: Request, url: URL, reply: Reply, cors: Record<string, string>): Promise<boolean> {
    const p = url.pathname;
    const m = req.method();
    const err = (s: number, code: string, message: string) => done(reply(s, { error: { code, message } }));
    const html = (body: string) => done(route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" }, body }));
    const need = (min: string) => rank() >= RANK[min]!;

    if (p.startsWith("/files/branding/")) {
      if (!state.logo) return err(404, "not_found", "No logo");
      return done(route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "image/png" }, body: state.logo }));
    }
    if (!api) return false;

    // ---------- branding ----------
    if (p === "/branding" && m === "GET") return done(reply(200, brandingResponse()));
    if (p === "/branding" && m === "PUT") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      const b = req.postDataJSON() as typeof state.branding;
      if ((contrastRatio(b.primaryColor, "#ffffff") ?? 0) < 4.5) return err(422, "contrast_too_low", "White text on the primary color is under 4.5:1");
      if (!b.showPoweredBy && state.plan !== "partner") return err(403, "plan_required", "Partner plan required");
      state.branding = b;
      return done(reply(200, brandingResponse()));
    }
    if (p === "/branding/logo" && m === "PUT") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      const type = req.headers()["content-type"] ?? "";
      if (!/^image\/(png|jpeg)$/.test(type)) return err(415, "unsupported_media_type", "PNG or JPEG only");
      const bytes = req.postDataBuffer();
      if (!bytes || bytes.length > 2 * 1024 * 1024) return err(413, "too_large", "Max 2 MB");
      state.logo = PNG_1PX; // re-encoded to PNG by the real API
      state.logoVersion++;
      return done(reply(200, brandingResponse()));
    }
    if (p === "/branding/logo" && m === "DELETE") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      state.logo = null;
      return done(reply(204));
    }

    // Everything below refuses client viewers except the portal and quote responses.
    const portalRoute = p.startsWith("/portal/") || (/^\/quotes\/[^/]+\/actions$/.test(p) && m === "POST");

    // ---------- portal ----------
    if (portalRoute && p.startsWith("/portal/")) {
      const client = user().role === "client_viewer" ? clientOf() : need("viewer") ? url.searchParams.get("clientId") : null;
      if (!client) return err(403, "forbidden", "Not allowed");
      const ours = client === NORTHWIND && opts.assessmentStatus() === "complete";
      if (p === "/portal/assessments") return done(reply(200, ours ? [portalAssessment()] : []));
      const a = p.match(/^\/portal\/assessments\/([^/]+)(\/report)?$/);
      if (a) {
        if (!ours || a[1] !== ASSESSMENT_ID) return err(404, "not_found", "Not found");
        if (a[2]) return html(`<!doctype html><html><head><title>Report</title></head><body><h1>${SEEDED_ASSESSMENT.title}</h1><h2>Executive summary</h2><p>Approved summary for Northwind.</p></body></html>`);
        return done(
          reply(200, {
            assessment: portalAssessment(),
            risk: opts.risk(),
            findings: FINDINGS.map((f) => ({ id: f.id, title: f.title, severity: f.severity, description: f.description, recommendation: f.recommendation, frameworks: [{ frameworkId: "physical-general", frameworkShortName: "Physical security", requirementCode: "SA-PER-1", requirementTitle: "Perimeter barriers" }] })),
          }),
        );
      }
      const q = p.match(/^\/portal\/quotes\/([^/]+)(\/preview)?$/);
      if (q) {
        const quote = state.quotes.get(q[1]!);
        if (!quote || !visibleToClient(quote) || client !== NORTHWIND) return err(404, "not_found", "Not found");
        if (q[2]) return html(`<!doctype html><html><head><title>Proposal</title></head><body><h1>Proposal ${quote.number}</h1>${quote.totals.map((t) => `<p>${t.tier}: ${t.price.toFixed(2)}</p>`).join("")}</body></html>`);
        return done(reply(200, quote)); // the contract returns Quote; the portal UI parses prices only
      }
      return err(404, "not_found", "No portal route");
    }
    if (user().role === "client_viewer" && !portalRoute && !p.startsWith("/auth/")) return err(403, "forbidden", "Client viewers use the portal only");

    // ---------- members ----------
    if (p === "/members" && m === "GET") return need("admin") ? done(reply(200, state.members.map(member))) : err(403, "forbidden", "Admins only");
    if (p === "/members" && m === "POST") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      const b = req.postDataJSON() as { email: string; name: string; role: MockUser["role"]; clientId: string | null };
      if ((b.role === "owner" || b.role === "admin") && user().role !== "owner") return err(403, "forbidden", "Owners only may create owners or admins");
      if ((b.role === "client_viewer") !== (b.clientId !== null)) return err(422, "validation_failed", "clientId is required for client_viewer and only for it");
      const u = { id: randomUUID(), email: b.email, name: b.name, role: b.role, clientId: b.clientId, status: "invited" as const };
      state.members.push(u);
      api.users.push(u);
      const token = randomBytes(24).toString("hex");
      state.tokens.set(token, u.id);
      return done(reply(201, { member: member(u), setupUrl: `http://localhost:4173/setup?token=${token}`, expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString() }));
    }
    const pm = p.match(/^\/members\/([^/]+)$/);
    if (pm && m === "PATCH") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      const target = state.members.find((x) => x.id === pm[1]);
      if (!target) return err(404, "not_found", "No such member");
      const b = req.postDataJSON() as { role?: MockUser["role"]; status?: "active" | "disabled" };
      if ((target.role === "owner" || target.role === "admin" || b.role === "owner" || b.role === "admin") && user().role !== "owner") return err(403, "forbidden", "Owners only");
      const activeOwners = state.members.filter((x) => x.role === "owner" && x.status === "active");
      if (target.role === "owner" && activeOwners.length === 1 && activeOwners[0]!.id === target.id && ((b.role && b.role !== "owner") || b.status === "disabled")) return err(409, "last_owner", "The last active owner cannot be demoted or disabled");
      Object.assign(target, b.role ? { role: b.role } : {}, b.status ? { status: b.status } : {});
      return done(reply(200, member(target)));
    }

    // ---------- price book ----------
    if (p === "/price-book" && m === "GET") {
      if (!need("assessor")) return err(403, "forbidden", "Assessors and up");
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      return done(reply(200, state.priceBook.filter((i) => !q || `${i.sku} ${i.name} ${i.description}`.toLowerCase().includes(q))));
    }
    const pb = p.match(/^\/price-book\/([^/]+)$/);
    if (pb && m === "PUT") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      const b = req.postDataJSON() as Item;
      if (state.priceBook.some((i) => i.sku === b.sku && i.id !== pb[1])) return err(409, "sku_exists", "SKU already used");
      const next = { ...b, id: pb[1]!, fromTemplate: false };
      const n = state.priceBook.findIndex((i) => i.id === pb[1]);
      if (n >= 0) state.priceBook[n] = next;
      else state.priceBook.push(next);
      return done(reply(200, next));
    }
    if (p === "/price-book/import-template" && m === "POST") {
      if (!need("admin")) return err(403, "forbidden", "Admins only");
      let added = 0;
      let skipped = 0;
      for (const t of TEMPLATE) {
        if (state.priceBook.some((i) => i.sku === t.sku)) skipped++;
        else (state.priceBook.push({ ...t, id: randomUUID() }), added++);
      }
      return done(reply(200, { added, skipped }));
    }

    // ---------- quotes ----------
    const aq = p.match(/^\/assessments\/([^/]+)\/quotes$/);
    if (aq && m === "GET") return need("viewer") ? done(reply(200, [...state.quotes.values()].filter((q) => q.assessmentId === aq[1]))) : err(403, "forbidden", "Not allowed");
    if (aq && m === "POST") {
      if (!need("assessor")) return err(403, "forbidden", "Assessors and up");
      if (aq[1] !== ASSESSMENT_ID) return err(404, "not_found", "Not found");
      if (opts.assessmentStatus() !== "complete") return err(409, "assessment_not_complete", "Complete the assessment first");
      const b = req.postDataJSON() as { title?: string; tiers?: Tier[] };
      const tiers = b.tiers ?? ["good", "better", "best"];
      return done(reply(201, newQuote(suggest(tiers), { tiers, ...(b.title ? { title: b.title } : {}) })));
    }
    const qm = p.match(/^\/quotes\/([^/]+)(\/actions|\/preview|\/csv)?$/);
    if (qm) {
      const q = state.quotes.get(qm[1]!);
      if (!q) return err(404, "not_found", "No such quote");
      const sub = qm[2];
      if (!sub && m === "GET") return need("viewer") ? done(reply(200, q)) : err(403, "forbidden", "Not allowed");
      if (!sub && m === "PUT") {
        if (!need("assessor")) return err(403, "forbidden", "Assessors and up");
        if (q.status !== "draft") return err(409, "quote_locked", "Only drafts can be edited");
        const parsed = QuoteInput.safeParse(req.postDataJSON());
        if (!parsed.success) return err(422, "validation_failed", parsed.error.issues[0]?.message ?? "Invalid");
        state.puts.push(parsed.data);
        const next = withTotals({ ...q, ...parsed.data });
        state.quotes.set(q.id, next);
        return done(reply(200, next));
      }
      if (sub === "/preview") return need("viewer") ? html(`<!doctype html><html><head><title>Proposal</title></head><body><h1>Proposal ${q.number}</h1><p>${q.title}</p></body></html>`) : err(403, "forbidden", "Not allowed");
      if (sub === "/csv") {
        if (!need("viewer")) return err(403, "forbidden", "Not allowed");
        const rows = [["description", "tier", "quantity"], ...q.lines.map((l) => [l.description, l.tier, String(l.quantity)])];
        return done(route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "text/csv" }, body: rows.map((r) => r.join(",")).join("\n") }));
      }
      if (sub === "/actions" && m === "POST") {
        const b = req.postDataJSON() as { action: string; tier?: Tier; name?: string; reason?: string };
        state.actions.push({ quoteId: q.id, body: b, by: user().email });
        const set = (patch: Partial<Quote>) => {
          const next = { ...q, ...patch, updatedAt: new Date().toISOString() };
          state.quotes.set(q.id, next);
          return done(reply(200, next));
        };
        const bad = () => err(409, "invalid_transition", `Not allowed from ${q.status}`);
        switch (b.action) {
          case "submit":
            if (!need("assessor")) return err(403, "forbidden", "Assessors and up");
            if (q.status !== "draft") return bad();
            if (q.lines.some((l) => l.needsPricing)) return err(422, "lines_need_pricing", "Some lines need pricing");
            return set({ status: q.belowMinMargin ? "pending_approval" : "approved" });
          case "approve":
            if (user().role !== "owner") return err(403, "forbidden", "Owners only");
            if (q.status !== "pending_approval") return bad();
            return set({ status: "approved", approvedBy: user().id });
          case "send":
            if (!need("admin")) return err(403, "forbidden", "Admins only");
            if (q.status !== "approved") return bad();
            return set({ status: "sent", sentAt: new Date().toISOString() });
          case "revise": {
            if (!need("assessor")) return err(403, "forbidden", "Assessors and up");
            if (q.status === "draft") return bad();
            const copy = newQuote(q.lines.map((l) => ({ ...l, id: randomUUID() })), { title: q.title, tiers: q.tiers, laborRate: q.laborRate });
            const r = { ...copy, number: `${q.number.replace(/-R\d+$/, "")}-R2` };
            state.counter--;
            state.quotes.set(r.id, r);
            return done(reply(200, r));
          }
          case "accept":
          case "decline": {
            const isClient = user().role === "client_viewer" && clientOf() === NORTHWIND;
            if (!isClient && !need("admin")) return err(403, "forbidden", "Not allowed");
            if (q.status === "expired") return err(409, "quote_expired", "This quote has expired");
            if (q.status !== "sent") return bad();
            if (!b.name?.trim()) return err(422, "validation_failed", "name required");
            if (b.action === "accept" && (!b.tier || !q.tiers.includes(b.tier))) return err(422, "validation_failed", "tier must be one of the quote's tiers");
            return set({ status: b.action === "accept" ? "accepted" : "declined", respondedAt: new Date().toISOString(), respondedBy: b.name.trim() });
          }
          default:
            return err(422, "validation_failed", "Unknown action");
        }
      }
    }

    // ---------- portfolio ----------
    if (p === "/portfolio") {
      if (!need("viewer")) return err(403, "forbidden", "Not allowed");
      return done(
        reply(200, {
          methodVersion: "risk-method@1.0.0",
          clients: [
            {
              clientId: NORTHWIND,
              clientName: "Northwind Logistics",
              sites: [
                {
                  siteId: "d0000000-0000-4000-8000-000000000001",
                  siteName: "Main warehouse",
                  history: [
                    { assessmentId: "e0000000-0000-4000-8000-000000000081", completedAt: "2026-03-10T10:00:00Z", level: "high", residual: 16, inherent: 20 },
                    { assessmentId: "e0000000-0000-4000-8000-000000000082", completedAt: "2026-07-10T10:00:00Z", level: "medium", residual: 12, inherent: 20 },
                    { assessmentId: ASSESSMENT_ID, completedAt: "2026-11-05T10:00:00Z", level: "medium", residual: 9, inherent: 20 },
                  ],
                  openFindings: { high: 2, low: 1 },
                  quotes: { sent: 2, accepted: 1, acceptedValue: 12480, openValue: 5320.5 },
                },
                {
                  siteId: "d0000000-0000-4000-8000-000000000002",
                  siteName: "Head office",
                  history: [{ assessmentId: "e0000000-0000-4000-8000-000000000098", completedAt: "2026-11-03T12:00:00Z", level: "high", residual: 16, inherent: 20 }],
                  openFindings: { critical: 1, medium: 3 },
                  quotes: { sent: 0, accepted: 0, acceptedValue: 0, openValue: 0 },
                },
              ],
            },
          ],
          caveats: ["Main warehouse in March 2026 used control library 1.0.0; later assessments use 1.1.0."],
        }),
      );
    }

    // Findings for the quote editor's group titles arrive through sync like any field record.
    if (p === "/sync/pull" && url.searchParams.get("assessmentId") === ASSESSMENT_ID)
      return done(
        reply(200, {
          cursor: "p4-1",
          hasMore: false,
          changes: FINDINGS.map((f) => ({ entity: "finding", id: f.id, version: 1, deleted: false, data: { id: f.id, assessmentId: ASSESSMENT_ID, areaId: null, assetId: null, title: f.title, description: f.description, recommendation: f.recommendation, severity: f.severity, status: "confirmed", source: "assessor", controlIds: f.controlIds, suggestionId: null } })),
        }),
      );
    return false;
  }

  /** POST /auth/setup: single-use token, sets the password, starts a session. */
  async function publicHandle(_route: Route, req: Request, url: URL, reply: Reply): Promise<boolean> {
    if (url.pathname !== "/auth/setup" || req.method() !== "POST") return false;
    const b = req.postDataJSON() as { token: string; password: string };
    const userId = state.tokens.get(b.token);
    if (!userId) return done(reply(400, { error: { code: "invalid_token", message: "Invalid or used token" } }));
    if (!b.password || b.password.length < 12) return done(reply(422, { error: { code: "validation_failed", message: "Password too short" } }));
    state.tokens.delete(b.token);
    const u = state.members.find((x) => x.id === userId)!;
    u.status = "active";
    state.passwords.set(u.id, b.password);
    api!.signInAs(u);
    return done(reply(200, { accessToken: "mock-access-token", session: { user: { id: u.id, email: u.email, name: u.name }, tenant: ACME, role: u.role } }));
  }

  return {
    state,
    handle,
    publicHandle,
    seedQuote,
    bind(s: MockState) {
      api = s;
    },
  };
}
