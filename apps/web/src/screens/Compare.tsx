/**
 * Site comparison: pick 2 to 20 assessments, then a heatmap-style table of residual level per
 * scenario and site, plus findings by severity. Caveats from the API are shown first. Every cell
 * prints its level name and score; color only reinforces the text.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import type { SiteComparison } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { cachedGet } from "../api/library";
import { AssessmentSummary } from "../api/schemas";
import { fetchComparison, fetchScenarios, SEVERITY_ORDER } from "../api/phase3";
import { errorMessage, useAsync } from "../lib/useAsync";
import { formatScore, isUnscored, LEVEL_CLASS, LEVEL_LABEL, LEVEL_MARK } from "../risk/levels";
import { LevelBadge, NotScoredBadge } from "../risk/RiskViz";
import { Banner, Button, Card, Loading, PageHeader } from "../components/ui";
import { statusLabel } from "./Assessments";

export const MIN_SITES = 2;
export const MAX_SITES = 20;

function Picker({ initial, onCompare }: { initial: string[]; onCompare: (ids: string[]) => void }) {
  const api = useApi();
  const list = useAsync(() => cachedGet(api, "/assessments", z.array(AssessmentSummary)), [api]);
  const [picked, setPicked] = useState<string[]>(initial);
  const [error, setError] = useState<string>();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (picked.length < MIN_SITES || picked.length > MAX_SITES) return setError(`Choose ${MIN_SITES} to ${MAX_SITES} assessments.`);
    setError(undefined);
    onCompare(picked);
  }

  if (list.loading && !list.data) return <Loading label="Loading assessments" />;
  const items = list.data?.data ?? [];
  return (
    <form onSubmit={submit} noValidate>
      <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={error ? "pick-err" : "pick-hint"}>
        <legend className="text-xl font-bold">Choose assessments to compare</legend>
        <p id="pick-hint" className="text-muted">
          {MIN_SITES} to {MAX_SITES}. Completed assessments use their frozen scores; open ones use live scores.
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((a) => {
            const on = picked.includes(a.id);
            return (
              <li key={a.id}>
                <label className={"flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-2 p-3 " + (on ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
                  <input
                    type="checkbox"
                    className="size-6 shrink-0"
                    checked={on}
                    onChange={() => setPicked((p) => (on ? p.filter((x) => x !== a.id) : [...p, a.id]))}
                  />
                  <span>
                    <span className="font-semibold">{a.title}</span>
                    <span className="block text-base text-muted">
                      {[a.clientName, a.siteName, statusLabel[a.status] ?? a.status].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {error && (
        <p id="pick-err" role="alert" className="mt-2 font-semibold text-danger">
          {error}
        </p>
      )}
      <div className="sticky bottom-20 mt-3 sm:bottom-2">
        <Button type="submit" size="lg" block>
          Compare {picked.length} {picked.length === 1 ? "assessment" : "assessments"}
        </Button>
      </div>
    </form>
  );
}

function ScrollTable({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-6">
      <h2 id={id} className="mb-2 text-2xl font-bold">
        {title}
      </h2>
      {/* Focusable so keyboard users can scroll wide tables (up to 20 sites). */}
      <div role="region" aria-labelledby={id} tabIndex={0} className="overflow-x-auto rounded-lg border-2 border-line bg-surface">
        {children}
      </div>
    </section>
  );
}

const thSite = "min-w-36 border-b-2 border-l-2 border-line p-2 text-left align-bottom";
const thRow = "sticky left-0 z-[1] min-w-40 border-b-2 border-line bg-surface p-2 text-left font-semibold";

