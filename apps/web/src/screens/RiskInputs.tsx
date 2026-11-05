/**
 * Risk inputs per assessment: one card per relevant threat scenario with likelihood and impact on
 * anchored 1 to 5 scales, a rationale, and "Not applicable". Saved on the device first and sent
 * when the API is reachable (src/risk/inputsStore.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApi, useCanWrite } from "../auth/AuthContext";
import { fetchRiskInputs, fetchScenarios, type ScenarioInputState } from "../api/phase3";
import { useField } from "../field/FieldContext";
import { refusalMessage } from "../field/Lock";
import { errorMessage, useAsync } from "../lib/useAsync";
import { CATEGORY_LABEL, IMPACT_SCALE, LIKELIHOOD_SCALE, type ScaleAnchor } from "../risk/levels";
import { flushRiskDraft, loadRiskDraft, saveRiskDraft } from "../risk/inputsStore";
import { Banner, ButtonLink, Chip, Loading, PageHeader, TextArea, Toggle, categoryTone } from "../components/ui";

type SaveState = "idle" | "local" | "sending" | "sent" | "offline" | "refused";

function ScaleButtons({ label, scale, value, onChange, idBase }: { label: string; scale: ScaleAnchor[]; value: number | null; onChange: (v: number) => void; idBase: string }) {
  return (
    <div role="group" aria-labelledby={`${idBase}-l`}>
      <p id={`${idBase}-l`} className="mb-1 font-semibold">
        {label}
        <span className="sr-only">, 1 to 5</span>
      </p>
      <div className="grid grid-cols-5 gap-1.5">
        {scale.map((a) => {
          const on = value === a.value;
          return (
            <button
              key={a.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(a.value)}
              className={
                "flex min-h-16 flex-col items-center justify-center rounded-lg border-2 px-1 py-1 text-center leading-tight " +
                (on ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink")
              }
            >
              <span className="text-2xl font-bold">{a.value}</span>
              <span className="text-sm font-semibold">{a.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const SAVE_TEXT: Record<SaveState, { tone: "ok" | "info" | "warn" | "error"; text: string } | null> = {
  idle: null,
  local: { tone: "info", text: "Saved on this device." },
  sending: { tone: "info", text: "Saved on this device; sending." },
  sent: { tone: "ok", text: "All risk inputs saved to server." },
  offline: { tone: "warn", text: "Saved on this device; waiting for signal to send." },
  refused: { tone: "error", text: "Not saved to server." },
};

export function RiskInputsScreen() {
  const f = useField();
  const api = useApi();
  const canWrite = useCanWrite();
  const scenarios = useAsync(() => fetchScenarios(api), [api]);
  const [inputs, setInputs] = useState<ScenarioInputState[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [refusal, setRefusal] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<ScenarioInputState[] | null>(null);
  latest.current = inputs;
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    (async () => {
      const local = await loadRiskDraft(f.assessmentId).catch(() => undefined);
      if (local?.dirty) {
        if (live) {
          setInputs(local.inputs);
          setSave(local.error ? "refused" : "offline");
          if (local.error) setRefusal(refusalMessage(local.error.code, local.error.message));
        }
        return;
      }
      const server = await fetchRiskInputs(api, f.assessmentId);
      if (live) setInputs(server.data.scenarios);
    })().catch((e: unknown) => live && setLoadError(e));
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, f.assessmentId]);

  const byId = useMemo(() => new Map((scenarios.data?.data ?? []).map((s) => [s.id, s])), [scenarios.data]);

  async function send() {
    setSave("sending");
    const r = await flushRiskDraft(api, f.assessmentId);
    if (r === "refused") {
      const d = await loadRiskDraft(f.assessmentId);
      setRefusal(refusalMessage(d?.error?.code, d?.error?.message));
      setSave("refused");
    } else setSave(r === "sent" || r === "nothing" ? "sent" : "offline");
  }

  function update(id: string, patch: Partial<ScenarioInputState>) {
    const prev = latest.current;
    if (!prev) return;
    const next = prev.map((i) => (i.scenarioId === id ? { ...i, ...patch } : i));
    latest.current = next;
    setInputs(next);
    setRefusal(null);
    setSave("local");
    // Writes are chained so an older snapshot never lands after a newer one.
    writes.current = writes.current
      .then(() => saveRiskDraft(f.assessmentId, next))
      .then(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void send(), 700);
      })
      .catch(() => setSave("offline"));
  }

  if (loadError && !inputs)
    return (
      <>
        <PageHeader title="Risk inputs" back={{ to: `/assessments/${f.assessmentId}`, label: f.assessment.title }} />
        <Banner tone="error">{errorMessage(loadError) || "Risk inputs could not be loaded."} Open this screen online once to keep a copy on this device.</Banner>
      </>
    );
  if (!inputs) return <Loading label="Loading risk inputs" />;

  const scored = inputs.filter((i) => i.excluded || (i.likelihood !== null && i.impact !== null)).length;
  const st = SAVE_TEXT[save];
  const readOnly = !canWrite || f.locked;

  return (
    <>
      <PageHeader
        title="Risk inputs"
        back={{ to: `/assessments/${f.assessmentId}`, label: f.assessment.title }}
        subtitle={`${scored} of ${inputs.length} scenarios scored or marked not applicable`}
        actions={<ButtonLink to={`/assessments/${f.assessmentId}/risk`}>See results</ButtonLink>}
      />
      <p className="mb-3 text-muted">
        For each threat to this site, rate how likely it is and how bad it would be, before counting current controls. Inherent risk is likelihood times impact.
      </p>
      <div className="sticky top-0 z-10 mb-3 min-h-12" aria-live="polite">
        {st && (
          <Banner tone={st.tone}>
            <span data-testid="risk-save-status">{st.text}</span>
            {save === "refused" && refusal ? ` ${refusal}` : ""}
          </Banner>
        )}
      </div>
      {readOnly && !f.locked && <Banner tone="info">Your role can view risk inputs but not change them.</Banner>}
      <ol className="flex flex-col gap-4">
        {inputs.map((i) => {
          const s = byId.get(i.scenarioId);
          const hid = `sc-${i.scenarioId}`;
          const score = i.likelihood && i.impact ? i.likelihood * i.impact : null;
          return (
            <li key={i.scenarioId}>
              <article aria-labelledby={hid} className="rounded-xl border-2 border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 id={hid} className="text-xl font-bold">
                    {s?.name ?? i.scenarioId}
                  </h2>
                  {s && <Chip tone={categoryTone(s.category)}>{CATEGORY_LABEL[s.category]}</Chip>}
                </div>
                {s && <p className="mt-1 text-muted">{s.description}</p>}
                <div className="mt-3">
                  <Toggle pressed={i.excluded} disabled={readOnly} onPressedChange={(v) => update(i.scenarioId, { excluded: v })}>
                    Not applicable
                  </Toggle>
                </div>
                {i.excluded ? (
                  <p className="mt-3 font-semibold">Not applicable to this site: left out of the risk results.</p>
                ) : (
                  <div className="mt-3 flex flex-col gap-4">
                    <ScaleButtons idBase={`${hid}-lik`} label="Likelihood" scale={LIKELIHOOD_SCALE} value={i.likelihood} onChange={(v) => update(i.scenarioId, { likelihood: v })} />
                    <ScaleButtons idBase={`${hid}-imp`} label="Impact" scale={IMPACT_SCALE} value={i.impact} onChange={(v) => update(i.scenarioId, { impact: v })} />
                    <p className="font-semibold" data-testid={`inherent-${i.scenarioId}`}>
                      {score !== null ? `Inherent risk: ${i.likelihood} × ${i.impact} = ${score} of 25` : "Inherent risk: set likelihood and impact"}
                    </p>
                  </div>
                )}
                <div className="mt-3">
                  <TextArea
                    label="Rationale (optional)"
                    value={i.rationale ?? ""}
                    maxLength={2000}
                    onChange={(e) => update(i.scenarioId, { rationale: e.target.value })}
                    hint="Why you chose these ratings; shown in the report."
                  />
                </div>
              </article>
            </li>
          );
        })}
      </ol>
    </>
  );
}
