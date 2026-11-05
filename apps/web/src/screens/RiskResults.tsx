/**
 * Risk results: overall summary, then one card per scenario (highest residual first) with the
 * before and after visual, control effectiveness, confidence, the engine's explanation sentences,
 * and "How was this calculated?" listing the contributing controls and findings.
 */
import { Link } from "react-router-dom";
import type { RiskResult, ScenarioResult } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { fetchRisk } from "../api/phase3";
import { useField } from "../field/FieldContext";
import { errorMessage, useAsync } from "../lib/useAsync";
import { CATEGORY_LABEL, CONFIDENCE_LABEL, effectivenessText, formatPercent, formatScore, isUnscored } from "../risk/levels";
import { BeforeAfter, LevelBadge, NotScoredBadge, PercentMeter } from "../risk/RiskViz";
import { Banner, ButtonLink, Card, Chip, EmptyState, Loading, PageHeader, categoryTone } from "../components/ui";

const WEIGHT_LABEL: Record<number, string> = { 1: "low weight", 2: "medium weight", 3: "high weight" };

export function ScenarioCard({ s, findingTitle, assessmentId }: { s: ScenarioResult; findingTitle: (id: string) => string; assessmentId: string }) {
  const hid = `res-${s.scenarioId}`;
  return (
    <article aria-labelledby={hid} className="rounded-xl border-2 border-line bg-surface p-4" data-testid={`scenario-${s.scenarioId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={hid} className="text-xl font-bold">
          {s.name}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Chip tone={categoryTone(s.category)}>{CATEGORY_LABEL[s.category]}</Chip>
          <Chip tone={s.confidence === "low" ? "warn" : "neutral"}>{CONFIDENCE_LABEL[s.confidence]}</Chip>
        </div>
      </div>
      <div className="mt-3">
        <BeforeAfter inherent={s.inherent} residual={s.residual} />
      </div>
      <p className="mt-2 text-base text-muted">
        Likelihood {formatScore(s.inherent.likelihood)} × impact {formatScore(s.inherent.impact)} = inherent {formatScore(s.inherent.score)}
      </p>
      <div className="mt-3">
        <PercentMeter
          label="Control effectiveness"
          value={s.controlEffectiveness.value}
          hint={`Evidence covers ${formatPercent(s.controlEffectiveness.coverage)} of the weighted controls for this scenario.`}
        />
      </div>
      <h4 className="mt-3 font-bold">Why</h4>
      <ul className="mt-1 list-disc space-y-1 pl-6" data-testid="explanation">
        {s.explanation.map((line, n) => (
          <li key={n}>{line}</li>
        ))}
      </ul>
      <details className="mt-3 rounded-lg border-2 border-line">
        <summary className="flex min-h-12 cursor-pointer items-center px-3 font-semibold text-primary underline underline-offset-4">
          How was this calculated? ({s.controlEffectiveness.contributors.length} {s.controlEffectiveness.contributors.length === 1 ? "control" : "controls"})
        </summary>
        <div className="px-3 pb-3">
          <p className="mb-2">
            Inherent risk is likelihood times impact. Each mitigating control counts by its weight and how effective your answers and findings show it to be; residual risk is what remains after that effectiveness.
          </p>
          <ul className="flex flex-col gap-2">
            {s.controlEffectiveness.contributors.map((c) => (
              <li key={c.controlId} className="rounded-lg border-2 border-line p-3">
                <Link to={`/library/${encodeURIComponent(c.controlId)}`} className="font-semibold text-primary underline underline-offset-4">
                  {c.controlId}: {c.title}
                </Link>
                <p>
                  {effectivenessText(c.effectiveness)}, {WEIGHT_LABEL[c.weight] ?? `weight ${c.weight}`}
                </p>
                <p className="text-muted">{c.evidence}</p>
                {c.findingIds.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-1">
                    {c.findingIds.map((fid) => (
                      <li key={fid}>
                        <Link to={`/assessments/${assessmentId}/findings/${fid}`} className="inline-flex min-h-12 items-center text-primary underline underline-offset-4">
                          Finding: {findingTitle(fid)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </article>
  );
}

export function OverallSummary({ r, locked }: { r: RiskResult; locked: boolean }) {
  const unscored = isUnscored(r);
  return (
    <Card as="section" className="mb-4 border-primary">
      <h2 className="text-2xl font-bold">Overall</h2>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="font-semibold">Overall residual risk</span>
        {unscored ? <NotScoredBadge /> : <LevelBadge level={r.overall.level} score={r.overall.residual} className="text-xl" />}
      </div>
      {!unscored && (
        <p className="mt-1">
          Inherent {formatScore(r.overall.inherent)}, residual {formatScore(r.overall.residual)}.
        </p>
      )}
      {r.overall.explanation.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-6">
          {r.overall.explanation.map((l, n) => (
            <li key={n}>{l}</li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-base text-muted">
        Method {r.methodVersion}; {locked ? "frozen when the assessment was completed" : "calculated"} {new Date(r.computedAt).toLocaleString()}.
      </p>
    </Card>
  );
}

export function RiskResultsScreen() {
  const f = useField();
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => fetchRisk(api, f.assessmentId), [api, f.assessmentId, f.findings.length, f.answers.length]);
  const r = data?.data;
  const title = (id: string) => f.findings.find((x) => x.id === id)?.data.title ?? "Open finding";
  const sorted = r ? [...r.scenarios].sort((a, b) => b.residual.score - a.residual.score) : [];
  return (
    <>
      <PageHeader
        title="Risk results"
        back={{ to: `/assessments/${f.assessmentId}`, label: f.assessment.title }}
        actions={!f.locked ? <ButtonLink variant="secondary" to={`/assessments/${f.assessmentId}/risk/inputs`}>Edit risk inputs</ButtonLink> : undefined}
      />
      {error ? (
        <Banner tone="error" action={<button className="min-h-12 underline" onClick={reload}>Try again</button>}>
          {errorMessage(error) || "Risk results could not be loaded."}
        </Banner>
      ) : null}
      {data?.fromCache && (
        <div className="mb-3">
          <Banner tone="info">Showing results saved on this device; they update when you are back online.</Banner>
        </div>
      )}
      {loading && !r && <Loading label="Calculating risk" />}
      {r && (
        <>
          <OverallSummary r={r} locked={f.locked} />
          {r.missingInputs.length > 0 && (
            <div className="mb-4">
              <Banner tone="warn" title={`${r.missingInputs.length} ${r.missingInputs.length === 1 ? "scenario has" : "scenarios have"} no likelihood and impact yet`}>
                They are left out until scored. <Link to={`/assessments/${f.assessmentId}/risk/inputs`} className="font-semibold underline">Add risk inputs</Link>
              </Banner>
            </div>
          )}
          <h2 className="mb-2 text-2xl font-bold">By scenario, highest residual first</h2>
          {sorted.length === 0 ? (
            <EmptyState title="No scored scenarios yet" action={<ButtonLink to={`/assessments/${f.assessmentId}/risk/inputs`}>Add risk inputs</ButtonLink>} />
          ) : (
            <ol className="flex flex-col gap-4">
              {sorted.map((s) => (
                <li key={s.scenarioId}>
                  <ScenarioCard s={s} findingTitle={title} assessmentId={f.assessmentId} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}
