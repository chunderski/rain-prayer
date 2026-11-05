/**
 * Answer controls for one question, sized for gloves: every option is a 56 px tall button in a
 * labelled group; the selected option is marked with aria-pressed, a check mark, and a filled
 * style (never color alone). Numbers use an on-screen keypad with the unit always shown.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import type { AnswerValue, Question } from "@sentinel/shared";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

function OptionButton({ pressed, onClick, children, describedBy }: { pressed: boolean; onClick: () => void; children: ReactNode; describedBy?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-describedby={describedBy}
      onClick={onClick}
      className={cx(
        "flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-lg border-2 px-3 text-lg font-bold",
        pressed ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink",
      )}
    >
      {pressed && <span aria-hidden="true">✓</span>}
      {children}
    </button>
  );
}

const CHOICES = {
  yes_no_na: [
    ["yes", "Yes"],
    ["no", "No"],
    ["na", "N/A"],
  ],
  yes_partial_no_na: [
    ["yes", "Yes"],
    ["partial", "Partial"],
    ["no", "No"],
    ["na", "N/A"],
  ],
} as const;

export function NumberKeypad({ unit, value, onSave, label }: { unit: string; value: number | undefined; onSave: (n: number) => void; label: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const id = useId();
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const press = (k: string) =>
    setText((t) => {
      if (k === "back") return t.slice(0, -1);
      if (k === "." && t.includes(".")) return t;
      if (t.length >= 12) return t;
      return t === "0" && k !== "." ? k : t + k;
    });
  const n = Number(text);
  const valid = text !== "" && text !== "." && Number.isFinite(n);
  const dirty = valid && n !== value;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        {label} ({unit})
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
          className="block min-h-14 w-full rounded-lg border-2 border-line bg-surface px-3 text-2xl font-bold text-ink"
        />
        <span className="shrink-0 text-xl font-bold" aria-hidden="true">
          {unit}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={`Keypad for ${label}`}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"].map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={k === "back" ? "Delete last digit" : k === "." ? "Decimal point" : undefined}
            className="min-h-14 rounded-lg border-2 border-line bg-surface text-2xl font-bold text-ink"
          >
            {k === "back" ? <span aria-hidden="true">⌫</span> : k}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={!dirty}
        onClick={() => valid && onSave(n)}
        className="min-h-14 rounded-lg border-2 border-primary bg-primary px-4 text-lg font-bold text-on-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {value !== undefined && !dirty ? `Saved: ${value} ${unit}` : `Save ${valid ? `${n} ${unit}` : "measurement"}`}
      </button>
    </div>
  );
}

export function AnswerInput({ question, value, onChange }: { question: Question; value: AnswerValue | undefined; onChange: (v: AnswerValue) => void }) {
  const legendId = useId();
  const q = question;
  let body: ReactNode = null;

  if (q.answerType === "yes_no_na" || q.answerType === "yes_partial_no_na") {
    const current = value?.kind === "choice" ? value.value : undefined;
    body = (
      <div className={cx("grid gap-2", q.answerType === "yes_no_na" ? "grid-cols-3" : "grid-cols-2 min-[400px]:grid-cols-4")}>
        {CHOICES[q.answerType].map(([v, label]) => (
          <OptionButton key={v} pressed={current === v} onClick={() => onChange({ kind: "choice", value: v })}>
            {label}
          </OptionButton>
        ))}
      </div>
    );
  } else if (q.answerType === "scale" && q.scale) {
    const current = value?.kind === "scale" ? value.value : undefined;
    const values = Array.from({ length: q.scale.max - q.scale.min + 1 }, (_, i) => q.scale!.min + i);
    const anchor = (v: number) => q.scale!.anchors.find((a) => a.value === v);
    const selected = current !== undefined ? anchor(current) : undefined;
    body = (
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2">
          {values.map((v) => {
            const a = anchor(v);
            return (
              <OptionButton key={v} pressed={current === v} onClick={() => onChange({ kind: "scale", value: v })}>
                <span className="flex w-full items-baseline gap-2 text-left">
                  <span className="text-xl">{v}</span>
                  {a && <span className="font-semibold">{a.label}</span>}
                </span>
              </OptionButton>
            );
          })}
        </div>
        {selected && (
          <p className="rounded-lg border-2 border-line bg-surface p-3 text-base" aria-live="polite">
            <strong>{selected.label}:</strong> {selected.description}
          </p>
        )}
      </div>
    );
  } else if (q.answerType === "number") {
    const unit = q.unit ?? "";
    body = <NumberKeypad unit={unit} label={q.text} value={value?.kind === "number" ? value.value : undefined} onSave={(n) => onChange({ kind: "number", value: n, unit })} />;
  } else if (q.answerType === "single_select" || q.answerType === "multi_select") {
    const current = value?.kind === "select" ? value.values : [];
    const multi = q.answerType === "multi_select";
    body = (
      <div className="flex flex-col gap-2">
        {(q.options ?? []).map((o) => {
          const pressed = current.includes(o.value);
          return (
            <OptionButton
              key={o.value}
              pressed={pressed}
              onClick={() => {
                const next = multi ? (pressed ? current.filter((x) => x !== o.value) : [...current, o.value]) : [o.value];
                if (next.length) onChange({ kind: "select", values: next });
              }}
            >
              {o.label}
            </OptionButton>
          );
        })}
      </div>
    );
  } else {
    const current = value?.kind === "text" ? value.value : "";
    body = <TextAnswer initial={current} label={q.text} onSave={(t) => onChange({ kind: "text", value: t })} />;
  }

  return (
    <fieldset className="flex flex-col gap-2" aria-labelledby={legendId}>
      <legend id={legendId} className="sr-only">
        {q.text}
      </legend>
      {body}
    </fieldset>
  );
}

function TextAnswer({ initial, label, onSave }: { initial: string; label: string; onSave: (t: string) => void }) {
  const [t, setT] = useState(initial);
  const id = useId();
  useEffect(() => setT(initial), [initial]);
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        value={t}
        onChange={(e) => setT(e.target.value)}
        onBlur={() => t !== initial && onSave(t)}
        className="block min-h-12 w-full rounded-lg border-2 border-line bg-surface px-3 py-2 text-lg text-ink"
      />
    </>
  );
}
