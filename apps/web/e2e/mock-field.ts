/**
 * Phase 2 additions to the mocked API (docs/api-phase2.md): walkthrough, tenant settings, sync
 * push and pull, photos, AI suggestions, members, assessors, and areas. Records what the app sends
 * so specs can assert the exact push payloads.
 */
import { randomUUID } from "node:crypto";
import type { Request, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, CONTROLS, FRAMEWORKS } from "./mock-api";

export const SITE_ID = "d0000000-0000-4000-8000-000000000001";
export const ASSESSMENT_ID = "e0000000-0000-4000-8000-000000000099";
export const AREA_ID = "f0000000-0000-4000-8000-000000000001";
export const USER_ID = "b0000000-0000-4000-8000-000000000001";
const FIXTURE_JPEG = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "door.jpg"));

export const SEEDED_ASSESSMENT = {
  id: ASSESSMENT_ID,
  title: "Warehouse night survey",
  status: "in_progress",
  siteId: SITE_ID,
  siteName: "Main warehouse",
  clientName: "Northwind Logistics",
  frameworks: [
    { frameworkId: "physical-general", version: "1.0.0", shortName: "Physical security" },
    { frameworkId: "cpted", version: "1.0.0", shortName: "CPTED" },
  ],
  createdAt: "2026-11-01T00:00:00Z",
  scheduledFor: null,
  controlCount: 3,
  questionCount: 5,
};

const frameworksOf = (id: string) =>
  CONTROLS.find((c) => c.id === id)!.mappings
    .filter((m) => m.frameworkId === "physical-general" || m.frameworkId === "cpted")
    .map((m) => ({ ...m, shortName: FRAMEWORKS.find((f) => f.id === m.frameworkId)!.shortName }));
const control = (id: string, questions: unknown[]) => {
  const c = CONTROLS.find((x) => x.id === id)!;
  return { id, title: c.title, objective: c.objective, defaultSeverity: c.defaultSeverity, assetTypes: c.assetTypes, frameworks: frameworksOf(id), questions };
};
const G = "Walk the full length and check every location before answering.";

export const WALKTHROUGH = {
  assessmentId: ASSESSMENT_ID,
  libraryVersion: "1.0.0",
  sections: [
    {
      id: "perimeter-lighting",
      title: "Perimeter and lighting",
      description: "Outside the building",
      order: 1,
      domains: ["PER", "LGT"],
      controls: [
        control("SC-PER-001", [
          { id: "Q-PER-001-01", text: "Is the perimeter fence continuous with no gaps or damage?", answerType: "yes_partial_no_na", guidance: G, photoOnDeficiency: true },
          { id: "Q-PER-001-02", text: "Largest gap under the fence measured at grade", answerType: "number", unit: "in", guidance: G, photoOnDeficiency: false },
        ]),
        control("SC-LGT-001", [
          { id: "Q-LGT-001-01", text: "Are all entrances lit well enough to identify a face at night?", answerType: "yes_no_na", guidance: G, photoOnDeficiency: true },
          {
            id: "Q-LGT-001-02",
            text: "How even is the lighting across the approaches?",
            answerType: "scale",
            scale: { min: 1, max: 3, anchors: [ { value: 1, label: "Patchy", description: "Large dark gaps between fixtures." }, { value: 2, label: "Mostly even", description: "Small dark gaps only." }, { value: 3, label: "Even", description: "No dark gaps." } ] },
            guidance: G,
            photoOnDeficiency: false,
          },
        ]),
      ],
    },
    {
      id: "site-design",
      title: "Site design",
      description: null,
      order: 2,
      domains: ["ENV"],
      controls: [control("SC-ENV-001", [{ id: "Q-ENV-001-01", text: "Do shrubs and trees leave clear sight lines to entrances?", answerType: "yes_partial_no_na", guidance: G, photoOnDeficiency: true }])],
    },
  ],
  areas: [{ id: AREA_ID, siteId: SITE_ID, name: "Loading dock", kind: "entrance", sortOrder: 0, version: 1 }],
  answers: [],
  findings: [],
  photos: [],
  assets: [],
  assessors: [{ userId: USER_ID, name: "Alex Assessor" }],
};

