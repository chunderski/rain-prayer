/** Phase 4: branding, members and setup links, client_viewer route walk, portal, price book, quotes, portfolio. */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrandingResponse, Member, MemberInvite, Portfolio, PortalAssessment, Quote, quoteTotals } from "@sentinel/shared";
import { FIXTURE_SCENARIOS } from "./fixtures/scenarios.js";
import { asAppInTenant, asAppInTenantCommit, auth, createUser, DEV_PASSWORD, login, makeApp, tenantId } from "./helpers.js";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "price-book-template.json");

let app: FastifyInstance;
let owner: string;
let assessor: string;
let viewer: string;
let cv: string; // client_viewer of Northwind (seeded)
let blueOwner: string;
let blueCv: string;
let adminTok: string;
let cvOther: string; // client_viewer of another acme client
let acmeId: string;
let northwind: string;
let otherClient: string;
let aDone: string;
let aOpen: string;
let aOther: string;
let siteN: string;

type Res = Awaited<ReturnType<FastifyInstance["inject"]>>;
const call = (token: string, method: string, url: string, payload?: unknown): Promise<Res> =>
  app.inject({ method: method as "GET", url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
const ok = (r: Res, status = 200) => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json();
};
const errCode = (r: Res) => r.json().error.code;

async function makeAssessment(siteId: string, title: string, complete: boolean) {
  const a = ok(await call(owner, "POST", "/assessments", { siteId, title, frameworks: [{ frameworkId: "test-fw", version: "1.0.0" }] }), 201);
  const finding = (title: string, severity: string, status: string, controlIds: string[]) => {
    const id = randomUUID();
    return call(owner, "PUT", `/assessments/${a.id}/findings/${id}`, { id, assessmentId: a.id, title, severity, status, controlIds });
  };
  ok(await finding(`${title} fence gap`, "high", "confirmed", ["SC-PER-001"]), 201);
  ok(await finding(`${title} no crypto inventory`, "medium", "confirmed", ["SC-PER-002"]), 201);
  ok(await finding(`${title} SECRET-DRAFT-FINDING`, "low", "draft", ["SC-PER-001"]), 201);
  if (complete) for (const status of ["in_progress", "in_review", "complete"]) ok(await call(owner, "PATCH", `/assessments/${a.id}`, { status }));
  return a.id as string;
}

async function inviteAndSetup(by: string, body: Record<string, unknown>, password = "Correct-horse-battery-9") {
  const inv = MemberInvite.parse(ok(await call(by, "POST", "/members", body), 201));
  const token = inv.setupUrl.split("#token=")[1]!;
  const r = ok(await app.inject({ method: "POST", url: "/auth/setup", payload: { token, password } }));
  return { token: r.accessToken as string, userId: inv.member.userId, setupToken: token };
}

beforeAll(async () => {
  app = await makeApp({}, { risk: { scenarios: FIXTURE_SCENARIOS }, walkthrough: null, priceBookTemplatePath: TEMPLATE });
  owner = (await login(app, "owner@acme.test")).token;
  assessor = (await login(app, "assessor@acme.test")).token;
  viewer = (await login(app, "viewer@acme.test")).token;
  cv = (await login(app, "viewer@client.acme.test")).token;
  blueOwner = (await login(app, "owner@bluefield.test")).token;
  blueCv = (await login(app, "viewer@client.bluefield.test")).token;
  acmeId = await tenantId("acme-integrators");
  const clients = ok(await call(owner, "GET", "/clients"));
  northwind = clients.find((c: { name: string }) => c.name === "Northwind Logistics").id;
  otherClient = ok(await call(owner, "POST", "/clients", { name: "P4 Other Co" }), 201).id;
  siteN = ok(await call(owner, "POST", "/sites", { clientId: northwind, name: "NW Depot" }), 201).id;
  const siteO = ok(await call(owner, "POST", "/sites", { clientId: otherClient, name: "Other HQ" }), 201).id;
  ok(await call(owner, "PUT", "/tenant/quote-settings", { defaultLaborRate: 100, minMarginPct: 25, defaultTerms: "Net 30", validDays: 30 }));
  const item = (sku: string, tier: string, materialCost: number, laborHours: number, margin: number, assetTypes: string[] = []) =>
    call(owner, "PUT", `/price-book/${randomUUID()}`, {
      sku, name: `Item ${sku}`, category: "hardware", unit: "each", materialCost, laborHours, defaultMarginPct: margin, controlIds: ["SC-PER-001"], assetTypes, tier,
    });
  ok(await item("P4-FENCE-GOOD", "good", 100, 2, 30, ["fence"]));
  ok(await item("P4-FENCE-ANY", "any", 50, 1, 35));
  aDone = await makeAssessment(siteN, "P4 done", true);
  aOpen = await makeAssessment(siteN, "P4 open", false);
  aOther = await makeAssessment(siteO, "P4 other", true);
});
afterAll(() => app.close());

describe("branding", () => {
  it("client viewers read branding; defaults pass the contrast rule", async () => {
    const b = BrandingResponse.parse(ok(await call(cv, "GET", "/branding")));
    expect(b.plan).toBe("partner");
    expect(b.showPoweredBy).toBe(true);
    expect(BrandingResponse.parse(ok(await call(blueCv, "GET", "/branding"))).plan).toBe("standard");
  });

  it("refuses low contrast, non-admins, and turning off Powered by on the standard plan", async () => {
    const base = { displayName: "Acme Security Partners", primaryColor: "#123456", accentColor: "#f59e0b", reportFooter: "Confidential", contactEmail: "sales@acme.test", contactPhone: "+1 555 0100", website: "https://acme.test", showPoweredBy: true };
    const low = await call(owner, "PUT", "/branding", { ...base, primaryColor: "#ffff00" });
    expect(low.statusCode).toBe(422);
    expect(errCode(low)).toBe("contrast_too_low");
    expect((await call(owner, "PUT", "/branding", { ...base, primaryColor: "#777777" })).statusCode).toBe(422); // 4.48:1, just under
    expect((await call(assessor, "PUT", "/branding", base)).statusCode).toBe(403);
    const gated = await call(blueOwner, "PUT", "/branding", { ...base, showPoweredBy: false });
    expect(gated.statusCode).toBe(403);
    expect(errCode(gated)).toBe("plan_required");
    expect(ok(await call(blueOwner, "PUT", "/branding", base)).showPoweredBy).toBe(true);
    const partner = BrandingResponse.parse(ok(await call(owner, "PUT", "/branding", { ...base, showPoweredBy: false })));
    expect(partner.showPoweredBy).toBe(false);
    expect(partner.displayName).toBe("Acme Security Partners");
  });

  it("logo upload: SVG and non-images refused by content, metadata stripped, fit within 512 px", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    for (const ct of ["image/svg+xml", "image/png"]) {
      const r = await app.inject({ method: "PUT", url: "/branding/logo", headers: { ...auth(owner), "content-type": ct }, payload: svg });
      expect(r.statusCode, ct).toBe(415);
    }
    const png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#0b3d91" } })
      .withMetadata({ exif: { IFD0: { Copyright: "SECRET-EXIF", Artist: "someone" } } })
      .png()
      .toBuffer();
    expect((await sharp(png).metadata()).exif).toBeDefined();
    expect((await app.inject({ method: "PUT", url: "/branding/logo", headers: { ...auth(assessor), "content-type": "image/png" }, payload: png })).statusCode).toBe(403);
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await app.inject({ method: "PUT", url: "/branding/logo", headers: { ...auth(owner), "content-type": "image/png" }, payload: big })).statusCode).toBe(413);
    const b = BrandingResponse.parse(ok(await app.inject({ method: "PUT", url: "/branding/logo", headers: { ...auth(owner), "content-type": "image/png" }, payload: png })));
    expect(b.logoUrl).toMatch(/^http:\/\/api\.test\/files\//);
    const file = await app.inject({ url: new URL(b.logoUrl!).pathname });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    const meta = await sharp(file.rawPayload).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(256);
    expect(meta.exif).toBeUndefined();
    expect(file.rawPayload.includes(Buffer.from("SECRET-EXIF"))).toBe(false);
  });

  it("report preview is branded (logo, colors by hashed style, footer, contact) and drops X-Frame-Options (R3-6)", async () => {
    const r = await call(viewer, "GET", `/assessments/${aDone}/report/preview`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-frame-options"]).toBeUndefined();
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain('class="report-logo"');
    expect(r.body).toContain("--brand-primary:#123456");
    expect(r.body).toContain("Acme Security Partners");
    expect(r.body).toContain("sales@acme.test; +1 555 0100; https://acme.test");
    expect(r.body).not.toContain("Powered by Sentinel Assess"); // partner plan turned it off
    expect(r.body).toContain("Counts toward: TESTFW: Perimeter is fenced (TF-01)");
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toMatch(/style-src http:\/\/localhost:5173 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors");
    const blue = await call(blueOwner, "GET", "/branding");
    expect(blue.json().logoUrl).toBeNull();
  });

  it("deleting the logo clears it", async () => {
    expect((await call(owner, "DELETE", "/branding/logo")).statusCode).toBe(204);
    expect(ok(await call(owner, "GET", "/branding")).logoUrl).toBeNull();
    // Restore defaults for other test files.
    ok(await call(owner, "PUT", "/branding", { displayName: "Acme Integrators", primaryColor: "#0b3d91", accentColor: "#0f766e", showPoweredBy: true }));
  });
});

describe("members and setup links", () => {
  it("lists members with clientId and status; client viewers need a client", async () => {
    const list = ok(await call(owner, "GET", "/members")).map((m: unknown) => Member.parse(m));
    const c = list.find((m: Member) => m.email === "viewer@client.acme.test")!;
    expect(c).toMatchObject({ role: "client_viewer", clientId: northwind, clientName: "Northwind Logistics", status: "active" });
    expect((await call(owner, "POST", "/members", { email: "p4-nocl@acme.test", name: "No Client", role: "client_viewer" })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/members", { email: "p4-cl@acme.test", name: "Bad", role: "viewer", clientId: northwind })).statusCode).toBe(400);
  });

  it("only owners create owners or admins; setup tokens are single use", async () => {
    const admin = await inviteAndSetup(owner, { email: "p4-admin@acme.test", name: "Ada Admin", role: "admin" });
    adminTok = admin.token;
    const me = ok(await call(adminTok, "GET", "/auth/me"));
    expect(me.role).toBe("admin");
    for (const role of ["owner", "admin"]) {
      expect((await call(adminTok, "POST", "/members", { email: `p4-${role}2@acme.test`, name: "X", role })).statusCode, role).toBe(403);
    }
    const reuse = await app.inject({ method: "POST", url: "/auth/setup", payload: { token: admin.setupToken, password: "Another-password-123" } });
    expect(reuse.statusCode).toBe(400);
    expect(errCode(reuse)).toBe("invalid_setup_token");
    // The token is stored hashed only.
    const stored = await asAppInTenant(acmeId, async (q) => (await q("SELECT token_hash FROM member_setup_token WHERE user_id = $1", [admin.userId])).rows);
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toBe(admin.setupToken);
    expect(stored[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    // Admins may add assessors and client viewers.
    const other = await inviteAndSetup(adminTok, { email: "p4-cv-other@acme.test", name: "Olive Other", role: "client_viewer", clientId: otherClient });
    cvOther = other.token;
  });

  it("expired setup tokens are refused", async () => {
    const inv = MemberInvite.parse(ok(await call(owner, "POST", "/members", { email: "p4-late@acme.test", name: "Late", role: "viewer" }), 201));
    expect(new Date(inv.expiresAt).getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    await asAppInTenantCommit(acmeId, (q) => q("UPDATE member_setup_token SET expires_at = now() - interval '1 second' WHERE user_id = $1", [inv.member.userId]));
    const r = await app.inject({ method: "POST", url: "/auth/setup", payload: { token: inv.setupUrl.split("#token=")[1], password: "Correct-horse-battery-9" } });
    expect(r.statusCode).toBe(400);
    expect(inv.member.status).toBe("invited");
  });

  it("an invite for an existing account needs its current password, never sets a new one", async () => {
    await createUser("p4-existing@acme.test", [{ slug: "acme-integrators", role: "viewer" }]);
    const inv = MemberInvite.parse(ok(await call(blueOwner, "POST", "/members", { email: "p4-existing@acme.test", name: "Ignored", role: "viewer" }), 201));
    const token = inv.setupUrl.split("#token=")[1];
    const bad = await app.inject({ method: "POST", url: "/auth/setup", payload: { token, password: "Attacker-chosen-pass-1" } });
    expect(bad.statusCode).toBe(401);
    const good = ok(await app.inject({ method: "POST", url: "/auth/setup", payload: { token, password: DEV_PASSWORD } }));
    expect(good.session.tenant.slug).toBe("bluefield-security");
    await login(app, "p4-existing@acme.test", "acme-integrators"); // original password still works
  });

  it("last active owner cannot be demoted or disabled; admins cannot change owners", async () => {
    const members = ok(await call(blueOwner, "GET", "/members"));
    const self = members.find((m: Member) => m.email === "owner@bluefield.test").userId;
    for (const patch of [{ role: "admin" }, { status: "disabled" }]) {
      const r = await call(blueOwner, "PATCH", `/members/${self}`, patch);
      expect(r.statusCode).toBe(409);
      expect(errCode(r)).toBe("last_owner");
    }
    const acmeOwner = ok(await call(owner, "GET", "/members")).find((m: Member) => m.email === "owner@acme.test").userId;
    expect((await call(adminTok, "PATCH", `/members/${acmeOwner}`, { role: "viewer" })).statusCode).toBe(403);
  });

  it("disabled members lose access at once and cannot sign in", async () => {
    const m = await inviteAndSetup(owner, { email: "p4-temp@acme.test", name: "Temp", role: "assessor" });
    ok(await call(m.token, "GET", "/auth/me"));
    const r = Member.parse(ok(await call(owner, "PATCH", `/members/${m.userId}`, { status: "disabled" })));
    expect(r.status).toBe("disabled");
    expect((await call(m.token, "GET", "/auth/me")).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "p4-temp@acme.test", password: "Correct-horse-battery-9" } });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("member_disabled");
    ok(await call(owner, "PATCH", `/members/${m.userId}`, { status: "active" }));
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "p4-temp@acme.test", password: "Correct-horse-battery-9" } })).statusCode).toBe(200);
  });
});

