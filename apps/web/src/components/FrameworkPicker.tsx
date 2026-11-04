import { useEffect, useId, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import { fetchControls } from "../api/library";
import type { ControlSummary, FrameworkSummary } from "../api/schemas";
import { Chip, categoryLabel, categoryTone } from "./ui";
import { PRESETS, computeCoverage, presetSelection, sameSet } from "./coverage";

export interface FrameworkPickerProps {
  frameworks: FrameworkSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
  /** Controls per framework id (GET /controls?framework=id); undefined while loading. */
  controlsByFramework: Record<string, ControlSummary[] | undefined>;
  error?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function FrameworkPicker({ frameworks, value, onChange, controlsByFramework, error }: FrameworkPickerProps) {
  const legendId = useId();
  const errorId = useId();
  const available = frameworks.map((f) => f.id);
  const coverage = computeCoverage(value, controlsByFramework);

  const toggle = (id: string, checked: boolean) => {
    const next = checked ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id);
    // Keep library order so the summary and review read predictably.
    onChange(available.filter((a) => next.includes(a)));
  };

  let summary: string;
  if (value.length === 0) summary = "No frameworks selected yet. Pick one or more, or start from a preset.";
  else if (!coverage.complete) summary = `${plural(value.length, "framework")} selected. Counting shared controls…`;
  else
    summary =
      `${plural(value.length, "framework")} selected: ${plural(coverage.controlCount, "shared control")} to check, ` +
      `${coverage.overlapCount} of them ${coverage.overlapCount === 1 ? "counts" : "count"} toward more than one framework.`;

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby={`${legendId}-presets`} className="flex flex-col gap-2">
        <h2 id={`${legendId}-presets`} className="text-xl font-bold">
          Quick presets
        </h2>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const ids = presetSelection(p, available);
            const active = ids.length > 0 && sameSet(ids, value);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                disabled={ids.length === 0}
                onClick={() => onChange(available.filter((a) => ids.includes(a)))}
                className={
                  "flex min-h-14 flex-col items-start justify-center rounded-lg border-2 px-4 py-2 text-left " +
                  (active ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink")
                }
              >
                <span className="font-bold">
                  {active && <span aria-hidden="true">✓ </span>}
                  {p.label}
                </span>
                <span className="text-base">{p.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <fieldset aria-describedby={error ? errorId : undefined} className="flex flex-col gap-3">
        <legend id={legendId} className="mb-2 text-xl font-bold">
          Frameworks for this assessment
        </legend>
        {error && (
          <p id={errorId} role="alert" className="font-semibold text-danger">
            <span aria-hidden="true">! </span>
            {error}
          </p>
        )}
        <ul className="grid gap-3 sm:grid-cols-2">
          {frameworks.map((f) => {
            const checked = value.includes(f.id);
            const nameId = `${legendId}-${f.id}-name`;
            const descId = `${legendId}-${f.id}-desc`;
            return (
              <li key={f.id}>
                <label
                  className={
                    "flex h-full min-h-14 cursor-pointer gap-3 rounded-xl border-[3px] bg-surface p-4 " +
                    "has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus " +
                    (checked ? "border-primary bg-primary-soft" : "border-line")
                  }
                  data-testid={`framework-card-${f.id}`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 size-7 shrink-0 accent-[var(--sa-primary)]"
                    checked={checked}
                    onChange={(e) => toggle(f.id, e.target.checked)}
                    aria-labelledby={nameId}
                    aria-describedby={descId}
                    value={f.id}
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span id={nameId} className="text-xl font-bold">
                        {f.shortName}
                      </span>
                      <Chip tone={categoryTone(f.category)}>{categoryLabel(f.category)}</Chip>
                      {checked && <span className="font-semibold text-ink">Selected</span>}
                    </span>
                    <span id={descId} className="flex flex-col gap-1">
                      <span>{f.description}</span>
                      <span className="text-base text-muted">
                        {plural(f.requirementCount, "requirement")} · version {f.version}
                      </span>
                      {f.needsReviewCount > 0 && (
                        <span className="text-base font-semibold text-warn">
                          <span aria-hidden="true">! </span>
                          {f.needsReviewCount} {f.needsReviewCount === 1 ? "item needs" : "items need"} expert review
                        </span>
                      )}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div role="status" aria-live="polite" className="rounded-xl border-2 border-primary bg-primary-soft p-4" data-testid="picker-summary">
        <p className="font-bold">{summary}</p>
        {value.length > 0 && coverage.complete && (
          <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-base text-muted">Shared controls</dt>
              <dd className="text-2xl font-bold">{coverage.controlCount}</dd>
            </div>
            <div>
              <dt className="text-base text-muted">Overlapping</dt>
              <dd className="text-2xl font-bold">{coverage.overlapCount}</dd>
            </div>
            <div>
              <dt className="text-base text-muted">Questions</dt>
              <dd className="text-2xl font-bold">{coverage.questionCount}</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}

/** Loads GET /controls?framework=id for each selected framework once (cached offline). */
export function useControlsForFrameworks(api: ApiClient, ids: string[]) {
  const [map, setMap] = useState<Record<string, ControlSummary[] | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = ids.join(",");
  useEffect(() => {
    for (const id of ids) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      fetchControls(api, { framework: id }).then(
        (r) => mounted.current && setMap((m) => ({ ...m, [id]: r.data })),
        () => {
          requested.current.delete(id);
          if (mounted.current) setError("Could not load controls for every framework. Counts may be incomplete.");
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  return { controlsByFramework: map, error };
}
