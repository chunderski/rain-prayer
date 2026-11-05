/**
 * Tap-first pickers used by the tagging sheet and the finding editor: severity, controls (search
 * plus suggestions from the walkthrough context), and area.
 */
import { useId, useMemo, useState } from "react";
import type { Area } from "@sentinel/shared";
import type { LocalRecord } from "../offline/db";
import { SEVERITIES, SEVERITY, type SeverityValue } from "../field/labels";
import type { WalkthroughControl } from "../field/schemas";

const pill = (on: boolean) =>
  "inline-flex min-h-12 items-center gap-2 rounded-full border-2 px-4 font-semibold " + (on ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink");

export function SeverityPicker({ value, onChange, allowNone, legend = "Severity" }: { value: SeverityValue | null; onChange: (v: SeverityValue | null) => void; allowNone?: boolean; legend?: string }) {
  return (
    <fieldset>
      <legend className="mb-1 font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {allowNone && (
          <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={pill(value === null)}>
            Not set
          </button>
        )}
        {SEVERITIES.map((s) => (
          <button key={s} type="button" aria-pressed={value === s} onClick={() => onChange(s)} className={pill(value === s)}>
            <span aria-hidden="true">{SEVERITY[s].icon}</span>
            {SEVERITY[s].label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function AreaPicker({ areas, value, onChange }: { areas: LocalRecord<Area>[]; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 font-semibold">Area</legend>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={pill(value === null)}>
          Whole site
        </button>
        {areas.map((a) => (
          <button key={a.id} type="button" aria-pressed={value === a.id} onClick={() => onChange(a.id)} className={pill(value === a.id)}>
            {a.data.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function ControlPicker({
  controls,
  value,
  onChange,
  suggested = [],
  max = 30,
}: {
  controls: Map<string, WalkthroughControl>;
  value: string[];
  onChange: (ids: string[]) => void;
  suggested?: string[];
  max?: number;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const all = useMemo(() => [...controls.values()], [controls]);
  const term = q.trim().toLowerCase();
  const results = term ? all.filter((c) => `${c.id} ${c.title}`.toLowerCase().includes(term)).slice(0, 8) : [];
  const toggle = (cid: string) => onChange(value.includes(cid) ? value.filter((x) => x !== cid) : value.length < max ? [...value, cid] : value);
  const sugg = suggested.filter((s) => controls.has(s) && !value.includes(s));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-semibold">Controls</legend>
      {value.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Selected controls">
          {value.map((cid) => (
            <li key={cid}>
              <button type="button" onClick={() => toggle(cid)} className="flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border-2 border-primary bg-primary-soft px-3 text-left font-semibold">
                <span>{controls.get(cid)?.title ?? cid}</span>
                <span>
                  Remove<span className="sr-only"> {controls.get(cid)?.title ?? cid}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">No controls selected.</p>
      )}
      {sugg.length > 0 && (
        <div>
          <p className="text-base font-semibold text-muted">Suggested from where you are</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {sugg.map((cid) => (
              <button key={cid} type="button" onClick={() => toggle(cid)} className={pill(false)}>
                <span aria-hidden="true">+</span> {controls.get(cid)!.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <label htmlFor={id} className="font-semibold">
        Search controls
      </label>
      <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} className="block min-h-12 w-full rounded-lg border-2 border-line bg-surface px-3 text-lg text-ink" />
      {term && (
        <ul className="flex flex-col gap-2" aria-label="Matching controls">
          {results.length === 0 && <li className="text-muted">No controls match.</li>}
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" aria-pressed={value.includes(c.id)} onClick={() => toggle(c.id)} className={"flex min-h-12 w-full items-center gap-2 rounded-lg border-2 px-3 text-left " + (value.includes(c.id) ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
                <span aria-hidden="true">{value.includes(c.id) ? "✓" : "+"}</span>
                <span>{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