describe("client_viewer is refused outside the portal", () => {
  // Public by design: health, signed file links, sign-in flows, and the Google OAuth callback (state-checked).
  const PUBLIC = new Set(["/health", "/files/:token", "/integrations/google/callback"]);
  it("every registered non-portal, non-auth route answers 401, 403, or 404, never 2xx", async () => {
    // OPTIONS routes are the CORS preflight handler (no data, no auth by design).
    const routes = app.routeRegistry.filter((r) => r.method !== "OPTIONS" && !r.url.startsWith("/portal/") && !r.url.startsWith("/auth/") && !PUBLIC.has(r.url) && !(r.method === "GET" && r.url === "/branding"));
    expect(routes.length).toBeGreaterThan(60);
    const failures: string[] = [];
    for (const r of routes) {
      const url = r.url.replace(/:[A-Za-z]+/g, () => randomUUID());
      const res = await app.inject({ method: r.method as "GET", url, headers: auth(cv), ...(["POST", "PUT", "PATCH"].includes(r.method) ? { payload: {} } : {}) });
      if (![401, 403, 404].includes(res.statusCode)) failures.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it("the portal list for a client viewer contains only their client's complete assessments", async () => {
    const list = ok(await call(cv, "GET", "/portal/assessments")).map((x: unknown) => PortalAssessment.parse(x));
    const ids = list.map((x: PortalAssessment) => x.id);
    expect(ids).toContain(aDone);
    expect(ids).not.toContain(aOpen);
    expect(ids).not.toContain(aOther);
    expect((await call(cv, "GET", `/portal/assessments?clientId=${otherClient}`)).statusCode).toBe(404);
    expect((await call(cv, "GET", `/portal/assessments/${aOther}`)).statusCode).toBe(404);
    expect((await call(cv, "GET", `/portal/assessments/${aOpen}`)).statusCode).toBe(404);
    expect((await call(blueCv, "GET", `/portal/assessments/${aDone}`)).statusCode).toBe(404);
    expect((await call(viewer, "GET", "/portal/assessments")).statusCode).toBe(400);
    expect(ok(await call(viewer, "GET", `/portal/assessments?clientId=${otherClient}`)).map((x: { id: string }) => x.id)).toEqual([aOther]);
    const detail = ok(await call(cv, "GET", `/portal/assessments/${aDone}`));
    expect(detail.findings).toHaveLength(2);
    expect(detail.findings.every((f: { status: string }) => f.status === "confirmed")).toBe(true);
    expect(detail.findings.find((f: { title: string }) => f.title.includes("fence")).frameworks[0]).toMatchObject({ shortName: "TESTFW", title: "Perimeter is fenced", requirementCode: "TF-01" });
    expect(detail.risk.assessmentId).toBe(aDone);
    const report = await call(cv, "GET", `/portal/assessments/${aDone}/report`);
    expect(report.statusCode).toBe(200);
    expect(report.body).not.toContain("SECRET-DRAFT-FINDING");
    expect(report.headers["x-frame-options"]).toBeUndefined();
    expect(report.headers["cache-control"]).toBe("no-store");
  });
});

describe("price book and template import", () => {
  it("enforces roles and unique skus", async () => {
    expect((await call(viewer, "GET", "/price-book")).statusCode).toBe(403);
    const items = ok(await call(assessor, "GET", "/price-book?q=P4-FENCE"));
    expect(items.map((i: { sku: string }) => i.sku).sort()).toEqual(["P4-FENCE-ANY", "P4-FENCE-GOOD"]);
    const dup = await call(owner, "PUT", `/price-book/${randomUUID()}`, { sku: "P4-FENCE-GOOD", name: "Dup", category: "hardware", unit: "each", materialCost: 1, laborHours: 0, defaultMarginPct: 10 });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe("sku_exists");
    expect((await call(assessor, "PUT", `/price-book/${randomUUID()}`, { sku: "X", name: "No", category: "hardware", unit: "each", materialCost: 1, laborHours: 0, defaultMarginPct: 10 })).statusCode).toBe(403);
    expect((await call(owner, "GET", "/tenant/quote-settings")).json()).toEqual({ defaultLaborRate: 100, minMarginPct: 25, defaultTerms: "Net 30", validDays: 30 });
    expect((await call(viewer, "GET", "/tenant/quote-settings")).statusCode).toBe(403);
  });

  it("imports the template once, skipping existing skus, and flags placeholder prices until repriced", async () => {
    expect(ok(await call(blueOwner, "POST", "/price-book/import-template", {}))).toEqual({ added: 2, skipped: 1 });
    expect(ok(await call(blueOwner, "POST", "/price-book/import-template", {}))).toEqual({ added: 0, skipped: 3 });
    const items = ok(await call(blueOwner, "GET", "/price-book"));
    expect(items.every((i: { fromTemplate: boolean }) => i.fromTemplate)).toBe(true);
    const [a, b] = items;
    const { fromTemplate: _f, ...rest } = a;
    expect(ok(await call(blueOwner, "PUT", `/price-book/${a.id}`, { ...rest, name: "Renamed only" })).fromTemplate).toBe(true);
    expect(ok(await call(blueOwner, "PUT", `/price-book/${a.id}`, { ...rest, materialCost: rest.materialCost + 10 })).fromTemplate).toBe(false);
    expect((await call(blueOwner, "DELETE", `/price-book/${b.id}`)).statusCode).toBe(204);
    expect(ok(await call(blueOwner, "GET", "/price-book")).map((i: { id: string }) => i.id)).not.toContain(b.id);
  });
});

describe("quotes", () => {
  let q: Quote;
  const put = (token: string, quote: Quote, over: Partial<Quote> = {}) => {
    const { title, laborRate, validUntil, tiers, notes, terms, lines } = { ...quote, ...over };
    return call(token, "PUT", `/quotes/${quote.id}`, { title, laborRate, validUntil, tiers, notes, terms, lines });
  };
  const act = (token: string, id: string, body: Record<string, unknown>) => call(token, "POST", `/quotes/${id}/actions`, body);

  it("generates a draft from confirmed findings with totals from quoteTotals", async () => {
    q = Quote.parse(ok(await call(assessor, "POST", `/assessments/${aDone}/quotes`, {}), 201));
    expect(q.number).toMatch(/^Q-\d{4}-\d{4}$/);
    expect(q.status).toBe("draft");
    expect(q.laborRate).toBe(100);
    expect(q.terms).toBe("Net 30");
    const fence = q.lines.filter((l) => l.description.includes("fence gap"));
    // One best item per presented tier; untiered ("any") items only when no tiered item fits.
    expect(fence.map((l) => l.tier).sort()).toEqual(["good"]);
    expect(q.lines.some((l) => l.description.includes("SECRET-DRAFT-FINDING"))).toBe(false);
    const np = q.lines.filter((l) => l.needsPricing);
    expect(np).toHaveLength(1);
    expect(np[0]!.description).toContain("no crypto inventory");
    expect(q.totals).toEqual(quoteTotals(q));
    const list = ok(await call(viewer, "GET", `/assessments/${aDone}/quotes`));
    expect(list.map((x: Quote) => x.id)).toContain(q.id);
  });

  it("needsPricing blocks submit; low margin needs owner approval; locked after submit", async () => {
    const blocked = await act(assessor, q.id, { action: "submit" });
    expect(blocked.statusCode).toBe(422);
    expect(errCode(blocked)).toBe("lines_need_pricing");
    const lines = q.lines.map((l) => (l.needsPricing ? { ...l, needsPricing: false, materialCost: 400, laborHours: 3, marginPct: 5, description: "=HYPERLINK(\"http://evil\")" } : l));
    lines.push({ ...lines[0]!, id: randomUUID(), description: "@SUM(1)", optional: true, tier: "all" });
    q = Quote.parse(ok(await put(assessor, q, { lines })));
    expect(q.totals).toEqual(quoteTotals(q));
    expect(q.belowMinMargin).toBe(true);
    expect(q.minMarginPct).toBe(25);
    const csv = await call(viewer, "GET", `/quotes/${q.id}/csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.body).toContain("'@SUM(1)");
    expect(csv.body).not.toMatch(/(^|,)[=@+-][A-Z"]/m);
    q = Quote.parse(ok(await act(assessor, q.id, { action: "submit" })));
    expect(q.status).toBe("pending_approval");
    const locked = await put(assessor, q);
    expect(locked.statusCode).toBe(409);
    expect(errCode(locked)).toBe("quote_locked");
    expect((await act(adminTok, q.id, { action: "approve" })).statusCode).toBe(403);
    expect((await act(assessor, q.id, { action: "approve" })).statusCode).toBe(403);
    expect((await act(owner, q.id, { action: "send" })).statusCode).toBe(409);
    q = Quote.parse(ok(await act(owner, q.id, { action: "approve" })));
    expect(q.status).toBe("approved");
    expect(q.approvedBy).toBeTruthy();
  });

  it("portal shows only delivered quotes; accept by another client's viewer is refused", async () => {
    expect((await call(cv, "GET", `/portal/quotes/${q.id}`)).statusCode).toBe(404);
    expect((await act(assessor, q.id, { action: "send" })).statusCode).toBe(403);
    q = Quote.parse(ok(await act(adminTok, q.id, { action: "send" })));
    expect(q.status).toBe("sent");
    const portalBody = ok(await call(cv, "GET", `/portal/quotes/${q.id}`)) as Record<string, unknown> & { lines: Record<string, unknown>[]; totals: Record<string, unknown>[] };
    expect(portalBody.id).toBe(q.id);
    // Prices only: integrator cost, labor, and margin never reach a client login.
    const leaked = JSON.stringify(portalBody);
    for (const k of ["materialCost", "laborHours", "laborRate", "marginPct", "minMarginPct", "belowMinMargin", "approvedBy", "\"margin\"", "\"cost\"", "\"materials\"", "\"labor\""]) expect(leaked).not.toContain(k);
    expect(portalBody.lines.every((l) => typeof l.unitPrice === "number")).toBe(true);
    const pa = ok(await call(cv, "GET", "/portal/assessments")).find((x: PortalAssessment) => x.id === aDone);
    expect(pa.quotes.map((x: { id: string }) => x.id)).toEqual([q.id]);
    const preview = await call(cv, "GET", `/portal/quotes/${q.id}/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["x-frame-options"]).toBeUndefined();
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.body).not.toContain("<script");
    expect(preview.body).not.toMatch(/margin/i); // client facing: prices only
    expect(preview.body).toContain("Powered by Sentinel Assess");
    expect((await call(cvOther, "GET", `/portal/quotes/${q.id}`)).statusCode).toBe(404);
    expect((await act(cvOther, q.id, { action: "accept", tier: "good", name: "Olive" })).statusCode).toBe(404);
    expect((await act(blueCv, q.id, { action: "accept", tier: "good", name: "Blue" })).statusCode).toBe(404);
    expect((await act(viewer, q.id, { action: "accept", tier: "good", name: "Vic" })).statusCode).toBe(403);
    expect((await act(cv, q.id, { action: "approve" })).statusCode).toBe(403);
    const accepted = await act(cv, q.id, { action: "accept", tier: "good", name: "Casey Client" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).not.toContain("materialCost");
    expect(accepted.body).not.toContain("marginPct");
    expect(accepted.json().acceptedTier).toBe("good");
    const raw = ok(await call(viewer, "GET", `/quotes/${q.id}`));
    expect(Quote.parse(raw)).toMatchObject({ status: "accepted", respondedBy: "Casey Client" });
    expect(raw.acceptedTier).toBe("good");
    expect(raw.respondedAt).toBeTruthy();
    expect((await act(cv, q.id, { action: "decline", name: "Casey" })).statusCode).toBe(409);
    const audits = await asAppInTenant(acmeId, async (qq) => (await qq("SELECT action FROM audit_log WHERE entity_type = 'quote' AND entity_id = $1 ORDER BY at", [q.id])).rows.map((r) => r.action));
    expect(audits).toEqual(expect.arrayContaining(["quote.create", "quote.update", "quote.submit", "quote.approve", "quote.send", "quote.accept"]));
  });

  it("revise numbers R2, R3 and copies lines into a new draft", async () => {
    const r2 = Quote.parse(ok(await act(assessor, q.id, { action: "revise" })));
    expect(r2.number).toBe(`${q.number}-R2`);
    expect(r2.status).toBe("draft");
    expect(r2.lines).toHaveLength(q.lines.length);
    expect((await act(assessor, r2.id, { action: "revise" })).statusCode).toBe(409);
    const r3 = Quote.parse(ok(await act(owner, q.id, { action: "revise" })));
    expect(r3.number).toBe(`${q.number}-R3`);
    expect((await call(cv, "GET", `/portal/quotes/${r2.id}`)).statusCode).toBe(404);
  });

  it("a sent quote past validUntil reads as expired, cannot be accepted, and can be revised", async () => {
    let e = Quote.parse(ok(await call(assessor, "POST", `/assessments/${aDone}/quotes`, { tiers: ["good"] }), 201));
    const lines = e.lines.map((l) => ({ ...l, needsPricing: false, materialCost: 100, laborHours: 1, marginPct: 40 }));
    e = Quote.parse(ok(await put(assessor, e, { lines, validUntil: "2020-01-01" })));
    expect(Quote.parse(ok(await act(assessor, e.id, { action: "submit" }))).status).toBe("approved");
    expect(Quote.parse(ok(await act(owner, e.id, { action: "send" }))).status).toBe("expired");
    const acc = await act(cv, e.id, { action: "accept", tier: "good", name: "Casey" });
    expect(acc.statusCode).toBe(409);
    expect(errCode(acc)).toBe("quote_expired");
    expect(ok(await call(cv, "GET", `/portal/quotes/${e.id}`)).status).toBe("expired");
    const rev = Quote.parse(ok(await act(assessor, e.id, { action: "revise" })));
    expect(rev.status).toBe("draft");
    expect(rev.validUntil > new Date().toISOString().slice(0, 10)).toBe(true);
    const stored = await asAppInTenant(acmeId, async (qq) => (await qq("SELECT status FROM quote WHERE id = $1", [e.id])).rows[0].status);
    expect(stored).toBe("expired"); // persisted when touched
  });

  it("quotes are allowed on complete assessments; viewers cannot create or edit", async () => {
    expect((await call(viewer, "POST", `/assessments/${aDone}/quotes`, {})).statusCode).toBe(403);
    expect((await call(cv, "GET", `/quotes/${q.id}`)).statusCode).toBe(403);
    expect((await call(blueOwner, "GET", `/quotes/${q.id}`)).statusCode).toBe(404);
  });
});

describe("portfolio", () => {
  it("builds history from snapshots of complete assessments with quote values", async () => {
    const p = Portfolio.parse(ok(await call(viewer, "GET", `/portfolio?clientId=${northwind}`)));
    expect(p.clients).toHaveLength(1);
    const site = p.clients[0]!.sites.find((s) => s.siteId === siteN)!;
    expect(site.history.map((h) => h.assessmentId)).toEqual([aDone]);
    expect(site.openFindings).toEqual({ high: 1, medium: 1 });
    expect(site.quotes.accepted).toBe(1);
    const accepted = (ok(await call(viewer, "GET", `/assessments/${aDone}/quotes`)) as Quote[]).find((x) => x.status === "accepted")!;
    expect(site.quotes.acceptedValue).toBe(accepted.totals.find((t) => t.tier === "good")!.price);
    expect((await call(cv, "GET", "/portfolio")).statusCode).toBe(403);
  });
});


describe("branded Google Docs requests", () => {
  it("insert the logo, colored title, footer, contact line, and Powered by", async () => {
    const { renderDocsRequests } = await import("../src/report/gdocs.js");
    const { LOGO_IMAGE_ID, TEMPLATE_VERSION } = await import("../src/report/model.js");
    const reqs = renderDocsRequests({
      templateVersion: TEMPLATE_VERSION, title: "T", subtitle: "S", brandName: "Acme", generatedAt: "2026-11-06T00:00:00.000Z", blocks: [],
      brand: { displayName: "Acme", primaryColor: "#123456", accentColor: "#654321", footer: "Footer F", contact: "a@acme.test", poweredBy: true, logoKey: "k" },
    }, new Map([[LOGO_IMAGE_ID, "https://img.example/logo.png"]]));
    const text = reqs.map((r) => (r as { insertText?: { text: string } }).insertText?.text).filter(Boolean);
    expect(text).toEqual(expect.arrayContaining(["Footer F\n", "a@acme.test\n", "Powered by Sentinel Assess\n"]));
    expect(reqs.some((r) => (r as { insertInlineImage?: { uri: string } }).insertInlineImage?.uri === "https://img.example/logo.png")).toBe(true);
    expect(reqs.some((r) => "updateTextStyle" in r)).toBe(true);
  });
});
