/**
 * Google export jobs: an in-process queue, one job per tenant at a time. Each job is idempotent:
 * every Drive object it creates is recorded in export_job.state as soon as it exists, so a rerun
 * (retry or restart) resumes instead of creating duplicates. HTTP-level retries (once on 429 and
 * 5xx) live in client.ts.
 *
 * Folder layout (drive.file scope, app-created folders cached in google_folder):
 *   Sentinel Assess / <client> / <site> / <assessment title (id prefix)> / { report Doc, Sheet, Photos/ }
 *
 * Docs images: Google fetches insertInlineImage URIs itself, once, at insertion time, so the URI must be
 * reachable from the internet. With STORAGE_DRIVER=s3 the job uses a short-lived presigned URL (the S3
 * public endpoint must be internet reachable). With STORAGE_DRIVER=local the signed /files URL usually is
 * not (localhost), so the job uploads the photo to the Drive Photos folder, adds an "anyone with the
 * link" reader permission, inserts the image from the Drive download URL, and deletes the permission
 * immediately after the batch (seconds of exposure behind an unguessable file id). GOOGLE_DOCS_IMAGE_MODE
 * overrides the choice.
 */
import type { FastifyBaseLogger } from "fastify";
import type { RiskResult } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Db, Tx } from "../db/pool.js";
import { fieldCtx } from "../field/context.js";
import { audit } from "../lib/audit.js";
import type { AuthContext } from "../lib/auth.js";
import { loadReportData, storedPhotos, type StoredPhoto } from "../report/data.js";
import { chunkRequests, renderDocsRequests } from "../report/gdocs.js";
import { buildReportDoc, docImages, type ReportData } from "../report/model.js";
import type { RiskService } from "../risk/service.js";
import type { ObjectStorage } from "../storage/index.js";
import {
  GoogleApiError, MIME, docUrl, driveDownloadUrl, driveFolderUrl, sheetUrl, type GoogleApi, type GoogleClient,
} from "./client.js";
import { openToken } from "./tokens.js";

export type Target = "docs" | "sheets" | "drive";
export interface TargetResult {
  target: Target;
  status: "pending" | "succeeded" | "failed";
  url: string | null;
  error: string | null;
}
interface JobState {
  folderId?: string;
  photosFolderId?: string;
  photos?: Record<string, string>;
  docId?: string;
  docBatches?: number;
  sheetId?: string;
  sheetTabs?: boolean;
}

export interface ExportQueueDeps {
  cfg: Config;
  db: Db;
  storage: ObjectStorage;
  risk: RiskService;
  google: GoogleClient;
  log: FastifyBaseLogger;
}

export const EXPORT_COLS = `id, assessment_id AS "assessmentId", targets, status, results, template_version AS "templateVersion",
  created_at AS "createdAt", finished_at AS "finishedAt"`;

export function exportJobOut(r: Record<string, unknown>) {
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return { ...r, createdAt: iso(r.createdAt), finishedAt: iso(r.finishedAt) };
}

const slug = (s: string | null | undefined, fallback: string) =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;

/** Drive file names `<area>-<asset type>-<n>.jpg`, numbered per prefix in capture order. */
export function photoFileNames(photos: StoredPhoto[]): Map<string, string> {
  const counts = new Map<string, number>();
  const out = new Map<string, string>();
  for (const p of photos) {
    const prefix = `${slug(p.areaName, "site")}-${slug(p.assetType, "general")}`;
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    out.set(p.id, `${prefix}-${n}.jpg`);
  }
  return out;
}

const cellText = (v: unknown) => (v == null ? "" : String(v));

