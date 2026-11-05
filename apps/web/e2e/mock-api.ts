/**
 * In-memory mock of the Phase 1 API (docs/api-phase1.md) served through page.route(), so the E2E
 * suite runs without the backend. State is per page.
 */
import type { Page, Request, Route } from "@playwright/test";

export const API = "http://localhost:3000";
export const PASSWORD = "Sentinel-dev-2026!";

const TENANTS = {
  acme: { id: "a0000000-0000-4000-8000-000000000001", slug: "acme-integrators", name: "Acme Integrators" },
  bluefield: { id: "a0000000-0000-4000-8000-000000000002", slug: "bluefield-security", name: "Bluefield Security" },
};

const fw = (id: string, name: string, shortName: string, category: string, kind: string, description: string, requirementCount: number, needsReviewCount: number) => ({
  id, name, shortName, kind, category, description, publisher: "Test fixture", sourceEdition: "fixture", version: "1.0.0", requirementCount, controlCount: 0, needsReviewCount,
});

export const FRAMEWORKS = [
  fw("physical-general", "General physical security assessment", "Physical security", "physical", "assessment_checklist", "Perimeter, access control, video, alarms, locks, lighting, guards, and policy.", 24, 0),
  fw("cpted", "Crime Prevention Through Environmental Design", "CPTED", "physical", "design_principles", "Design principles: natural surveillance, access control, territoriality, maintenance.", 6, 2),
  fw("carver", "CARVER target analysis", "CARVER", "physical", "target_analysis", "Scores assets on criticality, accessibility, recuperability, vulnerability, effect, recognizability.", 6, 0),
  fw("nist-csf-2", "NIST Cybersecurity Framework 2.0", "NIST CSF 2.0", "cyber", "control_framework", "Govern, identify, protect, detect, respond, and recover outcomes for cyber risk.", 106, 0),
  fw("pqc-readiness", "Post-quantum cryptography readiness", "PQC readiness", "cyber", "readiness_model", "Crypto inventory, quantum-vulnerable algorithms, and migration planning (FIPS 203, 204, 205).", 12, 3),
];

const m = (frameworkId: string, requirementCode: string, relationship = "supports") => ({ frameworkId, requirementCode, relationship });
export const CONTROLS = [
  { id: "SC-LGT-001", domain: "LGT", title: "Exterior lighting covers approaches and entrances", objective: "Entrances, parking, and approaches are lit so people and faces can be identified at night.", defaultSeverity: "high", assetTypes: ["lighting"], status: "approved", questionCount: 3, mappings: [m("physical-general", "SA-LGT-1", "satisfies"), m("cpted", "SA-CPTED-NS", "supports"), m("carver", "SA-CARVER-R", "informs")] },
  { id: "SC-PER-001", domain: "PER", title: "Perimeter fence is intact", objective: "The perimeter barrier is continuous with no gaps, climb aids, or damage.", defaultSeverity: "medium", assetTypes: ["fence"], status: "approved", questionCount: 2, mappings: [m("physical-general", "SA-PER-1", "satisfies"), m("cpted", "SA-CPTED-AC")] },
  { id: "SC-ENV-001", domain: "ENV", title: "Landscaping preserves sight lines", objective: "Shrubs and trees do not block natural surveillance of entrances and paths.", defaultSeverity: "low", assetTypes: ["landscaping"], status: "needs_review", questionCount: 2, mappings: [m("cpted", "SA-CPTED-NS", "satisfies")] },
  { id: "SC-GOV-001", domain: "GOV", title: "Cybersecurity roles are assigned", objective: "Cybersecurity roles and responsibilities are documented and assigned.", defaultSeverity: "medium", assetTypes: [], status: "approved", questionCount: 2, mappings: [m("nist-csf-2", "GV.RR-02", "satisfies")] },
  { id: "SC-CRY-001", domain: "CRY", title: "Cryptographic inventory exists", objective: "An inventory lists where public-key cryptography is used, with algorithms and key sizes.", defaultSeverity: "high", assetTypes: ["cryptographic_asset"], status: "approved", questionCount: 4, mappings: [m("nist-csf-2", "ID.AM-08"), m("pqc-readiness", "SA-PQC-INV-1", "satisfies")] },
];

