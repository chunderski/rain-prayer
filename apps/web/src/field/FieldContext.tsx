/**
 * Loads one assessment for every screen under /assessments/:id: the assessment detail and the
 * walkthrough (network first, cached copy offline), then serves records from IndexedDB, reloading
 * whenever local data changes. Screens never wait on the network to render cached work.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Outlet, useLocation, useParams } from "react-router-dom";
import type { Answer, Area, Asset, Finding, PhotoMeta } from "@sentinel/shared";
import { useApi, useWriteCtx } from "../auth/AuthContext";
import type { AssessmentDetail } from "../api/schemas";
import { useOnline } from "../offline/useOnline";
import { useLocal } from "../lib/useLocal";
import { errorMessage } from "../lib/useAsync";
import type { LocalPhoto, LocalRecord } from "../offline/db";
import { Banner, Loading } from "../components/ui";
import { listAreas, listRecords, type WriteCtx } from "./repo";
import { fetchAssessment, fetchTenantSettings, loadWalkthrough } from "./walkthrough";
import { LockedNotice, LockRejections } from "./Lock";
import type { TenantSettings, WalkthroughControl, WalkthroughSection, WalkthroughStructure } from "./schemas";

export interface FieldData {
  assessmentId: string;
  assessment: AssessmentDetail;
  structure: WalkthroughStructure;
  fromCache: boolean;
  /** Set when the walkthrough could not be loaded and no copy is cached; detail screens still work. */
  walkthroughError: string | null;
  settings: TenantSettings;
  controls: Map<string, WalkthroughControl>;
  sectionOf: Map<string, WalkthroughSection>;
  areas: LocalRecord<Area>[];
  answers: LocalRecord<Answer>[];
  findings: LocalRecord<Finding>[];
  photos: LocalPhoto<PhotoMeta>[];
  assets: LocalRecord<Asset>[];
  ctx: WriteCtx | null;
  online: boolean;
  /** Complete assessments are locked: every field write is refused (CW decision, D-057). */
  locked: boolean;
  /** Fetch the assessment again (after complete or reopen). */
  reload: () => void;
}

const FieldCtx = createContext<FieldData | null>(null);

export function useField(): FieldData {
  const v = useContext(FieldCtx);
  if (!v) throw new Error("useField must be used inside FieldLayout");
  return v;
}

export function FieldLayout({ children }: { children?: ReactNode }) {
  const { id = "" } = useParams();
  const api = useApi();
  const online = useOnline();
  const ctx = useWriteCtx();
  const [base, setBase] = useState<{ assessment: AssessmentDetail; structure: WalkthroughStructure; fromCache: boolean; walkthroughError: string | null; settings: TenantSettings } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const a = await fetchAssessment(api, id);
      const [w, settings] = await Promise.all([
        loadWalkthrough(api, id, a.data.siteId).catch((e: unknown) => ({
          structure: { assessmentId: id, libraryVersion: "", sections: [], assessors: [] } as WalkthroughStructure,
          fromCache: false,
          error: errorMessage(e) || "The walkthrough could not be loaded.",
        })),
        fetchTenantSettings(api),
      ]);
      if (live)
        setBase({ assessment: a.data, structure: w.structure, fromCache: a.fromCache || w.fromCache, walkthroughError: "error" in w ? w.error : null, settings });
    })().catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
    // Reload when connectivity returns so a cached copy is refreshed.
  }, [api, id, attempt, online && base?.fromCache]); // eslint-disable-line react-hooks/exhaustive-deps

  const siteId = base?.assessment.siteId;
  const records = useLocal(
    async () => {
      const [areas, answers, findings, photos, assets] = await Promise.all([
        siteId ? listAreas(siteId) : Promise.resolve([]),
        listRecords<Answer>("answers", id),
        listRecords<Finding>("findings", id),
        listRecords<PhotoMeta>("photos", id) as Promise<LocalPhoto<PhotoMeta>[]>,
        listRecords<Asset>("assets", id),
      ]);
      return { areas, answers, findings, photos, assets };
    },
    [id, siteId],
  );

  const value = useMemo<FieldData | null>(() => {
    if (!base || !records.data) return null;
    const controls = new Map<string, WalkthroughControl>();
    const sectionOf = new Map<string, WalkthroughSection>();
    for (const s of base.structure.sections) for (const c of s.controls) {
      controls.set(c.id, c);
      sectionOf.set(c.id, s);
    }
    return {
      assessmentId: id,
      ...base,
      controls,
      sectionOf,
      ...records.data,
      ctx,
      online,
      locked: base.assessment.status === "complete",
      reload: () => setAttempt((n) => n + 1),
    };
  }, [base, records.data, ctx, online, id]);
  const { pathname } = useLocation();

  if (error && !base)
    return (
      <Banner tone="error" action={<button className="min-h-12 px-2 underline" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}>
        {errorMessage(error) || "This assessment could not be loaded."}
      </Banner>
    );
  if (!value) return <Loading label="Loading assessment" />;
  // The detail page shows its own lock panel; report and results screens stay usable when locked.
  const isIndex = /^\/assessments\/[^/]+\/?$/.test(pathname);
  const readOnlyOk = isIndex || /\/(report|risk)\/?$/.test(pathname);
  return (
    <FieldCtx.Provider value={value}>
      <LockRejections />
      {!isIndex && <LockedNotice />}
      <fieldset disabled={value.locked && !readOnlyOk} className="m-0 min-w-0 border-0 p-0">
        {children ?? <Outlet />}
      </fieldset>
    </FieldCtx.Provider>
  );
}

export const areaKeyOf = (areaId: string | null) => areaId ?? "site";
export const areaIdOf = (key: string) => (key === "site" ? null : key);
export function areaName(areas: LocalRecord<Area>[], areaId: string | null): string {
  if (!areaId) return "Whole site";
  return areas.find((a) => a.id === areaId)?.data.name ?? "Unknown area";
}