export function sheetTabs(data: ReportData, risk: RiskResult | null, templateVersion: string) {
  const findings = [
    ["Title", "Severity", "Status", "Area", "Controls", "Framework requirements", "Description", "Recommendation"],
    ...data.findings.map((f) => [
      f.title, f.severity, f.status, cellText(f.areaName), f.controlIds.join(", "),
      f.frameworks.map((x) => `${x.frameworkId} ${x.requirementCode}`).join(", "), f.description, cellText(f.recommendation),
    ]),
  ];
  const scores = [
    ["Scenario", "Category", "Likelihood", "Impact", "Inherent score", "Inherent level", "Control effectiveness", "Coverage", "Residual score", "Residual level", "Confidence"],
    ...(risk?.scenarios ?? []).map((s) => [
      s.name, s.category, String(s.inherent.likelihood), String(s.inherent.impact), String(s.inherent.score), s.inherent.level,
      String(s.controlEffectiveness.value), String(s.controlEffectiveness.coverage), String(s.residual.score), s.residual.level, s.confidence,
    ]),
    [],
    ["Method", risk?.methodVersion ?? "unavailable", "Template", templateVersion],
  ];
  const remediation = [
    ["Priority", "Finding", "Severity", "Recommendation", "Controls"],
    ...data.findings.filter((f) => f.status !== "resolved" && f.recommendation).map((f, i) => [String(i + 1), f.title, f.severity, f.recommendation!, f.controlIds.join(", ")]),
  ];
  return [
    { title: "Findings register", values: findings },
    { title: "Risk scores", values: scores },
    { title: "Remediation", values: remediation },
  ];
}

