/**
 * Risk visuals built from plain HTML (no chart library). Rules: every mark carries its value and
 * level as text, bars start at zero on a fixed 0 to 25 scale so cards compare at a glance, and the
 * whole visual has a one-sentence text alternative.
 */
import type { ReactNode } from "react";
import type { RiskLevel } from "@sentinel/shared";
import { barShare, changeSentence, formatPercent, formatScore, LEVEL_CLASS, LEVEL_LABEL, LEVEL_MARK, SCORE_MAX } from "./levels";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function LevelBadge({ level, score, className }: { level: RiskLevel; score?: number; className?: string }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-md border-2 px-2 py-0.5 text-base font-bold whitespace-nowrap", LEVEL_CLASS[level].chip, className)}
      data-level={level}
    >
      <span aria-hidden="true">{LEVEL_MARK[level]}</span>
      {LEVEL_LABEL[level]}
      {score !== undefined && <span className="font-semibold">{formatScore(score)}</span>}
    </span>
  );
}

function ScoreBar({ label, score, level, max = SCORE_MAX }: { label: string; score: number; level: RiskLevel; max?: number }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2 sm:grid-cols-[8rem_1fr]">
      <span className="font-semibold">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative h-7 min-w-0 flex-1 rounded border-2 border-line bg-surface" aria-hidden="true">
          <div className={cx("h-full rounded-sm", LEVEL_CLASS[level].fill)} style={{ width: `${barShare(score, max) * 100}%` }} />
        </div>
        <LevelBadge level={level} score={score} />
      </div>
    </div>
  );
}

/** Inherent (before controls) and residual (after controls) on the same axis. */
export function BeforeAfter({ inherent, residual }: { inherent: { score: number; level: RiskLevel }; residual: { score: number; level: RiskLevel } }) {
  return (
    <figure className="flex flex-col gap-2" data-testid="before-after">
      <figcaption className="sr-only">{changeSentence(inherent, residual)}</figcaption>
      <ScoreBar label="Inherent" score={inherent.score} level={inherent.level} />
      <ScoreBar label="Residual" score={residual.score} level={residual.level} />
      <p className="text-base text-muted" aria-hidden="true">
        Bars run from 0 to {SCORE_MAX} (likelihood times impact).
      </p>
    </figure>
  );
}

/** A labeled 0 to 100% meter (control effectiveness, coverage). */
export function PercentMeter({ label, value, hint }: { label: string; value: number; hint?: ReactNode }) {
  const pct = formatPercent(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{label}</span>
        <span className="text-xl font-bold">{pct}</span>
      </div>
      <div className="mt-1 h-4 rounded border-2 border-line bg-surface" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-valuetext={pct}>
        <div className="h-full rounded-sm bg-primary" style={{ width: pct }} />
      </div>
      {hint && <p className="mt-1 text-base text-muted">{hint}</p>}
    </div>
  );
}

/** Horizontal bar list for counts (dashboard). Values are printed next to each bar. */
export function CountBars({ items, label }: { items: { key: string; label: string; count: number; fill?: string }[]; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2">
          <span className="font-semibold">{i.label}</span>
          <span className="h-6 rounded border-2 border-line bg-surface" aria-hidden="true">
            <span className={cx("block h-full rounded-sm", i.fill ?? "bg-primary")} style={{ width: `${i.count === 0 ? 0 : Math.max(3, (i.count / max) * 100)}%` }} />
          </span>
          <span className="text-right text-xl font-bold" data-testid={`count-${i.key}`}>{i.count}</span>
        </li>
      ))}
    </ul>
  );
}
