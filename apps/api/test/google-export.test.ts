/** Phase 3 Google: connect (state, PKCE, binding), encrypted tokens, export jobs with a fake Google, Docs request builder. */
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportJob } from "@sentinel/shared";
import { DRIVE_FILE_SCOPE, type Transport } from "../src/google/client.js";
import { openToken, sealToken } from "../src/google/tokens.js";
import { createSemaphore } from "../src/lib/semaphore.js";
import { renderDocsRequests } from "../src/report/gdocs.js";
import { TEMPLATE_VERSION, type ReportDoc } from "../src/report/model.js";
import { FIXTURE_SCENARIOS } from "./fixtures/scenarios.js";
import { WEB_ORIGIN, asAppInTenant, auth, fieldFixture, login, makeApp, nowIso, tenantId, type FieldFixture } from "./helpers.js";

const TOKEN_KEY = randomBytes(32).toString("base64");
const REFRESH = "1//refresh-SECRET-token-value";
const ACCESS = "ya29.ACCESS-SECRET-token";
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-google-secret", GOOGLE_TOKEN_KEY: TOKEN_KEY };

interface Call { method: string; url: string; body: string }

/** In-memory Google: OAuth, Drive files and permissions, Docs and Sheets updates. */
function fakeGoogle() {
  const calls: Call[] = [];
  /** Each entry fails the next matching call once, in order. */
  const failures: { frag: string; status: number }[] = [];
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const transport: Transport = async (url, init) => {
    const body = typeof init.body === "string" ? init.body : init.body ? Buffer.from(init.body).toString("latin1") : "";
    calls.push({ method: init.method, url, body });
    const i = failures.findIndex((f) => url.includes(f.frag));
    if (i >= 0) {
      const [f] = failures.splice(i, 1);
      return json(f!.status, { error: { status: "UNAVAILABLE", message: "slow down" } });
    }
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "good-code" || !p.get("code_verifier")) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: ACCESS, refresh_token: REFRESH, scope: DRIVE_FILE_SCOPE, expires_in: 3600 });
      }
      return p.get("refresh_token") === REFRESH ? json(200, { access_token: ACCESS, expires_in: 3600 }) : json(400, { error: "invalid_grant" });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json(200, {});
    if (url.includes("/drive/v3/about")) return json(200, { user: { emailAddress: "drive@example.test" } });
    if (url.includes("/permissions/") && init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/permissions")) return json(200, { id: `perm${++n}` });
    if (url.includes("/drive/v3/files") || url.includes("/upload/drive/v3/files")) return json(200, { id: `file${++n}` });
    if (url.includes(":batchUpdate")) return json(200, {});
    return json(404, { error: { status: "NOT_FOUND" } });
  };
  return { calls, failures, transport };
}

let app: FastifyInstance;
let g: ReturnType<typeof fakeGoogle>;
let owner: string;
let assessor: string;
let viewer: string;
let fx: FieldFixture;
let acmeId: string;
const responses: string[] = [];

const capture = async (p: Promise<{ body: string }>) => {
  const r = await p;
  responses.push(r.body);
  return r as Awaited<typeof p> & { statusCode: number; json: () => any; headers: Record<string, unknown>; cookies: { name: string; value: string }[] };
};

async function startConnect(token = owner) {
  const res = await capture(app.inject({ url: "/integrations/google/connect", headers: auth(token) }));
  expect(res.statusCode).toBe(200);
  const url = new URL(res.json().url);
  const cookie = res.cookies.find((c) => c.name === "sa_gconn")!.value;
  return { url, state: url.searchParams.get("state")!, cookie };
}
const callback = (query: string, cookie?: string) =>
  capture(app.inject({ url: `/integrations/google/callback?${query}`, ...(cookie ? { cookies: { sa_gconn: cookie } } : {}) }));
const outcome = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers.location));