export function createExportQueue(deps: ExportQueueDeps) {
  const { cfg, db, storage, risk, google, log } = deps;
  const chains = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();
  const recovered = new Set<string>();
  const startedAt = new Date();

  const update = (tenantId: string, jobId: string, sql: string, params: unknown[]) =>
    db.withTenant(tenantId, (tx) => tx.query(`UPDATE export_job SET ${sql} WHERE id = $1`, [jobId, ...params]));

  async function withFolder(tx: Tx, tenantId: string, api: GoogleApi, segments: string[]): Promise<string> {
    let parent: string | null = null;
    for (let i = 1; i <= segments.length; i++) {
      const path = JSON.stringify(segments.slice(0, i));
      const hit = await tx.query<{ folder_id: string }>("SELECT folder_id FROM google_folder WHERE path = $1", [path]);
      if (hit.rows[0]) {
        parent = hit.rows[0].folder_id;
        continue;
      }
      const id: string = await api.createFile(segments[i - 1]!.slice(0, 200), MIME.folder, parent);
      await tx.query("INSERT INTO google_folder (tenant_id, path, folder_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [tenantId, path, id]);
      parent = id;
    }
    return parent!;
  }

  async function run(tenantId: string, jobId: string): Promise<void> {
    const claimed = await db.withTenant(tenantId, (tx) =>
      tx.query<{ assessment_id: string; targets: Target[]; state: JobState; created_by: string; template_version: string }>(
        `UPDATE export_job SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, now())
          WHERE id = $1 AND status IN ('queued', 'running') RETURNING assessment_id, targets, state, created_by, template_version`,
        [jobId],
      ),
    );
    const job = claimed.rows[0];
    if (!job) return;
    const state: JobState = job.state ?? {};
    const results = new Map<Target, TargetResult>(job.targets.map((t) => [t, { target: t, status: "pending", url: null, error: null }]));
    const save = () => update(tenantId, jobId, "state = $2, results = $3", [JSON.stringify(state), JSON.stringify([...results.values()])]);
    const auth: AuthContext = {
      userId: job.created_by, tenantId, role: "viewer",
      user: { id: job.created_by, email: "", name: "" }, tenant: { id: tenantId, slug: "", name: "" },
    } as AuthContext;
    const safeError = (err: unknown) => {
      if (err instanceof GoogleApiError) {
        if (err.reason === "invalid_grant") return "Google access was revoked or expired; reconnect Google in settings";
        return err.message;
      }
      log.error({ err, jobId }, "export step failed");
      return "Export step failed; see server logs";
    };

    let api: GoogleApi;
    let data: ReportData;
    let photos: StoredPhoto[];
    let segments: string[];
    try {
      const conn = await db.withTenant(tenantId, (tx) =>
        tx.query<{ refresh_token: Buffer; iv: Buffer; tag: Buffer }>("SELECT refresh_token, iv, tag FROM google_connection"),
      );
      const c = conn.rows[0];
      if (!c) throw new GoogleApiError(409, "google_not_connected", "Google is not connected for this workspace");
      const refreshToken = openToken(cfg.googleExport!.tokenKey, tenantId, { ciphertext: c.refresh_token, iv: c.iv, tag: c.tag });
      api = google.api(await google.refresh(refreshToken));
      ({ data, photos } = await db.withTenant(tenantId, async (tx) => {
        const ctx = fieldCtx(tx, auth);
        return { data: await loadReportData(ctx, job.assessment_id, risk), photos: await storedPhotos(ctx, job.assessment_id) };
      }));
      const a = data.assessment;
      segments = ["Sentinel Assess", a.clientName, a.siteName, `${a.title} (${a.id.slice(0, 8)})`];
      if (!state.folderId) {
        state.folderId = await db.withTenant(tenantId, (tx) => withFolder(tx, tenantId, api, segments));
        await save();
      }
    } catch (err) {
      const msg = safeError(err);
      for (const r of results.values()) Object.assign(r, { status: "failed", error: msg });
      return finish(tenantId, jobId, results, state);
    }

    const names = photoFileNames(photos);
    const ensurePhoto = async (p: StoredPhoto): Promise<string> => {
      state.photos ??= {};
      if (state.photos[p.id]) return state.photos[p.id]!;
      if (!state.photosFolderId) {
        state.photosFolderId = await db.withTenant(tenantId, (tx) => withFolder(tx, tenantId, api, [...segments, "Photos"]));
        await save();
      }
      const bytes = await storage.get(p.storageKey);
      state.photos[p.id] = await api.upload(names.get(p.id)!, "image/jpeg", bytes, state.photosFolderId);
      await save();
      return state.photos[p.id]!;
    };

    const steps: Record<Target, () => Promise<string>> = {
      drive: async () => {
        for (const p of photos) await ensurePhoto(p);
        if (!state.photosFolderId) {
          state.photosFolderId = await db.withTenant(tenantId, (tx) => withFolder(tx, tenantId, api, [...segments, "Photos"]));
          await save();
        }
        return driveFolderUrl(state.photosFolderId);
      },
      docs: async () => {
        const doc = buildReportDoc(data, "export");
        if (!state.docId) {
          state.docId = await api.createDocument(`${data.assessment.title} report`, state.folderId!);
          state.docBatches = 0;
          await save();
        }
        const mode = cfg.GOOGLE_DOCS_IMAGE_MODE === "auto" ? (storage.driver === "s3" ? "signed_url" : "drive_temporary_link") : cfg.GOOGLE_DOCS_IMAGE_MODE;
        const uris = new Map<string, string>();
        const grants: { fileId: string; permissionId: string }[] = [];
        const byId = new Map(photos.map((p) => [p.id, p]));
        try {
          for (const img of docImages(doc)) {
            if (uris.has(img.photoId)) continue;
            if (mode === "signed_url") {
              uris.set(img.photoId, (await storage.signedUrl(img.storageKey, cfg.SIGNED_URL_TTL_SECONDS)).url);
            } else {
              const p = byId.get(img.photoId);
              if (!p) continue;
              const fileId = await ensurePhoto(p);
              grants.push({ fileId, permissionId: await api.addAnyoneReader(fileId) });
              uris.set(img.photoId, driveDownloadUrl(fileId));
            }
          }
          const batches = chunkRequests(renderDocsRequests(doc, uris));
          for (let i = state.docBatches ?? 0; i < batches.length; i++) {
            await api.docsBatchUpdate(state.docId, batches[i]!);
            state.docBatches = i + 1;
            await save();
          }
        } finally {
          for (const g of grants) {
            await api.deletePermission(g.fileId, g.permissionId).catch((err) => log.warn({ err: (err as Error).message, jobId }, "could not remove temporary Drive link"));
          }
        }
        return docUrl(state.docId);
      },
      sheets: async () => {
        if (!state.sheetId) {
          state.sheetId = await api.createSpreadsheet(`${data.assessment.title} register`, state.folderId!);
          await save();
        }
        const tabs = sheetTabs(data, data.risk, job.template_version);
        if (!state.sheetTabs) {
          await api.sheetsBatchUpdate(state.sheetId, [...tabs.map((t) => ({ addSheet: { properties: { title: t.title } } })), { deleteSheet: { sheetId: 0 } }]);
          state.sheetTabs = true;
          await save();
        }
        await api.valuesBatchUpdate(state.sheetId, tabs.map((t) => ({ range: `'${t.title}'!A1`, values: t.values })));
        return sheetUrl(state.sheetId);
      },
    };

    // Drive first: in drive_temporary_link mode the Doc reuses the uploaded photos.
    for (const t of (["drive", "docs", "sheets"] as const).filter((x) => results.has(x))) {
      const r = results.get(t)!;
      if (r.status === "succeeded") continue;
      try {
        Object.assign(r, { status: "succeeded", url: await steps[t](), error: null });
      } catch (err) {
        Object.assign(r, { status: "failed", url: null, error: safeError(err) });
      }
      await save();
    }
    return finish(tenantId, jobId, results, state);
  }

  async function finish(tenantId: string, jobId: string, results: Map<Target, TargetResult>, state: JobState) {
    const ok = [...results.values()].every((r) => r.status === "succeeded");
    await db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query<{ created_by: string; assessment_id: string }>(
        `UPDATE export_job SET status = $2, results = $3, state = $4, finished_at = now() WHERE id = $1 RETURNING created_by, assessment_id`,
        [jobId, ok ? "succeeded" : "failed", JSON.stringify([...results.values()]), JSON.stringify(state)],
      );
      await audit(tx, {
        tenantId, actorUserId: rows[0]?.created_by ?? null, action: "export.finish", entityType: "export_job", entityId: jobId,
        details: { assessmentId: rows[0]?.assessment_id, status: ok ? "succeeded" : "failed", results: [...results.values()].map((r) => ({ target: r.target, status: r.status })) },
      });
    });
  }

  function enqueue(tenantId: string, jobId: string) {
    const prev = chains.get(tenantId) ?? Promise.resolve();
    const next = prev
      .then(() => run(tenantId, jobId))
      .catch((err) => {
        log.error({ err, jobId }, "export job crashed");
        return update(tenantId, jobId, "status = 'failed', finished_at = now()", []).then(() => undefined, () => undefined);
      });
    chains.set(tenantId, next);
    running.add(next);
    void next.finally(() => {
      running.delete(next);
      if (chains.get(tenantId) === next) chains.delete(tenantId);
    });
  }

  return {
    /** Queues a job; the first call per tenant also requeues jobs left unfinished by an earlier process. */
    async add(tenantId: string, jobId: string) {
      if (!recovered.has(tenantId)) {
        recovered.add(tenantId);
        const stale = await db.withTenant(tenantId, (tx) =>
          tx.query<{ id: string }>("SELECT id FROM export_job WHERE status IN ('queued', 'running') AND created_at < $1 ORDER BY created_at", [startedAt]),
        );
        for (const r of stale.rows) enqueue(tenantId, r.id);
      }
      enqueue(tenantId, jobId);
    },
    /** Resolves when every queued job has finished (tests and graceful shutdown). */
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}

export type ExportQueue = ReturnType<typeof createExportQueue>;