export function ComparisonView({ c, scenarioName }: { c: SiteComparison; scenarioName: (id: string) => string }) {
  const scenarioIds = [...new Set(c.sites.flatMap((s) => Object.keys(s.byScenario)))];
  // Worst first: highest residual anywhere.
  scenarioIds.sort((a, b) => Math.max(...c.sites.map((s) => s.byScenario[b]?.residual ?? 0)) - Math.max(...c.sites.map((s) => s.byScenario[a]?.residual ?? 0)));
  const head = (
    <thead>
      <tr>
        <th scope="col" className={thRow}>
          Scenario
        </th>
        {c.sites.map((s) => (
          <th key={s.assessmentId} scope="col" className={thSite}>
            <span className="block font-bold">{s.siteName}</span>
            <span className="block text-base font-normal text-muted">{s.clientName}</span>
            <span className="block text-base font-normal text-muted">{s.completedAt ? `Completed ${new Date(s.completedAt).toLocaleDateString()}` : "Open: live scores"}</span>
          </th>
        ))}
      </tr>
    </thead>
  );
  return (
    <>
      {c.caveats.length > 0 && (
        <div className="mb-4" data-testid="caveats">
          <Banner tone="warn" title="Read before comparing">
            <ul className="list-disc pl-5">
              {c.caveats.map((t, n) => (
                <li key={n}>{t}</li>
              ))}
            </ul>
          </Banner>
        </div>
      )}
      <ScrollTable id="cmp-risk" title="Residual risk by scenario">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Residual risk level and score for each scenario at each site. Not scored means the scenario had no inputs at that site.</caption>
          {head}
          <tbody>
            <tr>
              <th scope="row" className={thRow}>
                Overall
              </th>
              {c.sites.map((s) => (
                <td key={s.assessmentId} className="border-b-2 border-l-2 border-line p-2">
                  {isUnscored(s) ? <NotScoredBadge /> : <LevelBadge level={s.overall.level} score={s.overall.residual} />}
                </td>
              ))}
            </tr>
            {scenarioIds.map((sid) => (
              <tr key={sid}>
                <th scope="row" className={thRow}>
                  {scenarioName(sid)}
                </th>
                {c.sites.map((s) => {
                  const v = s.byScenario[sid];
                  return v ? (
                    <td key={s.assessmentId} className={"border-b-2 border-l-2 border-line p-2 font-semibold " + LEVEL_CLASS[v.level].cell} data-level={v.level}>
                      <span aria-hidden="true">{LEVEL_MARK[v.level]} </span>
                      {LEVEL_LABEL[v.level]} {formatScore(v.residual)}
                      <span className="block text-base font-normal">from {formatScore(v.inherent)}</span>
                    </td>
                  ) : (
                    <td key={s.assessmentId} className="border-b-2 border-l-2 border-line p-2 text-muted">
                      Not scored
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <ScrollTable id="cmp-findings" title="Findings by severity">
        <table className="w-full border-collapse text-left">
          {head}
          <tbody>
            {SEVERITY_ORDER.map((sev) => (
              <tr key={sev}>
                <th scope="row" className={thRow + " capitalize"}>
                  {sev}
                </th>
                {c.sites.map((s) => (
                  <td key={s.assessmentId} className="border-b-2 border-l-2 border-line p-2 text-xl font-bold">
                    {s.findingsBySeverity[sev] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <p className="text-base text-muted">Method {c.methodVersion}. Residual scores run from 0 to 25 (likelihood times impact, reduced by control effectiveness).</p>
    </>
  );
}

export function CompareScreen() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean).slice(0, MAX_SITES);
  const ready = ids.length >= MIN_SITES && params.get("edit") !== "1";
  const cmp = useAsync(() => (ready ? fetchComparison(api, ids) : Promise.resolve(null)), [api, ids.join(",")]);
  const scenarios = useAsync(() => fetchScenarios(api), [api]);
  const names = new Map((scenarios.data?.data ?? []).map((s) => [s.id, s.name]));
  return (
    <>
      <PageHeader title="Compare sites" back={{ to: "/", label: "Home" }} />
      {!ready ? (
        <Card>
          <Picker initial={ids} onCompare={(next) => setParams({ ids: next.join(",") })} />
        </Card>
      ) : (
        <>
          <div className="mb-4">
            <Button variant="secondary" onClick={() => setParams({ ids: ids.join(","), edit: "1" })}>
              Change selection
            </Button>
          </div>
          {cmp.error ? <Banner tone="error">{errorMessage(cmp.error) || "The comparison could not be loaded."}</Banner> : null}
          {cmp.loading && !cmp.data && <Loading label="Comparing" />}
          {cmp.data && <ComparisonView c={cmp.data.data} scenarioName={(id) => names.get(id) ?? id} />}
        </>
      )}
    </>
  );
}
