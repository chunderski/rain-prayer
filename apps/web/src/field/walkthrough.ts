/**
 * Walkthrough loading: network first, then the cached copy. The structure is cached per assessment;
 * the records it carries are merged into the field stores without touching records that have
 * queued local changes. Tenant settings and the assessment detail are cached the same way so the
 * walkthrough opens offline after a reload.
 */
import type { ApiClient } from "../api/client";
import { NetworkError } from "../api/client";
import { cachedGet } from "../api/library";
import { AssessmentDetail } from "../api/schemas";
import { getDb, getMeta, notifyLocalChange, setMeta } from "../offline/db";
import { putServerRecords } from "./repo";
import { TenantSettings, WalkthroughResponse, WalkthroughStructure, type TenantSettings as TS } from "./schemas";

export interface LoadedWalkthrough {
  structure: WalkthroughStructure;
  fromCache: boolean;
  cachedAt?: string;
}

export class NotCachedError extends Error {
  constructor() {
    super("This assessment has not been opened on this device yet. Open it once while online to work on it offline.");
  }
}

export async function cacheWalkthrough(w: WalkthroughResponse, siteId: string | undefined): Promise<void> {
  const db = await getDb();
  const structure = WalkthroughStructure.parse(w);
  await db.put("walkthroughs", { assessmentId: w.assessmentId, data: structure, cachedAt: new Date().toISOString() });
  await putServerRecords("areas", w.assessmentId, w.areas.map((a) => ({ ...a, siteId: a.siteId ?? siteId })));
  await putServerRecords("answers", w.assessmentId, w.answers);
  await putServerRecords("assets", w.assessmentId, w.assets);
  await putServerRecords("findings", w.assessmentId, w.findings);
  await putServerRecords("photos", w.assessmentId, w.photos);
  notifyLocalChange();
}

export async function getCachedWalkthrough(assessmentId: string): Promise<LoadedWalkthrough | null> {
  const hit = await (await getDb()).get("walkthroughs", assessmentId);
  if (!hit) return null;
  const parsed = WalkthroughStructure.safeParse(hit.data);
  return parsed.success ? { structure: parsed.data, fromCache: true, cachedAt: hit.cachedAt } : null;
}

export async function loadWalkthrough(api: ApiClient, assessmentId: string, siteId?: string): Promise<LoadedWalkthrough> {
  try {
    const w = await api.get(`/assessments/${encodeURIComponent(assessmentId)}/walkthrough`, WalkthroughResponse);
    await cacheWalkthrough(w, siteId);
    return { structure: WalkthroughStructure.parse(w), fromCache: false };
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    const cached = await getCachedWalkthrough(assessmentId);
    if (!cached) throw new NotCachedError();
    return cached;
  }
}

export const fetchAssessment = (api: ApiClient, id: string) => cachedGet(api, `/assessments/${encodeURIComponent(id)}`, AssessmentDetail);

const DEFAULT_SETTINGS: TS = { allowGps: false, aiPhotoAnalysis: true, aiShareContext: false };

/** Tenant settings, cached for offline use. Defaults to the safe values (no GPS) when never loaded. */
export async function fetchTenantSettings(api: ApiClient): Promise<TS> {
  try {
    const s = await api.get("/tenant/settings", TenantSettings);
    await setMeta("tenantSettings", s);
    return s;
  } catch {
    const cached = TenantSettings.safeParse(await getMeta("tenantSettings"));
    return cached.success ? cached.data : DEFAULT_SETTINGS;
  }
}

// ---------- walkthrough position (resume) and skips ----------

export interface Position {
  areaKey: string;
  sectionId: string;
  controlId: string;
}

export const getPosition = (assessmentId: string) => getMeta<Position>(`position:${assessmentId}`);
export const setPosition = (assessmentId: string, p: Position) => setMeta(`position:${assessmentId}`, p);

export async function getSkipped(assessmentId: string, areaKey: string): Promise<string[]> {
  return (await getMeta<string[]>(`skipped:${assessmentId}:${areaKey}`)) ?? [];
}
export async function setSkipped(assessmentId: string, areaKey: string, ids: string[]): Promise<void> {
  await setMeta(`skipped:${assessmentId}:${areaKey}`, ids);
  notifyLocalChange();
}
