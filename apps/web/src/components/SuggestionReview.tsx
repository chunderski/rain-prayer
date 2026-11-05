/**
 * AI photo suggestions (US-2.10 to US-2.12). Rules:
 *  - Hidden when the workspace turned AI photo analysis off; "Analyze with AI" needs a connection
 *    and a photo that has finished uploading, and says why when it is unavailable.
 *  - Everything from the model is labelled "AI suggestion, not final" and rendered as plain text
 *    (React text nodes only; no HTML is ever interpreted).
 *  - Each draft finding needs an explicit decision (Accept, Edit then save, or Reject), and nothing
 *    is applied until the assessor taps "Save review". Suggested photo tags apply only when the
 *    assessor ticks the box.
 */
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { AiSuggestion as AiSuggestionT, PhotoMeta, ReviewSuggestion } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { ApiError, NetworkError } from "../api/client";
import { useField } from "../field/FieldContext";
import { AiSuggestion, ReviewResult } from "../field/schemas";
import { putServerRecords } from "../field/repo";
import { SEVERITY, assetTypeLabel, confidenceText, type SeverityValue } from "../field/labels";
import { getDb, notifyLocalChange, type LocalPhoto } from "../offline/db";
import { useLocal } from "../lib/useLocal";
import { useSync } from "../sync/SyncContext";
import { ControlPicker, SeverityPicker } from "./FieldPickers";
import { Banner, Button, Card, Chip, Field, TextArea } from "./ui";

type Draft = NonNullable<AiSuggestionT["output"]>["draftFindings"][number];
type EditedDraft = Pick<Draft, "title" | "description" | "recommendation" | "severity" | "controlIds">;
type Decision = { kind: "accept" } | { kind: "reject" } | { kind: "edit"; finding: EditedDraft };

async function storeSuggestions(list: AiSuggestionT[]) {
  const db = await getDb();
  const tx = db.transaction("suggestions", "readwrite");
  for (const s of list) await tx.store.put({ id: s.id, photoId: s.photoId, data: s });
  await tx.done;
  notifyLocalChange();
}

/** Turn per-draft decisions into the single review call the API takes. */
export function buildReview(drafts: Draft[], decisions: Record<number, Decision>, applyTags: boolean, output: NonNullable<AiSuggestionT["output"]>, reason?: string): ReviewSuggestion {
  const kept = drafts.map((d, i) => ({ d, i, dec: decisions[i] })).filter((x) => x.dec && x.dec.kind !== "reject");
  const tags = { assetType: output.assetType.value, controlIds: output.controls.map((c) => c.id).slice(0, 30) };
  if (!kept.length && !applyTags) return { decision: "reject", ...(reason?.trim() ? { reason: reason.trim() } : {}) };
  if (kept.some((x) => x.dec!.kind === "edit")) {
    return {
      decision: "edit",
      findings: kept.map((x) => {
        const src = x.dec!.kind === "edit" ? x.dec!.finding : x.d;
        return { title: src.title, description: src.description, recommendation: src.recommendation, severity: src.severity, controlIds: src.controlIds };
      }),
      ...(applyTags ? { tags } : {}),
    };
  }
  return { decision: "accept", findingIndexes: kept.map((x) => x.i), applyTags };
}

