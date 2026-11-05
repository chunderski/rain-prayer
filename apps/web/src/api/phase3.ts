/**
 * Phase 3 API calls (docs/api-phase3.md): risk inputs and results, comparison, dashboard, report
 * narrative and preview, Google export, and the assessment lock. Response shapes come from
 * @sentinel/shared where the contract defines them; the rest are declared here.
 */
import { z } from "zod";
import { ExportJob, Narrative, RiskLevel, RiskResult, Severity, SiteComparison, ThreatScenario, NarrativeSection as NarrativeSectionSchema } from "@sentinel/shared";
import type { ApiClient } from "./client";
import { cachedGet } from "./library";

const enc = encodeURIComponent;
export type NarrativeSection = z.infer<typeof NarrativeSectionSchema>;
export const NARRATIVE_SECTIONS = NarrativeSectionSchema.options;

/** GET inputs: likelihood and impact stay null until the assessor sets them. */
export const ScenarioInputState = z.object({
  scenarioId: z.string(),
  likelihood: z.number().int().min(1).max(5).nullable(),
  impact: z.number().int().min(1).max(5).nullable(),
  rationale: z.string().max(2000).nullish(),
  excluded: z.boolean().default(false),
});
export type ScenarioInputState = z.infer<typeof ScenarioInputState>;
export const RiskInputsResponse = z.object({ scenarios: z.array(ScenarioInputState) });

export const DashboardData = z.object({
  assessmentsByStatus: z.record(z.string(), z.number().int()),
  findingsBySeverity: z.record(z.string(), z.number().int()),
  openHighFindings: z.number().int(),
  topResidual: z.array(
    z.object({ assessmentId: z.string(), siteName: z.string(), scenarioName: z.string(), level: RiskLevel, residual: z.number() }),
  ),
  recent: z.array(z.unknown()).optional(),
});
export type DashboardData = z.infer<typeof DashboardData>;

export const GoogleStatus = z.object({
  connected: z.boolean(),
  email: z.string().nullish(),
  scopes: z.array(z.string()).nullish(),
  connectedAt: z.string().nullish(),
});
export type GoogleStatus = z.infer<typeof GoogleStatus>;

export const fetchScenarios = (api: ApiClient) => cachedGet(api, "/risk/scenarios", z.array(ThreatScenario));
export const fetchRiskInputs = (api: ApiClient, id: string) => cachedGet(api, `/assessments/${enc(id)}/risk/inputs`, RiskInputsResponse);
export const fetchRisk = (api: ApiClient, id: string) => cachedGet(api, `/assessments/${enc(id)}/risk`, RiskResult);
export const fetchDashboard = (api: ApiClient) => cachedGet(api, "/dashboard", DashboardData);
export const fetchComparison = (api: ApiClient, ids: string[]) =>
  cachedGet(api, `/risk/compare?assessmentIds=${ids.map(enc).join(",")}`, SiteComparison);

/** Only complete inputs (both scales set) or excluded scenarios are sent. */
export function toPutBody(inputs: ScenarioInputState[]) {
  return {
    scenarios: inputs
      .filter((i) => i.excluded || (i.likelihood !== null && i.impact !== null))
      .map((i) => ({
        scenarioId: i.scenarioId,
        // The contract requires numbers even for excluded scenarios; the engine ignores them when excluded.
        likelihood: i.likelihood ?? 1,
        impact: i.impact ?? 1,
        ...(i.rationale ? { rationale: i.rationale } : {}),
        excluded: i.excluded,
      })),
  };
}

export const putRiskInputs = (api: ApiClient, id: string, inputs: ScenarioInputState[]) =>
  api.request(`/assessments/${enc(id)}/risk/inputs`, { method: "PUT", body: toPutBody(inputs), schema: RiskInputsResponse });

export const completeAssessment = (api: ApiClient, id: string) =>
  api.request(`/assessments/${enc(id)}`, { method: "PATCH", body: { status: "complete" } });
export const reopenAssessment = (api: ApiClient, id: string, reason: string) =>
  api.request(`/assessments/${enc(id)}/reopen`, { method: "POST", body: { reason } });

export const fetchNarratives = (api: ApiClient, id: string) => api.get(`/assessments/${enc(id)}/narrative`, z.array(Narrative));
export const draftNarrative = (api: ApiClient, id: string, section: NarrativeSection, replace = false) =>
  api.post(`/assessments/${enc(id)}/narrative/draft`, replace ? { section, replace } : { section }, Narrative);
export const putNarrative = (api: ApiClient, id: string, section: NarrativeSection, text: string, approve: boolean) =>
  api.request(`/assessments/${enc(id)}/narrative/${enc(section)}`, { method: "PUT", body: { text, approve }, schema: Narrative });
export const fetchReportPreview = (api: ApiClient, id: string) =>
  api.request(`/assessments/${enc(id)}/report/preview`, { text: true }) as Promise<string>;

export const startExport = (api: ApiClient, id: string, targets: string[]) =>
  api.post(`/assessments/${enc(id)}/exports`, { targets }, ExportJob);
export const fetchExport = (api: ApiClient, jobId: string) => api.get(`/exports/${enc(jobId)}`, ExportJob);
export const fetchExports = (api: ApiClient, id: string) => api.get(`/assessments/${enc(id)}/exports`, z.array(ExportJob));

export const fetchGoogle = (api: ApiClient) => api.get("/integrations/google", GoogleStatus);
export const disconnectGoogle = (api: ApiClient) => api.request("/integrations/google", { method: "DELETE" });
/** The API checks the admin bearer token and returns the Google consent URL (state and PKCE bound to this admin). */
export const fetchGoogleConnectUrl = async (api: ApiClient) => (await api.get("/integrations/google/connect", z.object({ url: z.string().url() }))).url;

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