const controlDetail = (id: string) => {
  const c = CONTROLS.find((x) => x.id === id);
  if (!c) return null;
  const n = id.slice(3);
  return {
    ...c,
    evidence: [{ type: "photo", description: "Night photo of each entrance." }],
    questions: Array.from({ length: c.questionCount }, (_, i) => ({
      id: `Q-${n}-0${i + 1}`,
      text: `Fixture question ${i + 1} for ${c.title.toLowerCase()}?`,
      answerType: "yes_no_na",
      guidance: "Walk the site and check each location; answer no if any location fails.",
      photoOnDeficiency: true,
    })),
    references: [],
    mappings: c.mappings.map((mp) => ({
      ...mp,
      frameworkShortName: FRAMEWORKS.find((f) => f.id === mp.frameworkId)!.shortName,
      requirementTitle: `Requirement ${mp.requirementCode}`,
      rationale: `Evidence for ${c.id} demonstrates ${mp.requirementCode}.`,
    })),
  };
};

export type ExtraHandler = (route: Route, req: Request, url: URL, reply: (status: number, body?: unknown) => Promise<void>, cors: Record<string, string>) => Promise<boolean>;

export interface MockOptions {
  /** Make login answer 409 tenant_required until a tenantSlug is sent. */
  multiTenant?: boolean;
  /** Assessments listed from the start (Phase 2 specs seed one). */
  seedAssessments?: Record<string, unknown>[];
  /** Phase 2 routes (e2e/mock-field.ts), tried before the 404 fallback. */
  extra?: ExtraHandler;
}

export interface MockState {
  createdAssessments: unknown[];
  requests: string[];
  /**
   * page.route() still fulfills requests while the context is offline, so specs that call
   * context.setOffline(true) set this too and the mock fails every API request like a dead network.
   */
  offline: boolean;
}