beforeAll(async () => {
  g = fakeGoogle();
  app = await makeApp(GOOGLE_ENV, { risk: { scenarios: FIXTURE_SCENARIOS }, googleApi: { transport: g.transport, sleep: async () => {} } });
  owner = (await login(app, "owner@acme.test")).token;
  const a = await login(app, "assessor@acme.test");
  assessor = a.token;
  viewer = (await login(app, "viewer@acme.test")).token;
  fx = await fieldFixture(app, owner, [a.body.session.user.id], "Export site");
  acmeId = await tenantId("acme-integrators");
});
afterAll(() => app.close());

describe("Google not configured", () => {
  it("answers 503 google_not_configured with placeholder credentials or no token key", async () => {
    for (const env of [{}, { ...GOOGLE_ENV, GOOGLE_TOKEN_KEY: "replace-me" }, { ...GOOGLE_ENV, GOOGLE_CLIENT_ID: "replace-me.apps.googleusercontent.com" }]) {
      const plain = await makeApp(env);
      for (const [method, url] of [["GET", "/integrations/google"], ["GET", "/integrations/google/connect"], ["DELETE", "/integrations/google"], ["POST", `/assessments/${fx.assessmentId}/exports`]] as const) {
        const res = await plain.inject({ method, url, headers: auth(owner), ...(method === "POST" ? { payload: { targets: ["docs"] } } : {}) });
        expect(res.statusCode, url).toBe(503);
        expect(res.json().error.code).toBe("google_not_configured");
      }
      await plain.close();
    }
  });

  it("rejects a malformed GOOGLE_TOKEN_KEY at startup", async () => {
    await expect(makeApp({ ...GOOGLE_ENV, GOOGLE_TOKEN_KEY: Buffer.alloc(16).toString("base64") })).rejects.toThrow(/GOOGLE_TOKEN_KEY/);
  });
});

describe("token encryption", () => {
  it("round trips and is bound to the tenant", () => {
    const key = Buffer.from(TOKEN_KEY, "base64");
    const t1 = randomUUID();
    const s = sealToken(key, t1, REFRESH);
    expect(s.ciphertext.toString("latin1")).not.toContain("refresh");
    expect(openToken(key, t1, s)).toBe(REFRESH);
    expect(() => openToken(key, randomUUID(), s)).toThrow();
    expect(() => openToken(randomBytes(32), t1, s)).toThrow();
    const tampered = { ...s, ciphertext: Buffer.from(s.ciphertext) };
    tampered.ciphertext[0]! ^= 1;
    expect(() => openToken(key, t1, tampered)).toThrow();
    expect(sealToken(key, t1, REFRESH).iv.equals(s.iv)).toBe(false);
  });
});

