/**
 * Field-ready building blocks. Rules: tap targets at least 48px (56px for primary actions),
 * 18px body text, visible focus rings (see index.css), labels on every input, no hover-only cues.
 */
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "md" | "lg";

const variantClass: Record<Variant, string> = {
  primary: "bg-primary text-on-primary border-2 border-primary",
  secondary: "bg-surface text-ink border-2 border-line",
  danger: "bg-danger text-on-danger border-2 border-danger",
  ghost: "bg-transparent text-primary border-2 border-transparent underline underline-offset-4",
};
const sizeClass: Record<Size, string> = {
  md: "min-h-12 px-4 text-lg",
  lg: "min-h-14 px-6 text-lg",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", block = false) {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-lg font-semibold select-none",
    "active:translate-y-px disabled:opacity-60 disabled:cursor-not-allowed",
    variantClass[variant],
    sizeClass[size],
    block && "w-full",
  );
}

export function Button({
  variant = "primary",
  size = "md",
  block,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; block?: boolean }) {
  return <button type={type} className={cx(buttonClass(variant, size, block), className)} {...rest} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  block,
  className,
  ...rest
}: LinkProps & { variant?: Variant; size?: Size; block?: boolean }) {
  return <Link className={cx(buttonClass(variant, size, block), "no-underline", className)} {...rest} />;
}

const inputClass =
  "block w-full min-h-12 rounded-lg border-2 border-line bg-surface px-3 py-2 text-lg text-ink placeholder:text-muted";

interface FieldBase {
  label: string;
  error?: string;
  hint?: string;
}

function FieldShell({ id, label, error, hint, children }: FieldBase & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-base text-muted">
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className="font-semibold text-danger" role="alert">
          <span aria-hidden="true">! </span>
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, error?: string, hint?: string) =>
  [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;

export function Field({ label, error, hint, id, className, ...rest }: FieldBase & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} error={error} hint={hint}>
      <input
        id={fid}
        className={cx(inputClass, error && "border-danger", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, error, hint)}
        {...rest}
      />
    </FieldShell>
  );
}

export function TextArea({ label, error, hint, id, className, ...rest }: FieldBase & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} error={error} hint={hint}>
      <textarea
        id={fid}
        rows={3}
        className={cx(inputClass, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, error, hint)}
        {...rest}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  error,
  hint,
  id,
  className,
  children,
  ...rest
}: FieldBase & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} error={error} hint={hint}>
      <select id={fid} className={cx(inputClass, className)} aria-describedby={describedBy(fid, error, hint)} {...rest}>
        {children}
      </select>
    </FieldShell>
  );
}

export function Card({ children, className, as: As = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "li" | "article" }) {
  return <As className={cx("rounded-xl border-2 border-line bg-surface p-4", className)}>{children}</As>;
}

type Tone = "neutral" | "physical" | "cyber" | "hybrid" | "warn" | "ok" | "danger" | "primary";
const toneClass: Record<Tone, string> = {
  neutral: "bg-surface text-ink border-line",
  physical: "bg-physical-soft text-physical border-physical",
  cyber: "bg-cyber-soft text-cyber border-cyber",
  hybrid: "bg-hybrid-soft text-hybrid border-hybrid",
  warn: "bg-warn-soft text-warn border-warn",
  ok: "bg-ok-soft text-ok border-ok",
  danger: "bg-danger-soft text-danger border-danger",
  primary: "bg-primary-soft text-ink border-primary",
};

/** Read-only label chip. Always text, never color alone. */
export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-base font-semibold", toneClass[tone], className)}>
      {children}
    </span>
  );
}

/** Two-state toggle button (aria-pressed), used for filters and presets. */
export function Toggle({
  pressed,
  onPressedChange,
  children,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { pressed: boolean; onPressedChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cx(
        "inline-flex min-h-12 items-center gap-2 rounded-full border-2 px-4 text-lg font-semibold",
        pressed ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink",
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true">{pressed ? "✓" : "+"}</span>
      {children}
    </button>
  );
}

export function PageHeader({ title, subtitle, back, actions }: { title: string; subtitle?: ReactNode; back?: { to: string; label: string }; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-col gap-2">
      {back && (
        <Link to={back.to} className="inline-flex min-h-12 items-center gap-1 self-start font-semibold text-primary underline underline-offset-4">
          <span aria-hidden="true">←</span> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold leading-tight">{title}</h1>
          {subtitle && <div className="mt-1 text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-line bg-surface p-6 text-center">
      <h2 className="text-xl font-bold">{title}</h2>
      {children && <div className="mt-2 text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

type BannerTone = "info" | "warn" | "error" | "ok";
const bannerTone: Record<BannerTone, { cls: string; icon: string; label: string }> = {
  info: { cls: "bg-primary-soft border-primary text-ink", icon: "i", label: "Info" },
  warn: { cls: "bg-warn-soft border-warn text-warn", icon: "!", label: "Warning" },
  error: { cls: "bg-danger-soft border-danger text-danger", icon: "×", label: "Error" },
  ok: { cls: "bg-ok-soft border-ok text-ok", icon: "✓", label: "Done" },
};

export function Banner({ tone = "info", title, children, action, live }: { tone?: BannerTone; title?: string; children?: ReactNode; action?: ReactNode; live?: boolean }) {
  const t = bannerTone[tone];
  return (
    <div
      className={cx("flex flex-wrap items-center gap-3 rounded-lg border-2 px-4 py-3 font-semibold", t.cls)}
      role={tone === "error" ? "alert" : live ? "status" : undefined}
    >
      <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-current font-bold">
        {t.icon}
      </span>
      <span className="sr-only">{t.label}: </span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className="font-normal">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="py-6 text-center text-muted">
      {label}…
    </p>
  );
}

export const categoryTone = (c: string): Tone => (c === "physical" ? "physical" : c === "cyber" ? "cyber" : c === "hybrid" ? "hybrid" : "neutral");
export const categoryLabel = (c: string) => (c === "physical" ? "Physical" : c === "cyber" ? "Cyber" : c === "hybrid" ? "Hybrid" : c);

/** Inline logo so it renders on any host page (the web component cannot rely on /icon.svg). */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false" className="shrink-0 rounded-lg">
      <rect width="512" height="512" fill="#0b3d91" />
      <path d="M256 92 L392 140 L392 252 C392 334 334 392 256 424 C178 392 120 334 120 252 L120 140 Z" fill="#ffffff" />
      <path d="M196 262 L240 306 L324 208" fill="none" stroke="#0b3d91" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