export async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const state: MockState = { createdAssessments: [], requests: [], offline: false };
  let signedIn = false;
  let tenant = TENANTS.acme;
  const clients: { id: string; name: string; industry: string | null; siteCount: number; createdAt: string; notes: string | null }[] = [
    { id: "c0000000-0000-4000-8000-000000000001", name: "Northwind Logistics", industry: "Logistics", siteCount: 2, createdAt: "2026-10-01T00:00:00Z", notes: null },
  ];
  const sites = [
    { id: "d0000000-0000-4000-8000-000000000001", clientId: clients[0]!.id, name: "Main warehouse", address: "1 Dock Road", siteType: "warehouse" },
    { id: "d0000000-0000-4000-8000-000000000002", clientId: clients[0]!.id, name: "Head office", address: "20 High Street", siteType: "office" },
  ];
  const assessments: Record<string, unknown>[] = [...(opts.seedAssessments ?? [])];

  const session = () => ({
    user: { id: "b0000000-0000-4000-8000-000000000001", email: "assessor@acme.test", name: "Alex Assessor" },
    tenant,
    role: "admin",
  });

  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const origin = req.headers()["origin"] ?? "http://localhost:4173";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      Vary: "Origin",
    };
    const reply = (status: number, body?: unknown) =>
      route.fulfill({ status, headers: { ...cors, "Content-Type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
    const err = (status: number, code: string, message: string, details?: unknown) => reply(status, { error: { code, message, details } });

    if (state.offline) return route.abort("internetdisconnected");
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname;
    state.requests.push(`${req.method()} ${path}${url.search}`);
    const authed = req.headers()["authorization"] === "Bearer mock-access-token";

    if (path === "/auth/refresh") return signedIn ? reply(200, { accessToken: "mock-access-token", session: session() }) : err(401, "no_session", "Not signed in");
    if (path === "/auth/logout") {
      signedIn = false;
      return reply(204);
    }
    if (path === "/auth/login") {
      const body = req.postDataJSON() as { email: string; password: string; tenantSlug?: string };
      if (body.password !== PASSWORD) return err(401, "invalid_credentials", "Email or password is incorrect");
      if (opts.multiTenant && !body.tenantSlug) {
        return err(409, "tenant_required", "Choose a workspace", { tenants: [TENANTS.acme, TENANTS.bluefield].map(({ slug, name }) => ({ slug, name })) });
      }
      tenant = body.tenantSlug === TENANTS.bluefield.slug ? TENANTS.bluefield : TENANTS.acme;
      signedIn = true;
      return reply(200, { accessToken: "mock-access-token", session: session() });
    }
    // Signed photo URLs carry their own grant, not a bearer token.
    if (path.startsWith("/files/") && opts.extra && (await opts.extra(route, req, url, reply, cors))) return;
    if (!authed) return err(401, "unauthorized", "Sign in required");
    if (opts.extra && (await opts.extra(route, req, url, reply, cors))) return;

    if (path === "/frameworks") return reply(200, FRAMEWORKS);
    if (path === "/controls") {
      const f = url.searchParams.get("framework");
      const d = url.searchParams.get("domain");
      const q = url.searchParams.get("q")?.toLowerCase();
      return reply(
        200,
        CONTROLS.filter(
          (c) =>
            (!f || c.mappings.some((mp) => mp.frameworkId === f)) &&
            (!d || c.domain === d) &&
            (!q || `${c.title} ${c.objective}`.toLowerCase().includes(q)),
        ),
      );
    }
    const controlMatch = path.match(/^\/controls\/([^/]+)$/);
    if (controlMatch) {
      const c = controlDetail(decodeURIComponent(controlMatch[1]!));
      return c ? reply(200, c) : err(404, "not_found", "Control not found");
    }
    if (path === "/clients" && req.method() === "GET") return reply(200, clients);
    if (path === "/clients" && req.method() === "POST") {
      const body = req.postDataJSON() as { name: string; industry?: string };
      const c = { id: `c0000000-0000-4000-8000-00000000000${clients.length + 1}`, name: body.name, industry: body.industry ?? null, siteCount: 0, createdAt: new Date().toISOString(), notes: null };
      clients.push(c);
      return reply(201, c);
    }
    const clientMatch = path.match(/^\/clients\/([^/]+)$/);
    if (clientMatch) {
      const c = clients.find((x) => x.id === clientMatch[1]);
      return c ? reply(200, { ...c, sites: sites.filter((s) => s.clientId === c.id) }) : err(404, "not_found", "Client not found");
    }
    if (path === "/sites" && req.method() === "GET") return reply(200, sites.filter((s) => s.clientId === url.searchParams.get("clientId")));
    if (path === "/sites" && req.method() === "POST") {
      const body = req.postDataJSON() as { clientId: string; name: string; address?: string; siteType?: string };
      const s = { id: `d0000000-0000-4000-8000-00000000000${sites.length + 1}`, address: null, siteType: null, ...body };
      sites.push(s as (typeof sites)[number]);
      return reply(201, s);
    }
    if (path === "/assessments" && req.method() === "GET") return reply(200, assessments);
    if (path === "/assessments" && req.method() === "POST") {
      const body = req.postDataJSON() as { siteId: string; title: string; frameworks: { frameworkId: string; version: string }[]; scheduledFor?: string };
      state.createdAssessments.push(body);
      const site = sites.find((s) => s.id === body.siteId)!;
      const ids = new Set(CONTROLS.filter((c) => c.mappings.some((mp) => body.frameworks.some((f) => f.frameworkId === mp.frameworkId))).map((c) => c.id));
      const a = {
        id: `e0000000-0000-4000-8000-00000000000${assessments.length + 1}`,
        title: body.title,
        status: "draft",
        siteId: site.id,
        siteName: site.name,
        clientName: clients.find((c) => c.id === site.clientId)!.name,
        frameworks: body.frameworks.map((f) => ({ ...f, shortName: FRAMEWORKS.find((x) => x.id === f.frameworkId)!.shortName })),
        createdAt: new Date().toISOString(),
        scheduledFor: body.scheduledFor ?? null,
        controlCount: ids.size,
        questionCount: CONTROLS.filter((c) => ids.has(c.id)).reduce((n, c) => n + c.questionCount, 0),
      };
      assessments.push(a);
      return reply(201, a);
    }
    const assessmentMatch = path.match(/^\/assessments\/([^/]+)$/);
    if (assessmentMatch) {
      const a = assessments.find((x) => x.id === assessmentMatch[1]);
      return a ? reply(200, a) : err(404, "not_found", "Assessment not found");
    }
    return err(404, "not_found", `No mock for ${req.method()} ${path}`);
  });
  return state;
}
