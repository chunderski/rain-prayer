/**
 * Phase 3 additions to the mocked API (docs/api-phase3.md): risk scenarios, inputs, results,
 * comparison, dashboard, narrative, report preview, Google export jobs and integration, and the
 * assessment lock (sync answers `rejected` with `assessment_locked` while complete).
 */
import { randomUUID } from "node:crypto";
import type { Request, Route } from "@playwright/test";
import { ASSESSMENT_ID, SEEDED_ASSESSMENT } from "./mock-field";

export const SECOND_ID = "e0000000-0000-4000-8000-000000000098";
export const SECOND_ASSESSMENT = { ...SEEDED_ASSESSMENT, id: SECOND_ID, title: "Head office review", siteId: "d0000000-0000-4000-8000-000000000002", siteName: "Head office", status: "complete" };
export const FINDING_ID = "f1000000-0000-4000-8000-000000000001";

export const SCENARIOS = [
  { id: "forced-entry", name: "Forced entry after hours", description: "An intruder forces a door or window when the site is closed.", category: "physical", mitigations: [{ controlId: "SC-PER-001", weight: 3 }, { controlId: "SC-LGT-001", weight: 2 }], domains: ["PER", "LGT"], references: [] },
  { id: "tailgating", name: "Tailgating into staff areas", description: "Someone follows an authorized person through a controlled door.", category: "physical", mitigations: [{ controlId: "SC-ENV-001", weight: 1 }], domains: ["ENV"], references: [] },
  { id: "ransomware", name: "Ransomware on site systems", description: "Malware encrypts systems that run the site and its cameras.", category: "cyber", mitigations: [{ controlId: "SC-GOV-001", weight: 2 }], domains: ["GOV"], references: [] },
];

const BANDS: [number, string][] = [[4, "very_low"], [7, "low"], [13, "medium"], [20, "high"], [Infinity, "very_high"]];
const levelFor = (n: number) => BANDS.find(([b]) => n < b)![1];
const LABEL: Record<string, string> = { very_low: "very low", low: "low", medium: "medium", high: "high", very_high: "very high" };

export interface Phase3Options {
  googleConfigured?: boolean;
  googleConnected?: boolean;
  aiConfigured?: boolean;
}

type Input = { scenarioId: string; likelihood: number | null; impact: number | null; rationale?: string | null; excluded: boolean };

