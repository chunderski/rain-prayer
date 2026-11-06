/**
 * Quotes for one assessment: list, "Create quote from findings", and the quote editor. Totals are
 * computed live with quoteTotals and unitPrice from @sentinel/shared (D-080), the same functions
 * the API stores, so what the estimator sees is what gets saved. Only drafts are editable.
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { quoteTotals, unitPrice, type Quote, type QuoteInput, type QuoteLine, type Tier, type TierTotals } from "@sentinel/shared";
import { ApiError } from "../api/client";
import { type PriceBookEntry, createQuote, fetchPriceBook, fetchQuote, fetchQuoteCsv, fetchQuotePreview, fetchQuotes, money, putQuote, QUOTE_STATUS_LABEL, quoteAction, TIER_LABEL } from "../api/phase4";
import { useApi, useCanAdmin, useCanWrite, useIsOwner } from "../auth/AuthContext";
import { useField } from "../field/FieldContext";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Banner, Button, ButtonLink, Card, Chip, EmptyState, Field, Loading, PageHeader, SelectField, TextArea } from "../components/ui";
import { previewDocument } from "./Report";
import { UNIT_LABEL } from "./PriceBook";

const TIERS: Tier[] = ["good", "better", "best"];
const STATUS_TONE: Record<Quote["status"], "neutral" | "warn" | "ok" | "primary" | "danger"> = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "primary",
  sent: "primary",
  accepted: "ok",
  declined: "danger",
  expired: "neutral",
};

const ACTION_ERROR: Record<string, string> = {
  lines_need_pricing: "Some lines still need pricing. Price them or remove them, then submit.",
  quote_locked: "This quote is no longer a draft, so it cannot be changed. Use Revise to make a new draft.",
  forbidden: "Your role cannot do that.",
  invalid_transition: "That step is not possible in the quote's current status. Refresh the page.",
};
const actionError = (e: unknown) => (e instanceof ApiError ? (ACTION_ERROR[e.code] ?? e.message) : errorMessage(e) || "That did not work. Try again.");

export const toInput = (q: Quote): QuoteInput => ({ title: q.title, laborRate: q.laborRate, validUntil: q.validUntil, tiers: q.tiers, notes: q.notes, terms: q.terms, lines: q.lines });

/** Any tier under the minimum margin (the API's rule for owner approval). */
export const belowMinimum = (totals: TierTotals[], minMarginPct: number) => totals.filter((t) => t.marginPct < minMarginPct).map((t) => t.tier);

// ---------- list and create ----------