export function SuggestionReview({ photo }: { photo: LocalPhoto<PhotoMeta> }) {
  const f = useField();
  const api = useApi();
  const { syncNow } = useSync();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const list = useLocal(
    async () =>
      (await (await getDb()).getAllFromIndex("suggestions", "byPhoto", photo.id))
        .map((e) => AiSuggestion.safeParse(e.data))
        .flatMap((r) => (r.success ? [r.data] : []))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [photo.id],
  );
  const stored = photo.serverStatus === "stored";

  useEffect(() => {
    if (!f.online || !stored || !f.settings.aiPhotoAnalysis) return;
    api
      .get(`/photos/${encodeURIComponent(photo.id)}/suggestions`, z.array(AiSuggestion))
      .then(storeSuggestions)
      .catch(() => undefined);
  }, [api, photo.id, f.online, stored, f.settings.aiPhotoAnalysis]);

  if (!f.settings.aiPhotoAnalysis) return null;

  async function analyze() {
    setBusy(true);
    setError(null);
    setDoneMsg(null);
    try {
      const s = await api.post(`/photos/${encodeURIComponent(photo.id)}/analyze`, {}, AiSuggestion);
      await storeSuggestions([s]);
    } catch (err) {
      if (err instanceof NetworkError) setError("No connection. Try again when you have signal; your photo is safe on this device.");
      else if (err instanceof ApiError && err.code === "ai_disabled") setError("AI photo analysis is turned off for this workspace.");
      else if (err instanceof ApiError && err.code === "ai_not_configured") setError("AI analysis is not set up on this server yet.");
      else if (err instanceof ApiError && err.status === 429) setError("You have reached the hourly limit for AI analysis. Try again later.");
      else setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  const latest = list.data?.[0];
  const reviewed = list.data?.filter((s) => s.status === "accepted" || s.status === "edited" || s.status === "rejected") ?? [];
  const disabledReason = !f.online ? "Needs a connection. The photo is saved; analyze it when you are back online." : !stored ? "Available once the photo has uploaded." : null;

  return (
    <section aria-labelledby="ai-h" className="flex flex-col gap-3">
      <h2 id="ai-h" className="text-2xl font-bold">
        AI suggestions
      </h2>
      <div className="flex flex-col gap-1">
        <Button size="lg" variant={latest?.status === "suggested" ? "secondary" : "primary"} disabled={!!disabledReason || busy || !f.ctx} onClick={() => void analyze()} aria-describedby={disabledReason ? "ai-why-disabled" : undefined}>
          {busy ? "Analyzing…" : latest ? "Analyze again with AI" : "Analyze with AI"}
        </Button>
        {disabledReason && (
          <p id="ai-why-disabled" className="text-base font-semibold">
            {disabledReason}
          </p>
        )}
        <p className="text-base text-muted">AI suggests tags and draft findings. Nothing is added until you review it.</p>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {doneMsg && (
        <Banner tone="ok" live>
          {doneMsg}
        </Banner>
      )}
      {latest?.status === "failed" && <Banner tone="error" title="AI analysis failed">{latest.error ?? "The model did not return a usable answer."}</Banner>}
      {latest?.status === "suggested" && latest.output && (
        <ReviewPanel
          key={latest.id}
          suggestion={latest}
          onDone={async (res, message) => {
            setDoneMsg(message);
            await storeSuggestions([res.suggestion]);
            await putServerRecords("findings", f.assessmentId, res.findings);
            await putServerRecords("photos", f.assessmentId, [res.photo]);
            syncNow();
          }}
        />
      )}
      {reviewed.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Reviewed suggestions">
          {reviewed.map((s) => (
            <li key={s.id} className="text-base">
              {s.status === "rejected" ? "Rejected" : s.status === "edited" ? "Accepted with edits (AI-assisted, human-edited)" : "Accepted (AI-assisted)"}
              {s.reviewedAt ? ` on ${new Date(s.reviewedAt).toLocaleString()}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewPanel({ suggestion, onDone }: { suggestion: AiSuggestionT; onDone: (r: z.infer<typeof ReviewResult>, message: string) => Promise<void> }) {
  const f = useField();
  const api = useApi();
  const out = suggestion.output!;
  const drafts = out.draftFindings;
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [applyTags, setApplyTags] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undecided = drafts.filter((_, i) => !decisions[i]).length;
  const allRejected = drafts.length > 0 && drafts.every((_, i) => decisions[i]?.kind === "reject");
  const ctlTitle = (id: string) => f.controls.get(id)?.title ?? id;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = buildReview(drafts, decisions, applyTags, out, reason);
      const res = await api.post(`/suggestions/${encodeURIComponent(suggestion.id)}/review`, body, ReviewResult);
      await onDone(res, body.decision === "reject" ? "Suggestion rejected and logged." : `Saved: ${res.findings.length} ${res.findings.length === 1 ? "finding" : "findings"} added, marked AI-assisted.`);
    } catch (err) {
      setError(err instanceof NetworkError ? "No connection. Your choices are kept on screen; save again when you have signal." : err instanceof Error ? err.message : "Could not save the review.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="article" className="flex flex-col gap-4 border-warn">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="warn">
          <span aria-hidden="true">!</span> AI suggestion, not final
        </Chip>
        <span className="text-base text-muted">Model {suggestion.model}</span>
      </div>
      {out.cautions.length > 0 && (
        <Banner tone="warn" title="Check before accepting">
          <ul className="list-disc pl-5">
            {out.cautions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </Banner>
      )}
      {out.imageQuality !== "ok" && <Banner tone="warn">Image quality: {out.imageQuality.replace(/_/g, " ")}. Suggestions may be unreliable.</Banner>}

      <section aria-labelledby="ai-tags-h">
        <h3 id="ai-tags-h" className="text-xl font-bold">
          Suggested tags
        </h3>
        <dl className="mt-1 flex flex-col gap-1">
          <div>
            <dt className="inline font-semibold">Asset type: </dt>
            <dd className="inline">
              {assetTypeLabel(out.assetType.value)}, confidence {confidenceText(out.assetType.confidence)}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Condition: </dt>
            <dd className="inline">
              {out.condition.rating}, confidence {confidenceText(out.condition.confidence)}. {out.condition.summary}
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Controls</dt>
            <dd>
              <ul className="flex flex-col gap-1">
                {out.controls.map((c) => (
                  <li key={c.id}>
                    {ctlTitle(c.id)}, confidence {confidenceText(c.confidence)}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
        <label className="mt-2 flex min-h-12 items-center gap-3 font-semibold">
          <input type="checkbox" className="size-6" checked={applyTags} onChange={(e) => setApplyTags(e.target.checked)} />
          Apply these tags to the photo
        </label>
      </section>

      <section aria-labelledby="ai-drafts-h" className="flex flex-col gap-3">
        <h3 id="ai-drafts-h" className="text-xl font-bold">
          Draft findings ({drafts.length})
        </h3>
        {drafts.length === 0 && <p>The AI did not suggest any findings for this photo.</p>}
        {drafts.map((d, i) => {
          const dec = decisions[i];
          const shown = dec?.kind === "edit" ? dec.finding : d;
          const why = out.deficiencies.filter((x) => x.controlIds.some((c) => d.controlIds.includes(c)));
          const rationales = out.controls.filter((c) => d.controlIds.includes(c.id));
          return (
            <Card key={i} as="article" className={dec?.kind === "reject" ? "opacity-80" : ""}>
              <p className="text-base font-semibold">
                <Chip tone="warn">AI suggestion, not final</Chip> <span className="ml-1">Confidence {confidenceText(d.confidence)}</span>
              </p>
              {editing === i ? (
                <EditDraft
                  initial={shown}
                  onCancel={() => setEditing(null)}
                  onSave={(finding) => {
                    setDecisions({ ...decisions, [i]: { kind: "edit", finding } });
                    setEditing(null);
                  }}
                />
              ) : (
                <>
                  <h4 className="mt-2 text-xl font-bold">{shown.title}</h4>
                  <p className="mt-1">
                    Severity: <strong>{SEVERITY[shown.severity].icon} {SEVERITY[shown.severity].label}</strong>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{shown.description}</p>
                  {shown.recommendation && (
                    <p className="mt-1 whitespace-pre-wrap">
                      <strong>Recommendation: </strong>
                      {shown.recommendation}
                    </p>
                  )}
                  <p className="mt-1 text-base">Controls: {shown.controlIds.map(ctlTitle).join("; ")}</p>
                  <details className="mt-2">
                    <summary className="inline-flex min-h-12 cursor-pointer items-center font-semibold text-primary underline underline-offset-4">Why?</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {why.map((x, k) => (
                        <li key={`d${k}`}>
                          Seen in the photo: {x.description} (confidence {confidenceText(x.confidence)})
                        </li>
                      ))}
                      {rationales.map((c) => (
                        <li key={c.id}>
                          {ctlTitle(c.id)}: {c.rationale}
                        </li>
                      ))}
                      {!why.length && !rationales.length && <li>The model gave no further reason.</li>}
                    </ul>
                  </details>
                  <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label={`Decision for ${d.title}`}>
                    <Button aria-pressed={dec?.kind === "accept"} variant={dec?.kind === "accept" ? "primary" : "secondary"} onClick={() => setDecisions({ ...decisions, [i]: { kind: "accept" } })}>
                      {dec?.kind === "accept" && <span aria-hidden="true">✓</span>}Accept
                    </Button>
                    <Button aria-pressed={dec?.kind === "edit"} variant={dec?.kind === "edit" ? "primary" : "secondary"} onClick={() => setEditing(i)}>
                      {dec?.kind === "edit" && <span aria-hidden="true">✓</span>}Edit
                    </Button>
                    <Button aria-pressed={dec?.kind === "reject"} variant={dec?.kind === "reject" ? "danger" : "secondary"} onClick={() => setDecisions({ ...decisions, [i]: { kind: "reject" } })}>
                      {dec?.kind === "reject" && <span aria-hidden="true">✓</span>}Reject
                    </Button>
                  </div>
                  {dec && <p className="mt-1 text-base font-semibold">{dec.kind === "accept" ? "Will be accepted" : dec.kind === "edit" ? "Will be saved with your edits" : "Will be rejected"}</p>}
                </>
              )}
            </Card>
          );
        })}
      </section>

      {(allRejected || drafts.length === 0) && !applyTags && <TextArea label="Reason for rejecting (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />}
      {error && <Banner tone="error">{error}</Banner>}
      <div className="flex flex-col gap-1">
        <Button size="lg" disabled={busy || undecided > 0 || editing !== null || !f.online} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save review"}
        </Button>
        <p className="text-base text-muted">
          {undecided > 0 ? `Choose Accept, Edit, or Reject for ${undecided} more draft ${undecided === 1 ? "finding" : "findings"}.` : !f.online ? "Needs a connection to save." : "Nothing is added to findings until you save your review."}
        </p>
      </div>
    </Card>
  );
}

function EditDraft({ initial, onSave, onCancel }: { initial: EditedDraft; onSave: (d: EditedDraft) => void; onCancel: () => void }) {
  const f = useField();
  const [d, setD] = useState<EditedDraft>(initial);
  const valid = useMemo(() => d.title.trim().length >= 3 && d.controlIds.length > 0, [d]);
  return (
    <div className="mt-2 flex flex-col gap-3">
      <Field label="Title" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} error={d.title.trim().length < 3 ? "At least 3 characters." : undefined} />
      <TextArea label="Description" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
      <TextArea label="Recommendation" value={d.recommendation} onChange={(e) => setD({ ...d, recommendation: e.target.value })} />
      <SeverityPicker value={d.severity} onChange={(s) => s && setD({ ...d, severity: s as SeverityValue })} />
      <ControlPicker controls={f.controls} value={d.controlIds} onChange={(controlIds) => setD({ ...d, controlIds })} max={10} />
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!valid} onClick={() => onSave({ ...d, title: d.title.trim() })}>
          Save edit
        </Button>
      </div>
    </div>
  );
}