export function createPhase3Mock(opts: Phase3Options = {}) {
  const state = {
    status: SEEDED_ASSESSMENT.status as string,
    inputs: SCENARIOS.map((s) => ({ scenarioId: s.id, likelihood: null, impact: null, rationale: null, excluded: false })) as Input[],
    puts: [] as unknown[],
    reopenReasons: [] as string[],
    patches: [] as unknown[],
    narratives: new Map<string, Record<string, unknown>>(),
    previews: [] as string[],
    exports: [] as { body: unknown }[],
    polls: 0,
    lockedRejections: 0,
    googleConnected: opts.googleConnected ?? false,
  };

  function result() {
    const scored = state.inputs.filter((i) => !i.excluded && i.likelihood && i.impact);
    const scenarios = scored.map((i) => {
      const s = SCENARIOS.find((x) => x.id === i.scenarioId)!;
      const inherent = i.likelihood! * i.impact!;
      const residual = Math.round(inherent * 0.6 * 10) / 10;
      return {
        scenarioId: s.id,
        name: s.name,
        category: s.category,
        inherent: { likelihood: i.likelihood, impact: i.impact, score: inherent, level: levelFor(inherent) },
        controlEffectiveness: {
          value: 0.5,
          coverage: 0.5,
          contributors: [{ controlId: s.mitigations[0]!.controlId, title: "Perimeter fence is intact", weight: s.mitigations[0]!.weight, effectiveness: 0.5, evidence: "1 of 2 questions answered Yes; 1 high finding open.", findingIds: [FINDING_ID] }],
        },
        residual: { score: residual, level: levelFor(residual) },
        confidence: "medium",
        explanation: [
          `Inherent risk is ${inherent} of 25 (${LABEL[levelFor(inherent)]}): likelihood ${i.likelihood} times impact ${i.impact}.`,
          "Controls for this scenario are 50% effective, based on half of the weighted controls.",
          `Residual risk is ${residual} (${LABEL[levelFor(residual)]}).`,
        ],
      };
    });
    const worst = scenarios.reduce((m, s) => Math.max(m, s.residual.score), 0);
    return {
      methodVersion: "risk-method@1.0.0",
      assessmentId: ASSESSMENT_ID,
      computedAt: "2026-11-05T10:00:00Z",
      scenarios,
      overall: scenarios.length
        ? { inherent: Math.max(...scenarios.map((s) => s.inherent.score)), residual: worst, level: levelFor(worst), explanation: [`Overall residual risk is ${LABEL[levelFor(worst)]}, set by the highest scenario.`] }
        : { inherent: 0, residual: 0, level: "very_low", explanation: ["No scenario has likelihood and impact yet."] },
      missingInputs: state.inputs.filter((i) => !i.excluded && !(i.likelihood && i.impact)).map((i) => i.scenarioId),
    };
  }

  function preview() {
    const shown = [...state.narratives.values()].filter((n) => n.status !== "ai_draft");
    return `<!doctype html><html><head><title>Report</title></head><body><h1>Warehouse night survey</h1>${shown.map((n) => `<h2>${n.section}</h2><p>${n.text}</p>`).join("")}<h2>Risk summary</h2><table><tr><th>Scenario</th><th>Residual</th></tr></table></body></html>`;
  }

  type Reply = (status: number, body?: unknown) => Promise<void>;
  const done = (p: Promise<void>) => p.then(() => true);

  async function handle(route: Route, req: Request, url: URL, reply: Reply, cors: Record<string, string>): Promise<boolean> {
    const p = url.pathname;
    const m = req.method();
    const A = `/assessments/${ASSESSMENT_ID}`;
    const err = (s: number, code: string, message: string) => done(reply(s, { error: { code, message } }));
    if (p === A && m === "GET") return done(reply(200, { ...SEEDED_ASSESSMENT, status: state.status }));
    if (p === A && m === "PATCH") {
      state.patches.push(req.postDataJSON());
      const next = (req.postDataJSON() as { status: string }).status;
      // Same rule as the real API: status moves one step at a time.
      const NEXT: Record<string, string> = { draft: "in_progress", in_progress: "in_review", in_review: "complete" };
      if (NEXT[state.status] !== next) return err(409, "invalid_transition", `Status can move from ${state.status} only to ${NEXT[state.status] ?? "nothing"}`);
      state.status = next;
      return done(reply(200, { ...SEEDED_ASSESSMENT, status: state.status }));
    }
    if (p === `${A}/reopen` && m === "POST") {
      state.reopenReasons.push((req.postDataJSON() as { reason: string }).reason);
      state.status = "in_review";
      return done(reply(200, { ...SEEDED_ASSESSMENT, status: state.status }));
    }
    if (p === "/sync/push" && state.status === "complete") {
      const body = req.postDataJSON() as { ops: { opId: string }[] };
      state.lockedRejections += body.ops.length;
      return done(reply(200, { results: body.ops.map((o) => ({ opId: o.opId, status: "rejected", version: null, error: { code: "assessment_locked", message: "Assessment is complete" } })) }));
    }
    if (p === "/risk/scenarios") return done(reply(200, SCENARIOS));
    if (p === `${A}/risk/inputs` && m === "GET") return done(reply(200, { scenarios: state.inputs }));
    if (p === `${A}/risk/inputs` && m === "PUT") {
      if (state.status === "complete") return err(409, "assessment_locked", "Assessment is complete");
      const body = req.postDataJSON() as { scenarios: Input[] };
      state.puts.push(body);
      for (const s of body.scenarios) {
        const i = state.inputs.find((x) => x.scenarioId === s.scenarioId)!;
        Object.assign(i, s);
      }
      return done(reply(200, { scenarios: state.inputs }));
    }
    if (p === `${A}/risk`) return done(reply(200, result()));
    if (p === "/risk/compare") {
      const r = result();
      const byScenario = Object.fromEntries(r.scenarios.map((s) => [s.scenarioId, { inherent: s.inherent.score, residual: s.residual.score, level: s.residual.level }]));
      return done(
        reply(200, {
          methodVersion: "risk-method@1.0.0",
          sites: [
            { assessmentId: ASSESSMENT_ID, siteName: "Main warehouse", clientName: "Northwind Logistics", completedAt: null, overall: r.overall, byScenario, findingsBySeverity: { critical: 0, high: 2, medium: 1, low: 0, info: 0 } },
            {
              assessmentId: SECOND_ID,
              siteName: "Head office",
              clientName: "Northwind Logistics",
              completedAt: "2026-11-03T12:00:00Z",
              overall: { inherent: 16, residual: 9, level: "medium", explanation: [] },
              byScenario: { "forced-entry": { inherent: 16, residual: 9, level: "medium" }, ransomware: { inherent: 20, residual: 16, level: "high" } },
              findingsBySeverity: { critical: 1, high: 0, medium: 3, low: 2, info: 0 },
            },
          ],
          caveats: ["Main warehouse is still open, so its scores are live and may change.", "The sites use different frameworks: Head office was not assessed for CPTED."],
        }),
      );
    }
    if (p === "/dashboard")
      return done(
        reply(200, {
          assessmentsByStatus: { draft: 1, in_progress: 3, in_review: 1, complete: 4 },
          findingsBySeverity: { critical: 1, high: 5, medium: 8, low: 3, info: 2 },
          openHighFindings: 6,
          topResidual: [
            { assessmentId: ASSESSMENT_ID, siteName: "Main warehouse", scenarioName: "Forced entry after hours", level: "high", residual: 16 },
            { assessmentId: SECOND_ID, siteName: "Head office", scenarioName: "Ransomware on site systems", level: "medium", residual: 9.6 },
          ],
          recent: [],
        }),
      );
    if (p === `${A}/narrative` && m === "GET") return done(reply(200, [...state.narratives.values()]));
    if (p === `${A}/narrative/draft` && m === "POST") {
      if (opts.aiConfigured === false) return err(503, "ai_not_configured", "AI is not configured");
      const { section } = req.postDataJSON() as { section: string };
      const n = { assessmentId: ASSESSMENT_ID, section, text: "AI DRAFT: The warehouse perimeter has gaps and the dock lighting is out.", status: "ai_draft", model: "claude-test", updatedAt: new Date().toISOString(), approvedBy: null };
      state.narratives.set(section, n);
      return done(reply(201, n));
    }
    const nar = p.match(new RegExp(`^${A}/narrative/([a-z_]+)$`));
    if (nar && m === "PUT") {
      const body = req.postDataJSON() as { text: string; approve?: boolean };
      const n = { assessmentId: ASSESSMENT_ID, section: nar[1], text: body.text, status: body.approve ? "approved" : "edited", model: null, updatedAt: new Date().toISOString(), approvedBy: body.approve ? "b0000000-0000-4000-8000-000000000001" : null };
      state.narratives.set(nar[1]!, n);
      return done(reply(200, n));
    }
    if (p === `${A}/report/preview`) {
      const html = preview();
      state.previews.push(html);
      return done(route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" }, body: html }));
    }
    if (p === `${A}/exports` && m === "GET") return done(reply(200, []));
    if (p === `${A}/exports` && m === "POST") {
      if (opts.googleConfigured === false) return err(503, "google_not_configured", "Google is not configured");
      const body = req.postDataJSON() as { targets: string[] };
      state.exports.push({ body });
      const job = { id: randomUUID(), assessmentId: ASSESSMENT_ID, targets: body.targets, status: "queued", results: body.targets.map((t) => ({ target: t, status: "pending", url: null, error: null })), createdAt: new Date().toISOString(), finishedAt: null };
      jobs.set(job.id, job);
      return done(reply(202, job));
    }
    const ex = p.match(/^\/exports\/([^/]+)$/);
    if (ex) {
      const job = jobs.get(ex[1]!)!;
      state.polls++;
      const n = (pollsOf.get(job.id as string) ?? 0) + 1;
      pollsOf.set(job.id as string, n);
      const status = n === 1 ? "running" : "succeeded";
      const links: Record<string, string> = { docs: "https://docs.google.com/document/d/mock-doc", sheets: "https://docs.google.com/spreadsheets/d/mock-sheet", drive: "https://drive.google.com/drive/folders/mock-folder" };
      const out = {
        ...job,
        status,
        results: (job.targets as string[]).map((t) => (status === "succeeded" ? { target: t, status: "succeeded", url: links[t], error: null } : { target: t, status: "pending", url: null, error: null })),
        finishedAt: status === "succeeded" ? new Date().toISOString() : null,
      };
      return done(reply(200, out));
    }
    if (p === "/integrations/google" && m === "GET") {
      if (opts.googleConfigured === false) return err(503, "google_not_configured", "Google is not configured");
      return done(reply(200, state.googleConnected ? { connected: true, email: "ops@acme.test", scopes: ["https://www.googleapis.com/auth/drive.file"], connectedAt: "2026-11-01T00:00:00Z" } : { connected: false, email: null, scopes: [], connectedAt: null }));
    }
    if (p === "/integrations/google" && m === "DELETE") {
      state.googleConnected = false;
      return done(reply(204));
    }
    return false;
  }
  const jobs = new Map<string, Record<string, unknown>>();
  const pollsOf = new Map<string, number>();
  return { state, handle, result };
}