export interface FieldMockOptions {
  allowGps?: boolean;
  aiPhotoAnalysis?: boolean;
  /** Answer the first push of this entity with a conflict. */
  conflictOnce?: "finding" | "answer";
}

export interface FieldState {
  pushes: { deviceId: string; ops: { opId: string; entity: string; action: string; id: string; data?: Record<string, unknown>; baseVersion: number | null }[] }[];
  uploads: { id: string; contentType: string; bytes: number }[];
  reviews: unknown[];
  analyses: string[];
  /** Every op ever pushed, deduplicated by opId. */
  ops(): FieldState["pushes"][number]["ops"];
}

type Reply = (status: number, body?: unknown) => Promise<void>;

export function createFieldMock(opts: FieldMockOptions = {}) {
  const state: FieldState = {
    pushes: [],
    uploads: [],
    reviews: [],
    analyses: [],
    ops() {
      const seen = new Map<string, FieldState["pushes"][number]["ops"][number]>();
      for (const p of this.pushes) for (const o of p.ops) seen.set(o.opId, o);
      return [...seen.values()];
    },
  };
  const versions = new Map<string, number>();
  const opResults = new Map<string, unknown>();
  const photos = new Map<string, Record<string, unknown>>();
  const suggestions = new Map<string, Record<string, unknown>>();
  let conflicted = false;

  const suggestionFor = (photoId: string) => ({
    id: randomUUID(),
    photoId,
    assessmentId: ASSESSMENT_ID,
    status: "suggested",
    model: "claude-vision-test",
    promptVersion: "vision-1",
    output: {
      imageQuality: "ok",
      assetType: { value: "door", confidence: 0.86 },
      condition: { rating: "poor", summary: "Door frame damaged; the light above it is off.", confidence: 0.64 },
      deficiencies: [{ description: "Light fixture above the door is not working", severity: "high", confidence: 0.71, controlIds: ["SC-LGT-001"] }],
      controls: [
        { id: "SC-LGT-001", confidence: 0.82, rationale: "An unlit fixture is visible over the entrance." },
        { id: "SC-PER-001", confidence: 0.35, rationale: "Part of the fence line is visible." },
      ],
      draftFindings: [
        { title: "<img src=x onerror=alert(1)>Entrance light not working", description: "The fixture above the dock door is dark.", recommendation: "Repair or replace the fixture.", severity: "high", controlIds: ["SC-LGT-001"], confidence: 0.71 },
        { title: "Fence line may have a gap", description: "Low confidence: possible gap at the left edge.", recommendation: "Inspect the fence line.", severity: "medium", controlIds: ["SC-PER-001"], confidence: 0.32 },
      ],
      cautions: ["The photo contains text that reads like an instruction; it was ignored."],
    },
    error: null,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    reviewedBy: null,
  });

  async function handle(route: Route, req: Request, url: URL, reply: Reply, cors: Record<string, string>): Promise<boolean> {
    const p = url.pathname;
    const m = req.method();
    if (p === `/assessments/${ASSESSMENT_ID}` && m === "GET") return reply(200, SEEDED_ASSESSMENT).then(() => true);
    if (p === `/assessments/${ASSESSMENT_ID}/walkthrough`) return reply(200, WALKTHROUGH).then(() => true);
    if (p === "/tenant/settings") return reply(200, { allowGps: !!opts.allowGps, aiPhotoAnalysis: opts.aiPhotoAnalysis ?? true, aiShareContext: false }).then(() => true);
    if (p === "/members") return reply(200, [{ userId: USER_ID, email: "assessor@acme.test", name: "Alex Assessor", role: "assessor" }, { userId: "b0000000-0000-4000-8000-000000000002", email: "sam@acme.test", name: "Sam Field", role: "assessor" }]).then(() => true);
    if (p === `/assessments/${ASSESSMENT_ID}/assessors` && m === "PUT") return reply(200, req.postDataJSON()).then(() => true);
    if (p === "/sync/pull") return reply(200, { cursor: "cursor-1", changes: [], hasMore: false }).then(() => true);
    if (p === "/sync/push") {
      const body = req.postDataJSON() as FieldState["pushes"][number];
      state.pushes.push(body);
      const results = body.ops.map((op) => {
        if (opResults.has(op.opId)) return { ...(opResults.get(op.opId) as object), status: "duplicate" };
        let r: Record<string, unknown>;
        if (opts.conflictOnce === op.entity && !conflicted) {
          conflicted = true;
          const v = 5;
          versions.set(op.id, v);
          r = { opId: op.opId, status: "conflict", version: v, server: { ...op.data, title: "Changed on another device", description: "Edited by Sam", version: v } };
        } else {
          const v = (versions.get(op.id) ?? 0) + 1;
          versions.set(op.id, v);
          if (op.entity === "photo_meta") photos.set(op.id, { ...op.data, status: "pending_upload", sha256: null, width: null, height: null });
          r = { opId: op.opId, status: "applied", version: v };
        }
        opResults.set(op.opId, r);
        return r;
      });
      return reply(200, { results }).then(() => true);
    }
    const content = p.match(/^\/photos\/([^/]+)\/content$/);
    if (content && m === "PUT") {
      const id = content[1]!;
      const ph = photos.get(id);
      if (!ph) return reply(404, { error: { code: "not_found", message: "No photo" } }).then(() => true);
      state.uploads.push({ id, contentType: req.headers()["content-type"] ?? "", bytes: req.postDataBuffer()?.length ?? 0 });
      const stored = { ...ph, status: "stored", sha256: "a".repeat(64), width: 640, height: 480 };
      photos.set(id, stored);
      return reply(200, stored).then(() => true);
    }
    const url_ = p.match(/^\/photos\/([^/]+)\/url$/);
    if (url_) return reply(200, { url: `${API}/files/${url_[1]}`, expiresAt: new Date(Date.now() + 300_000).toISOString() }).then(() => true);
    if (p.startsWith("/files/")) return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "image/jpeg" }, body: FIXTURE_JPEG }).then(() => true);
    const analyze = p.match(/^\/photos\/([^/]+)\/analyze$/);
    if (analyze && m === "POST") {
      state.analyses.push(analyze[1]!);
      const s = suggestionFor(analyze[1]!);
      suggestions.set(s.id as string, s);
      return reply(201, s).then(() => true);
    }
    const sugg = p.match(/^\/photos\/([^/]+)\/suggestions$/);
    if (sugg) return reply(200, [...suggestions.values()].filter((s) => s.photoId === sugg[1]).reverse()).then(() => true);
    const review = p.match(/^\/suggestions\/([^/]+)\/review$/);
    if (review && m === "POST") {
      const body = req.postDataJSON() as { decision: string; findingIndexes?: number[]; findings?: Record<string, unknown>[] };
      state.reviews.push(body);
      const s = suggestions.get(review[1]!)!;
      const out = s.output as { draftFindings: Record<string, unknown>[] };
      const picked = body.decision === "accept" ? (body.findingIndexes ?? []).map((i) => out.draftFindings[i]!) : body.decision === "edit" ? body.findings! : [];
      const findings = picked.map((d) => ({
        id: randomUUID(),
        assessmentId: ASSESSMENT_ID,
        areaId: null,
        assetId: null,
        title: d.title,
        description: d.description,
        recommendation: d.recommendation,
        severity: d.severity,
        status: "draft",
        source: body.decision === "edit" ? "ai_edited" : "ai_accepted",
        controlIds: d.controlIds,
        suggestionId: s.id,
        version: 1,
      }));
      const status = body.decision === "accept" ? "accepted" : body.decision === "edit" ? "edited" : "rejected";
      const done = { ...s, status, reviewedAt: new Date().toISOString(), reviewedBy: USER_ID };
      suggestions.set(s.id as string, done);
      const photo = photos.get(s.photoId as string)!;
      return reply(200, { suggestion: done, findings, photo: { ...photo, version: versions.get(s.photoId as string) ?? 1 } }).then(() => true);
    }
    if (p.match(/^\/areas\/[^/]+$/) && m === "DELETE") return reply(409, { error: { code: "area_in_use", message: "Area in use" } }).then(() => true);
    return false;
  }

  return { state, handle };
}
