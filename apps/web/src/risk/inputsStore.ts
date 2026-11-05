/**
 * Offline-first risk inputs. Risk inputs are not a sync entity (the sync contract covers field
 * records only), so each change is saved to the IndexedDB drafts store first, marked dirty, and
 * sent with PUT /assessments/:id/risk/inputs when the API is reachable. Drafts are wiped at sign out.
 */
import { ApiError, NetworkError, type ApiClient } from "../api/client";
import { putRiskInputs, type ScenarioInputState } from "../api/phase3";
import { getDb, getDraft, notifyLocalChange, saveDraft } from "../offline/db";

export const RISK_DRAFT_KIND = "risk_inputs";
const key = (assessmentId: string) => `risk-inputs:${assessmentId}`;

export interface RiskDraft {
  assessmentId: string;
  inputs: ScenarioInputState[];
  dirty: boolean;
  /** Last refusal from the server (for example assessment_locked); cleared on the next save. */
  error?: { code: string; message: string } | null;
}

export async function loadRiskDraft(assessmentId: string): Promise<RiskDraft | undefined> {
  return (await getDraft<RiskDraft>(key(assessmentId)))?.data;
}

export async function saveRiskDraft(assessmentId: string, inputs: ScenarioInputState[]): Promise<void> {
  await saveDraft<RiskDraft>(key(assessmentId), RISK_DRAFT_KIND, { assessmentId, inputs, dirty: true, error: null });
}

export type FlushResult = "sent" | "offline" | "refused" | "nothing";

/** Send one assessment's dirty inputs. Network failures keep the draft for a later try. */
export async function flushRiskDraft(api: ApiClient, assessmentId: string): Promise<FlushResult> {
  const d = await loadRiskDraft(assessmentId);
  if (!d?.dirty) return "nothing";
  try {
    await putRiskInputs(api, assessmentId, d.inputs);
    const latest = await loadRiskDraft(assessmentId);
    // Only clear dirty when nothing changed while the request was in flight.
    if (latest && JSON.stringify(latest.inputs) === JSON.stringify(d.inputs)) {
      await saveDraft<RiskDraft>(key(assessmentId), RISK_DRAFT_KIND, { ...latest, dirty: false, error: null });
    }
    notifyLocalChange();
    return "sent";
  } catch (err) {
    if (err instanceof NetworkError) return "offline";
    if (err instanceof ApiError && (err.status >= 500 || err.status === 429 || err.status === 401)) return "offline";
    const e = err instanceof ApiError ? { code: err.code, message: err.message } : { code: "error", message: "The server did not accept the risk inputs." };
    await saveDraft<RiskDraft>(key(assessmentId), RISK_DRAFT_KIND, { ...d, error: e });
    notifyLocalChange();
    return "refused";
  }
}

/** Called by the sync loop: send every assessment's unsent risk inputs. */
export async function flushAllRiskDrafts(api: ApiClient): Promise<void> {
  const drafts = await (await getDb()).getAllFromIndex("drafts", "byKind", RISK_DRAFT_KIND);
  for (const d of drafts) {
    const data = d.data as RiskDraft;
    if (data.dirty && !data.error) await flushRiskDraft(api, data.assessmentId);
  }
}