describe("connect", () => {
  it("is admin only and asks for drive.file with PKCE and offline access", async () => {
    expect((await app.inject({ url: "/integrations/google/connect", headers: auth(assessor) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/integrations/google/connect" })).statusCode).toBe(401);
    const { url } = await startConnect();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://api.test/integrations/google/callback");
    expect(url.searchParams.get("state")).not.toContain(acmeId);
  });

  it("rejects tampered state, a missing or wrong binding cookie, and replays", async () => {
    const { state, cookie } = await startConnect();
    const flipped = state.slice(0, -5) + (state.at(-5) === "A" ? "B" : "A") + state.slice(-4);
    const cases = [
      callback(`code=good-code&state=${encodeURIComponent(flipped)}`, cookie),
      callback(`code=good-code&state=${encodeURIComponent(state)}`),
      callback(`code=good-code&state=${encodeURIComponent(state)}`, "wrong-binding"),
      callback(`code=good-code&state=garbage`, cookie),
    ];
    for (const p of cases) {
      const res = await p;
      expect(res.statusCode).toBe(302);
      expect(outcome(res).searchParams.get("google")).toBe("error");
      expect(outcome(res).searchParams.get("reason")).toBe("invalid_state");
    }
    // A fresh state works once; the replay fails.
    const ok = await callback(`code=good-code&state=${encodeURIComponent(state)}`, cookie);
    expect(outcome(ok).toString()).toBe(`${WEB_ORIGIN}/settings/integrations?google=connected`);
    const replay = await callback(`code=good-code&state=${encodeURIComponent(state)}`, cookie);
    expect(outcome(replay).searchParams.get("reason")).toBe("invalid_state");
    const denied = await callback(`error=access_denied&state=${encodeURIComponent(state)}`, cookie);
    expect(outcome(denied).searchParams.get("reason")).toBe("google_denied");
  });

  it("stores the refresh token encrypted, never returns it, and audits the connection", async () => {
    const status = await capture(app.inject({ url: "/integrations/google", headers: auth(owner) }));
    expect(status.json()).toMatchObject({ connected: true, email: "drive@example.test", scopes: [DRIVE_FILE_SCOPE] });
    const row = await asAppInTenant(acmeId, async (q) => (await q("SELECT refresh_token, iv, tag FROM google_connection")).rows[0]);
    expect(Buffer.from(row.refresh_token).toString("latin1")).not.toContain("SECRET");
    expect(openToken(Buffer.from(TOKEN_KEY, "base64"), acmeId, { ciphertext: row.refresh_token, iv: row.iv, tag: row.tag })).toBe(REFRESH);
    const audit = await asAppInTenant(acmeId, async (q) => (await q("SELECT details FROM audit_log WHERE action = 'google.connect'")).rows);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("SECRET");
  });
});

describe("export jobs", () => {
  let photoId: string;
  beforeAll(async () => {
    const fid = randomUUID();
    await app.inject({
      method: "PUT", url: `/assessments/${fx.assessmentId}/findings/${fid}`, headers: auth(assessor),
      payload: { id: fid, assessmentId: fx.assessmentId, title: "=IMPORTXML(\"http://evil\")", description: "<b>bold</b>", recommendation: "Repair gate", severity: "high", status: "confirmed", controlIds: ["SC-PER-001"] },
    });
    const area = (await app.inject({ method: "POST", url: `/sites/${fx.siteId}/areas`, headers: auth(assessor), payload: { name: "North Yard" } })).json().id;
    photoId = randomUUID();
    await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/photos`, headers: auth(assessor), payload: { id: photoId, capturedAt: nowIso(), contentType: "image/jpeg", byteSize: 10, findingId: fid, areaId: area, assetType: "fence", controlIds: ["SC-PER-001"] } });
    const img = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const up = await app.inject({ method: "PUT", url: `/photos/${photoId}/content`, headers: { ...auth(assessor), "content-type": "image/jpeg" }, payload: img });
    expect(up.statusCode).toBe(200);
  });

  const runExport = async (targets: string[]) => {
    const res = await capture(app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/exports`, headers: auth(assessor), payload: { targets } }));
    expect(res.statusCode, res.body).toBe(202);
    const job = ExportJob.parse(res.json());
    expect(job.status).toBe("queued");
    await app.exportQueue!.idle();
    const done = await capture(app.inject({ url: `/exports/${job.id}`, headers: auth(viewer) }));
    return { job: ExportJob.parse(done.json()), raw: done.json() };
  };

  it("validates targets and needs a role of assessor", async () => {
    expect((await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/exports`, headers: auth(assessor), payload: { targets: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/exports`, headers: auth(assessor), payload: { targets: ["pdf"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/exports`, headers: auth(viewer), payload: { targets: ["docs"] } })).statusCode).toBe(403);
  });

  it("happy path: folder, doc, sheet, and photos are created and URLs recorded", async () => {
    g.calls.length = 0;
    const { job, raw } = await runExport(["docs", "sheets", "drive"]);
    expect(job.status, JSON.stringify(job.results)).toBe("succeeded");
    expect(raw.templateVersion).toBe(TEMPLATE_VERSION);
    const byTarget = Object.fromEntries(job.results.map((r) => [r.target, r.url]));
    expect(byTarget.docs).toMatch(/^https:\/\/docs\.google\.com\/document\/d\/file\d+\/edit$/);
    expect(byTarget.sheets).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/file\d+\/edit$/);
    expect(byTarget.drive).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\/file\d+$/);

    const creates = g.calls.filter((c) => c.method === "POST" && c.url.startsWith("https://www.googleapis.com/drive/v3/files?")).map((c) => JSON.parse(c.body));
    expect(creates.filter((b) => b.mimeType === "application/vnd.google-apps.folder").map((b) => b.name)).toEqual(
      ["Sentinel Assess", "Client Export site", "Site Export site", `Export site (${fx.assessmentId.slice(0, 8)})`, "Photos"],
    );
    expect(creates.some((b) => b.mimeType === "application/vnd.google-apps.document")).toBe(true);
    expect(creates.some((b) => b.mimeType === "application/vnd.google-apps.spreadsheet")).toBe(true);
    const upload = g.calls.find((c) => c.url.includes("/upload/drive/v3/files?uploadType=multipart"))!;
    expect(upload.body).toContain('"name":"north-yard-fence-1.jpg"');
    // Local storage: the Doc image comes from a temporary Drive link that is removed afterwards.
    const docBatch = g.calls.find((c) => c.url.includes("docs.googleapis.com") && c.url.endsWith(":batchUpdate"))!;
    expect(docBatch.body).toContain("insertInlineImage");
    expect(docBatch.body).toContain("https://drive.google.com/uc?export=download");
    expect(docBatch.body).toContain("pending expert review");
    expect(g.calls.filter((c) => c.url.includes("/permissions") && c.method === "POST")).toHaveLength(1);
    expect(g.calls.filter((c) => c.url.includes("/permissions/") && c.method === "DELETE")).toHaveLength(1);
    const values = JSON.parse(g.calls.find((c) => c.url.includes("/values:batchUpdate"))!.body);
    expect(values.valueInputOption).toBe("RAW");
    expect(values.data.map((d: { range: string }) => d.range)).toEqual(["'Findings register'!A1", "'Risk scores'!A1", "'Remediation'!A1"]);
    expect(JSON.stringify(values)).toContain("=IMPORTXML");
    // Tokens only ever travel to Google, in headers or the token endpoint.
    expect(g.calls.filter((c) => c.body.includes(REFRESH)).every((c) => c.url.startsWith("https://oauth2.googleapis.com/"))).toBe(true);

    const list = await capture(app.inject({ url: `/assessments/${fx.assessmentId}/exports`, headers: auth(viewer) }));
    expect(list.json()[0].id).toBe(job.id);
    const audit = await asAppInTenant(acmeId, async (q) => (await q("SELECT action FROM audit_log WHERE entity_id = $1", [job.id])).rows.map((r) => r.action));
    expect(audit.sort()).toEqual(["export.create", "export.finish"]);
  });

  it("retries once on 429 and reuses cached folders", async () => {
    g.calls.length = 0;
    g.failures.push({ frag: "docs.googleapis.com", status: 429 });
    const { job } = await runExport(["docs"]);
    expect(job.status, JSON.stringify(job.results)).toBe("succeeded");
    expect(g.calls.filter((c) => c.url.includes("docs.googleapis.com"))).toHaveLength(2);
    const folders = g.calls.filter((c) => c.url.includes("/drive/v3/files?") && c.body.includes("apps.folder"));
    expect(folders).toHaveLength(0);
  });

  it("a second failure fails only that target, with a safe message", async () => {
    g.failures.push({ frag: "sheets.googleapis.com", status: 503 }, { frag: "sheets.googleapis.com", status: 500 });
    const { job } = await runExport(["sheets"]);
    expect(job.status).toBe("failed");
    expect(job.results[0]).toMatchObject({ target: "sheets", status: "failed", url: null });
    expect(job.results[0]!.error).toBe("Google API 500 UNAVAILABLE");
    expect(g.failures).toHaveLength(0);
  });

  it("no API response ever contained a token", () => {
    for (const body of responses) {
      expect(body).not.toContain(REFRESH);
      expect(body).not.toContain(ACCESS);
    }
  });

  it("disconnect revokes at Google, deletes the token, and audits", async () => {
    g.calls.length = 0;
    expect((await app.inject({ method: "DELETE", url: "/integrations/google", headers: auth(assessor) })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/integrations/google", headers: auth(owner) })).statusCode).toBe(204);
    const revoke = g.calls.find((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke"))!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe(REFRESH);
    expect((await app.inject({ url: "/integrations/google", headers: auth(owner) })).json()).toEqual({ connected: false, email: null, scopes: [], connectedAt: null });
    const res = await app.inject({ method: "POST", url: `/assessments/${fx.assessmentId}/exports`, headers: auth(assessor), payload: { targets: ["docs"] } });
    expect(res.json().error.code).toBe("google_not_connected");
    const audit = await asAppInTenant(acmeId, async (q) => (await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'google.disconnect'")).rows[0].n);
    expect(audit).toBe(1);
  });
});

describe("Docs request builder", () => {
  const doc: ReportDoc = {
    templateVersion: TEMPLATE_VERSION, title: "Report <T>", subtitle: "Client, Site", brandName: "Acme", generatedAt: "2026-11-05T00:00:00.000Z",
    blocks: [
      { type: "heading", level: 1, text: "Findings" },
      { type: "paragraph", text: "Line with\u0007 control char", tone: "notice" },
      { type: "table", header: ["A", "B"], rows: [["1", ""], ["3", "4"]] },
      { type: "bullets", items: ["one", "two"] },
      { type: "image", image: { photoId: "p1", storageKey: "k", caption: "Gate" } },
      { type: "image", image: { photoId: "p2", storageKey: "k", caption: "Missing" } },
    ],
  };

  it("matches the snapshot", () => {
    expect(renderDocsRequests(doc, new Map([["p1", "https://img.example/p1.jpg"]]))).toMatchSnapshot();
  });

  it("emits blocks last to first at index 1 and fills table cells by the documented index formula", () => {
    const reqs = renderDocsRequests(doc, new Map([["p1", "https://img.example/p1.jpg"]]));
    const first = reqs.find((r) => "insertText" in r) as { insertText: { text: string } };
    expect(first.insertText.text).toBe("Photo unavailable: Missing\n"); // last block first
    const last = [...reqs].reverse().find((r) => "insertText" in r) as { insertText: { text: string; location: { index: number } } };
    expect(last.insertText).toEqual({ location: { index: 1 }, text: "Report <T>\n" });
    const cells = reqs.filter((r) => "insertText" in r && (r as { insertText: { location: { index: number } } }).insertText.location.index > 1)
      .map((r) => (r as { insertText: { location: { index: number }; text: string } }).insertText);
    // 3 rows x 2 columns at L = 1: cell (r, c) at 5 + r * 5 + 2c; filled last to first; empty cells skipped.
    expect(cells).toEqual([
      { location: { index: 17 }, text: "4" }, { location: { index: 15 }, text: "3" },
      { location: { index: 10 }, text: "1" },
      { location: { index: 7 }, text: "B" }, { location: { index: 5 }, text: "A" },
    ]);
    expect(JSON.stringify(reqs)).not.toContain("\u0007");
  });
});

describe("photo processing concurrency (QA R2-3)", () => {
  it("never runs more than the configured number of jobs at once", async () => {
    const s = createSemaphore(2);
    let peak = 0;
    const job = () => s.run(async () => {
      peak = Math.max(peak, s.active);
      await new Promise((r) => setTimeout(r, 5));
    });
    await Promise.all(Array.from({ length: 8 }, job));
    expect(peak).toBe(2);
    expect(s.active).toBe(0);
  });
});