export function QuotesScreen() {
  const f = useField();
  const api = useApi();
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const list = useAsync(() => fetchQuotes(api, f.assessmentId), [api, f.assessmentId]);
  const [title, setTitle] = useState("");
  const [tiers, setTiers] = useState<Tier[]>(TIERS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/assessments/${f.assessmentId}`;
  const confirmed = f.findings.filter((x) => x.data.status === "confirmed").length;
  const complete = f.assessment.status === "complete";

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!tiers.length) return setError("Choose at least one option tier.");
    setBusy(true);
    setError(null);
    try {
      const q = await createQuote(api, f.assessmentId, { ...(title.trim() ? { title: title.trim() } : {}), tiers: TIERS.filter((t) => tiers.includes(t)) });
      navigate(`${base}/quotes/${q.id}`);
    } catch (err) {
      setError(actionError(err));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Quotes" subtitle={f.assessment.title} back={{ to: base, label: "Assessment" }} />
      {canWrite && (
        <Card as="section" className="mb-4 border-primary">
          <h2 className="text-2xl font-bold">Create quote from findings</h2>
          <p className="mt-1">
            Lines are suggested from this assessment's confirmed findings and your price book. Findings with no matching item get a line marked "Needs pricing". Nothing reaches the client until the quote is submitted, approved, and sent.
          </p>
          {!complete && (
            <div className="mt-2">
              <Banner tone="info">Finish and complete the assessment to create a quote.</Banner>
            </div>
          )}
          {complete && confirmed === 0 && (
            <div className="mt-2">
              <Banner tone="warn">There are no confirmed findings to quote yet. Confirm findings in the assessment first, or add lines by hand.</Banner>
            </div>
          )}
          <form onSubmit={create} noValidate className="mt-3 flex flex-col gap-3">
            <Field label="Quote title (optional)" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} hint="Defaults to the assessment title." />
            <fieldset className="m-0 border-0 p-0">
              <legend className="font-semibold">Options to offer</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {TIERS.map((t) => (
                  <label key={t} className="flex min-h-12 items-center gap-2 rounded-lg border-2 border-line px-3">
                    <input type="checkbox" className="size-6" checked={tiers.includes(t)} onChange={(e) => setTiers(e.target.checked ? [...tiers, t] : tiers.filter((x) => x !== t))} />
                    {TIER_LABEL[t]}
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <Banner tone="error">{error}</Banner>}
            <Button type="submit" size="lg" block disabled={busy || !f.online || !complete}>
              {busy ? "Creating" : "Create quote"}
            </Button>
          </form>
        </Card>
      )}
      <h2 className="mb-2 text-2xl font-bold">Quotes for this assessment</h2>
      {list.loading && !list.data && <Loading label="Loading quotes" />}
      {list.error ? <Banner tone="error">{errorMessage(list.error) || "Quotes could not be loaded."}</Banner> : null}
      {list.data && list.data.length === 0 && <EmptyState title="No quotes yet">Create one from the findings above.</EmptyState>}
      <ul className="flex flex-col gap-3">
        {(list.data ?? []).map((q) => {
          const top = q.totals.map((t) => `${TIER_LABEL[t.tier]} ${money(t.price)}`).join(", ");
          return (
            <li key={q.id}>
              <ButtonLink to={`${base}/quotes/${q.id}`} variant="secondary" block className="!justify-between py-2 text-left">
                <span>
                  <span className="block font-bold">
                    {q.number}: {q.title}
                  </span>
                  <span className="block text-base font-normal">{top}</span>
                </span>
                <Chip tone={STATUS_TONE[q.status]}>{QUOTE_STATUS_LABEL[q.status]}</Chip>
              </ButtonLink>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------- editor pieces ----------

/** Number input that lets people type freely ("1.", "") and reports only valid numbers. */
function NumField({ label, value, onChange, min = 0, max, step = "any", disabled, hint }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: string; disabled?: boolean; hint?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = Number(text);
  const bad = text.trim() === "" || !Number.isFinite(n) || n < min || (max !== undefined && n > max);
  return (
    <Field
      label={label}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={text}
      disabled={disabled}
      hint={hint}
      error={bad ? (max !== undefined ? `Enter ${min} to ${max}.` : `Enter ${min} or more.`) : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= min && (max === undefined || v <= max)) onChange(v);
      }}
    />
  );
}

function LineCard({ line, laborRate, tiers, editable, placeholder, onChange, onRemove }: { line: QuoteLine; laborRate: number; tiers: Tier[]; editable: boolean; placeholder: boolean; onChange: (l: QuoteLine) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(line.needsPricing && editable);
  const uid = useId();
  const up = unitPrice(line, laborRate);
  const set = (p: Partial<QuoteLine>) => {
    const next = { ...line, ...p };
    // A needs-pricing line counts as priced once it has a cost or labor (D-new).
    if (next.needsPricing && (next.materialCost > 0 || next.laborHours > 0)) next.needsPricing = false;
    onChange(next);
  };
  return (
    <li className={"rounded-xl border-2 bg-surface p-3 " + (line.needsPricing ? "border-warn bg-warn-soft" : "border-line")} data-testid="quote-line">
      <button type="button" aria-expanded={open} aria-controls={`${uid}-body`} onClick={() => setOpen(!open)} className="flex min-h-12 w-full flex-wrap items-center justify-between gap-2 text-left">
        <span className="min-w-0 flex-1 font-semibold">{line.description}</span>
        <span className="text-base">
          {line.quantity} × {money(up)} = <strong>{money(up * line.quantity)}</strong>
        </span>
      </button>
      <div className="mt-1 flex flex-wrap gap-2">
        {line.needsPricing && <Chip tone="warn">! Needs pricing</Chip>}
        {placeholder && <Chip tone="warn">! Placeholder price</Chip>}
        {line.tier === "all" && <Chip>All tiers</Chip>}
        {line.optional && <Chip tone="primary">Optional add-on</Chip>}
        <span aria-hidden="true" className="text-base font-semibold text-primary underline underline-offset-4">
          {open ? "Hide fields" : editable ? "Edit line" : "Show details"}
        </span>
      </div>
      {line.needsPricing && <p className="mt-1 text-base">No price book item fixes this finding yet. Add an item or enter a price.</p>}
      <div id={`${uid}-body`} hidden={!open}>
        {open && (
          <fieldset disabled={!editable} className="m-0 mt-3 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-2 lg:grid-cols-3">
            <legend className="sr-only">Line: {line.description}</legend>
            <div className="sm:col-span-2 lg:col-span-3">
              <Field label="Description" value={line.description} maxLength={500} onChange={(e) => set({ description: e.target.value })} error={line.description.trim() ? undefined : "Enter a description."} />
            </div>
            <NumField label={`Quantity (${UNIT_LABEL[line.unit] ?? line.unit})`} hint="Check quantity" value={line.quantity} max={100000} onChange={(quantity) => set({ quantity })} />
            <NumField label="Material cost per unit (USD)" value={line.materialCost} max={10000000} onChange={(materialCost) => set({ materialCost })} />
            <NumField label="Labor hours per unit" value={line.laborHours} max={1000} onChange={(laborHours) => set({ laborHours })} />
            <NumField label="Margin (%)" value={line.marginPct} max={95} onChange={(marginPct) => set({ marginPct })} />
            <SelectField label="Tier" value={line.tier} onChange={(e) => set({ tier: e.target.value as QuoteLine["tier"] })}>
              <option value="all">All tiers</option>
              {tiers.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABEL[t]}
                </option>
              ))}
            </SelectField>
            <label className="flex min-h-12 items-center gap-3 self-end">
              <input type="checkbox" className="size-6" checked={line.optional} onChange={(e) => set({ optional: e.target.checked })} />
              <span className="font-semibold">Optional add-on</span>
            </label>
            <p className="text-base text-muted sm:col-span-2 lg:col-span-3">
              Unit price {money(up)}: cost {money(line.materialCost + line.laborHours * laborRate)} at {line.marginPct}% margin.
            </p>
            {editable && (
              <div className="sm:col-span-2 lg:col-span-3">
                <Button variant="danger" onClick={onRemove}>
                  Remove line
                </Button>
              </div>
            )}
          </fieldset>
        )}
      </div>
    </li>
  );
}

function TotalsPanel({ totals, minMarginPct }: { totals: TierTotals[]; minMarginPct: number }) {
  return (
    <section aria-labelledby="totals-h" className="mb-4" data-testid="quote-totals">
      <h2 id="totals-h" className="mb-2 text-2xl font-bold">
        Totals
      </h2>
      <ul className="grid gap-3 sm:grid-cols-3">
        {totals.map((t) => {
          const low = t.marginPct < minMarginPct;
          return (
            <li key={t.tier} className={"rounded-xl border-2 p-3 " + (low ? "border-warn bg-warn-soft" : "border-line bg-surface")} data-testid={`totals-${t.tier}`}>
              <p className="text-xl font-bold">{TIER_LABEL[t.tier]}</p>
              <p className="text-2xl font-bold">
                <span className="sr-only">Price </span>
                <span data-testid={`price-${t.tier}`}>{money(t.price)}</span>
              </p>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-base">
                <dt>Materials</dt>
                <dd className="text-right">{money(t.materials)}</dd>
                <dt>Labor</dt>
                <dd className="text-right">{money(t.labor)}</dd>
                <dt>Cost</dt>
                <dd className="text-right">{money(t.cost)}</dd>
                <dt>Margin</dt>
                <dd className="text-right">{money(t.margin)}</dd>
                <dt>Margin %</dt>
                <dd className="text-right font-semibold" data-testid={`margin-${t.tier}`}>
                  {t.marginPct}%
                </dd>
                {t.optionalPrice > 0 && (
                  <>
                    <dt>Optional add-ons</dt>
                    <dd className="text-right">{money(t.optionalPrice)}</dd>
                  </>
                )}
              </dl>
              {low && (
                <p className="mt-2 font-semibold text-warn">
                  <span aria-hidden="true">! </span>Under your {minMarginPct}% minimum: needs owner approval.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-base text-muted">Internal view: cost and margin are never shown to the client.</p>
    </section>
  );
}

function AddFromPriceBook({ tier, items, onAdd }: { tier: QuoteLine["tier"]; items: { data?: PriceBookEntry[]; loading: boolean }; onAdd: (l: QuoteLine) => void }) {
  const [pick, setPick] = useState("");
  const active = (items.data ?? []).filter((i) => i.active);
  function add() {
    const i = active.find((x) => x.id === pick);
    if (!i) return;
    onAdd({ id: crypto.randomUUID(), findingId: null, priceBookItemId: i.id, description: i.description.trim() || i.name, category: i.category, unit: i.unit, quantity: 1, materialCost: i.materialCost, laborHours: i.laborHours, marginPct: i.defaultMarginPct, tier, optional: false, needsPricing: false, sortOrder: 0 });
    setPick("");
  }
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <SelectField label="Add from price book" value={pick} onChange={(e) => setPick(e.target.value)}>
        <option value="">{items.loading ? "Loading items" : "Choose an item"}</option>
        {active.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name} ({i.sku}){i.fromTemplate ? ", placeholder price" : ""}
          </option>
        ))}
      </SelectField>
      <Button variant="secondary" disabled={!pick} onClick={add}>
        Add item
      </Button>
    </div>
  );
}

function QuotePreview({ id }: { id: string }) {
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => fetchQuotePreview(api, id), [api, id]);
  const css = new URL("/report-preview.css", import.meta.url).href;
  return (
    <section aria-labelledby="qprev-h" className="mb-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="qprev-h" className="text-2xl font-bold">
          Client preview
        </h2>
        <Button variant="secondary" onClick={reload}>
          Refresh preview
        </Button>
      </div>
      <p className="mb-2 text-muted">What the client sees, from the last saved version. Save first to include recent edits.</p>
      {error ? <Banner tone="error">{errorMessage(error) || "The preview could not be loaded."}</Banner> : null}
      {loading && !data && <Loading label="Building preview" />}
      {data !== undefined && (
        // No allow-scripts and no allow-same-origin, like the report preview.
        <iframe title="Quote preview" sandbox="" srcDoc={previewDocument(data, css)} className="h-[70vh] w-full rounded-lg border-2 border-line bg-white" data-testid="quote-preview" />
      )}
    </section>
  );
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  (document.body ?? document.documentElement).append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- editor ----------

export function QuoteEditorScreen() {
  const { quoteId = "" } = useParams();
  const f = useField();
  const titles = useMemo(() => new Map(f.findings.map((x) => [x.id, x.data.title])), [f.findings]);
  return <QuoteEditor quoteId={quoteId} assessmentId={f.assessmentId} findingTitle={(id) => titles.get(id)} />;
}

/** The editor itself, independent of the field layout so it can be tested on its own. */
export function QuoteEditor({ quoteId, assessmentId, findingTitle: titleOf }: { quoteId: string; assessmentId: string; findingTitle: (id: string) => string | undefined }) {
  const api = useApi();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const isAdmin = useCanAdmin();
  const isOwner = useIsOwner();
  const loaded = useAsync(() => fetchQuote(api, quoteId), [api, quoteId]);
  const priceBook = useAsync(() => (canWrite ? fetchPriceBook(api) : Promise.resolve([] as PriceBookEntry[])), [api, canWrite]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [draft, setDraft] = useState<QuoteInput | null>(null);
  const [tab, setTab] = useState<Tier>("good");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const base = `/assessments/${assessmentId}`;

  useEffect(() => {
    if (loaded.data) {
      setQuote(loaded.data);
      setDraft(toInput(loaded.data));
      setTab(loaded.data.tiers[0] ?? "good");
    }
  }, [loaded.data]);

  const totals = useMemo(() => (draft ? quoteTotals(draft) : []), [draft]);
  if (loaded.error && !quote) return <Banner tone="error">{errorMessage(loaded.error) || "The quote could not be loaded."}</Banner>;
  if (!quote || !draft) return <Loading label="Loading quote" />;

  const editable = canWrite && quote.status === "draft";
  const dirty = JSON.stringify(draft) !== JSON.stringify(toInput(quote));
  const needsPricing = draft.lines.filter((l) => l.needsPricing).length;
  const low = belowMinimum(totals, quote.minMarginPct);
  const templateIds = new Set((priceBook.data ?? []).filter((i) => i.fromTemplate).map((i) => i.id));
  const usesPlaceholder = (l: QuoteLine) => !!l.priceBookItemId && templateIds.has(l.priceBookItemId);
  const placeholderLines = draft.lines.filter(usesPlaceholder).length;
  const findingTitle = (id: string | null) => (id ? (titleOf(id) ?? "Finding") : "Other items");
  const setLines = (lines: QuoteLine[]) => setDraft({ ...draft, lines: lines.map((l, n) => ({ ...l, sortOrder: n })) });
  const tabLines = draft.lines.filter((l) => l.tier === "all" || l.tier === tab);
  const groups: { findingId: string | null; lines: QuoteLine[] }[] = [];
  for (const l of tabLines) {
    const g = groups.find((x) => x.findingId === l.findingId);
    if (g) g.lines.push(l);
    else groups.push({ findingId: l.findingId, lines: [l] });
  }

  async function save(): Promise<Quote | null> {
    if (!draft || !quote) return null;
    if (draft.lines.some((l) => !l.description.trim())) {
      setMsg({ tone: "error", text: "Every line needs a description." });
      return null;
    }
    const q = await putQuote(api, quote.id, draft);
    setQuote(q);
    setDraft(toInput(q));
    return q;
  }

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: "error", text: actionError(e) });
    } finally {
      setBusy(null);
    }
  }

  const onSave = () =>
    run("save", async () => {
      if (await save()) setMsg({ tone: "ok", text: "Draft saved." });
    });
  const onSubmit = () =>
    run("submit", async () => {
      if (dirty && !(await save())) return;
      const q = await quoteAction(api, quote.id, { action: "submit" });
      setQuote(q);
      setDraft(toInput(q));
      setMsg(q.status === "pending_approval" ? { tone: "warn", text: "Submitted. The margin is below the minimum, so an owner must approve it before it can be sent." } : { tone: "ok", text: "Submitted and approved. An admin can now send it to the client." });
    });
  const act = (action: "approve" | "send", ok: string) =>
    run(action, async () => {
      const q = await quoteAction(api, quote.id, { action });
      setQuote(q);
      setDraft(toInput(q));
      setMsg({ tone: "ok", text: ok });
    });
  const onRevise = () =>
    run("revise", async () => {
      const q = await quoteAction(api, quote.id, { action: "revise" });
      navigate(`${base}/quotes/${q.id}`);
    });
  const onCsv = () =>
    run("csv", async () => {
      download(await fetchQuoteCsv(api, quote.id), `${quote.number}.csv`);
    });

  return (
    <>
      <PageHeader
        title={`Quote ${quote.number}`}
        back={{ to: `${base}/quotes`, label: "Quotes" }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={STATUS_TONE[quote.status]}>{QUOTE_STATUS_LABEL[quote.status]}</Chip>
            <span>{quote.title}</span>
          </span>
        }
      />
      {!editable && quote.status !== "draft" && (
        <div className="mb-3">
          <Banner tone={quote.status === "expired" ? "warn" : "info"}>
            {quote.status === "expired" ? `This quote expired on ${new Date(quote.validUntil + "T00:00:00").toLocaleDateString()}. Revise it to send an updated proposal.` : "This quote is locked because it has been submitted. Revise it to make changes."}
            {quote.respondedBy && quote.respondedAt ? ` ${quote.status === "accepted" ? "Accepted" : "Declined"} by ${quote.respondedBy} on ${new Date(quote.respondedAt).toLocaleString()}.` : ""}
          </Banner>
        </div>
      )}
      {editable && needsPricing > 0 && (
        <div className="mb-3">
          <Banner tone="warn" title="Needs pricing">
            Price or remove the {needsPricing} {needsPricing === 1 ? "line" : "lines"} marked Needs pricing before submitting.
          </Banner>
        </div>
      )}
      {editable && low.length > 0 && (
        <div className="mb-3">
          <Banner tone="warn" title="Below the minimum margin">
            {low.map((t) => `The ${TIER_LABEL[t]} tier margin is ${totals.find((x) => x.tier === t)?.marginPct ?? 0}%, under your ${quote.minMarginPct}% minimum.`).join(" ")} Submitting will send this quote to an owner for approval.
          </Banner>
        </div>
      )}
      {editable && placeholderLines > 0 && (
        <div className="mb-3">
          <Banner tone="warn" title="Placeholder prices">
            This quote uses placeholder prices from the starter price book. Check them before you submit.
          </Banner>
        </div>
      )}

      <Card as="section" className="mb-4">
        <h2 className="text-2xl font-bold">Details</h2>
        <fieldset disabled={!editable} className="m-0 mt-3 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-3">
          <legend className="sr-only">Quote details</legend>
          <div className="sm:col-span-3">
            <Field label="Title" value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <NumField label="Labor rate (USD per hour)" value={draft.laborRate} max={10000000} onChange={(laborRate) => setDraft({ ...draft, laborRate })} />
          <Field label="Valid until" type="date" value={draft.validUntil} onChange={(e) => e.target.value && setDraft({ ...draft, validUntil: e.target.value })} />
          <div className="sm:col-span-3">
            <details className="rounded-lg border-2 border-line">
              <summary className="flex min-h-12 cursor-pointer items-center px-3 font-semibold text-primary underline underline-offset-4">Notes and terms</summary>
              <div className="flex flex-col gap-3 p-3">
                <TextArea label="Notes for the client" value={draft.notes} maxLength={4000} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                <TextArea label="Terms" value={draft.terms} maxLength={4000} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} />
              </div>
            </details>
          </div>
        </fieldset>
      </Card>

      <TotalsPanel totals={totals} minMarginPct={quote.minMarginPct} />

      <section aria-labelledby="lines-h" className="mb-4">
        <h2 id="lines-h" className="mb-2 text-2xl font-bold">
          Lines by finding
        </h2>
        {draft.tiers.length > 1 && (
          <div role="tablist" aria-label="Option tier" className="mb-3 flex gap-2">
            {draft.tiers.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls="tier-panel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={(e) => {
                  const i = draft.tiers.indexOf(tab);
                  const next = e.key === "ArrowRight" ? draft.tiers[(i + 1) % draft.tiers.length] : e.key === "ArrowLeft" ? draft.tiers[(i - 1 + draft.tiers.length) % draft.tiers.length] : null;
                  if (next) {
                    setTab(next);
                    (e.currentTarget.parentElement?.querySelector(`#tab-${next}`) as HTMLElement | null)?.focus();
                  }
                }}
                className={"flex min-h-12 flex-1 flex-col items-center justify-center rounded-lg border-2 px-3 font-semibold sm:flex-none " + (tab === t ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink")}
              >
                {TIER_LABEL[t]}
                <span className="text-base font-normal">{money(totals.find((x) => x.tier === t)?.price ?? 0)}</span>
              </button>
            ))}
          </div>
        )}
        <div id="tier-panel" role={draft.tiers.length > 1 ? "tabpanel" : undefined} aria-labelledby={draft.tiers.length > 1 ? `tab-${tab}` : undefined}>
          {groups.length === 0 && <p className="text-muted">No lines in this option yet.</p>}
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g.findingId ?? "none"} aria-label={findingTitle(g.findingId)}>
                <h3 className="mb-2 text-xl font-bold">{g.findingId ? `Finding: ${findingTitle(g.findingId)}` : "Other items"}</h3>
                <ul className="flex flex-col gap-2">
                  {g.lines.map((l) => (
                    <LineCard
                      key={l.id}
                      line={l}
                      laborRate={draft.laborRate}
                      tiers={draft.tiers}
                      editable={editable}
                      placeholder={usesPlaceholder(l)}
                      onChange={(next) => setLines(draft.lines.map((x) => (x.id === l.id ? next : x)))}
                      onRemove={() => setLines(draft.lines.filter((x) => x.id !== l.id))}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {editable && (
            <div className="mt-4 flex flex-col gap-3 rounded-xl border-2 border-dashed border-line p-3">
              <AddFromPriceBook tier={draft.tiers.length > 1 ? tab : "all"} items={priceBook} onAdd={(l) => setLines([...draft.lines, l])} />
              <Button
                variant="secondary"
                onClick={() =>
                  setLines([
                    ...draft.lines,
                    { id: crypto.randomUUID(), findingId: null, priceBookItemId: null, description: "New line", category: "service", unit: "each", quantity: 1, materialCost: 0, laborHours: 1, marginPct: 35, tier: draft.tiers.length > 1 ? tab : "all", optional: false, needsPricing: false, sortOrder: 0 },
                  ])
                }
              >
                Add custom line
              </Button>
            </div>
          )}
        </div>
      </section>

      {msg && (
        <div className="mb-3">
          <Banner tone={msg.tone} live>
            {msg.text}
          </Banner>
        </div>
      )}
      <section aria-label="Quote actions" className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {editable && (
          <>
            <Button variant="secondary" size="lg" disabled={!!busy || !dirty} onClick={() => void onSave()}>
              {busy === "save" ? "Saving" : dirty ? "Save draft" : "Saved"}
            </Button>
            <Button size="lg" disabled={!!busy || needsPricing > 0} onClick={() => void onSubmit()}>
              {busy === "submit" ? "Submitting" : low.length ? "Submit for approval" : "Submit"}
            </Button>
          </>
        )}
        {quote.status === "pending_approval" && isOwner && (
          <Button size="lg" disabled={!!busy} onClick={() => void act("approve", "Approved. An admin can now send it to the client.")}>
            Approve quote
          </Button>
        )}
        {quote.status === "pending_approval" && !isOwner && <p className="self-center font-semibold">Waiting for an owner to approve the margin.</p>}
        {quote.status === "approved" && isAdmin && (
          <Button size="lg" disabled={!!busy} onClick={() => void act("send", "Sent. The client can now see it in their portal.")}>
            Send to client
          </Button>
        )}
        {quote.status !== "draft" && canWrite && (
          <Button variant="secondary" size="lg" disabled={!!busy} onClick={() => void onRevise()}>
            Revise
          </Button>
        )}
        <Button variant="secondary" size="lg" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>
          {showPreview ? "Hide preview" : "Preview"}
        </Button>
        <Button variant="secondary" size="lg" disabled={!!busy} onClick={() => void onCsv()}>
          Download CSV
        </Button>
      </section>
      {showPreview && <QuotePreview id={quote.id} />}
    </>
  );
}
