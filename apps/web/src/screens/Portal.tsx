/**
 * Client portal: the whole app for a client_viewer (D-081). A separate, simpler shell: branded,
 * read-only, no field tools, no sync, no PIN prompt. Shows completed assessments, risk summary,
 * confirmed findings, the approved report, and proposals with Accept and Decline. Only prices are
 * parsed from quotes (PortalQuote), never internal cost or margin.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import type { Tier } from "@sentinel/shared";
import { ApiError } from "../api/client";
import {
  fetchPortalAssessment,
  fetchPortalAssessments,
  fetchPortalQuote,
  fetchPortalQuotePreview,
  fetchPortalReport,
  money,
  QUOTE_STATUS_LABEL,
  respondToQuote,
  TIER_LABEL,
  type PortalFinding,
  type PortalQuote,
} from "../api/phase4";
import { useApi, useAuth } from "../auth/AuthContext";
import { BrandMark, useBranding, useBrandName } from "../branding/BrandingContext";
import { errorMessage, useAsync } from "../lib/useAsync";
import { SEVERITY, type SeverityValue } from "../field/labels";
import { frameworkName } from "../field/labels";
import { CONFIDENCE_LABEL, formatScore, isUnscored } from "../risk/levels";
import { LevelBadge, NotScoredBadge } from "../risk/RiskViz";
import { OfflineBanner } from "../components/AppShell";
import { Banner, Button, Card, Chip, EmptyState, Field, Loading, PageHeader, TextArea } from "../components/ui";
import { previewDocument } from "./Report";
import { scenarioReason } from "./RiskResults";

const fmtDate = (iso: string | null) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const SEV_ORDER: SeverityValue[] = ["critical", "high", "medium", "low", "info"];

function openCounts(counts: Record<string, number>) {
  const parts = SEV_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => `${counts[s]} ${SEVERITY[s].label.toLowerCase()}`);
  return parts.length ? `Open findings: ${parts.join(", ")}` : "No open findings";
}

function PortalShell({ children }: { children: ReactNode }) {
  const { signOut, session } = useAuth();
  const { branding } = useBranding();
  const name = useBrandName();
  const contact = [branding?.contactEmail, branding?.contactPhone, branding?.website].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-lg text-ink" data-shell="portal">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-3">
        Skip to content
      </a>
      <header className="border-b-4 border-primary bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2">
          <Link to="/" className="flex min-h-12 min-w-0 items-center gap-2 text-ink no-underline">
            <BrandMark size={40} />
            <span className="min-w-0">
              <span className="block font-bold leading-tight" data-testid="brand-name">
                {name}
              </span>
              <span className="block truncate text-base text-muted">Client portal{session ? ` for ${session.user.name}` : ""}</span>
            </span>
          </Link>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <OfflineBanner />
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-5">
        {children}
      </main>
      <footer className="border-t-2 border-line bg-surface px-4 py-4 text-base">
        <div className="mx-auto max-w-4xl">
          {branding?.reportFooter && <p>{branding.reportFooter}</p>}
          {contact && <p>{contact}</p>}
          {(branding?.showPoweredBy ?? true) && <p className="text-muted">Powered by Sentinel Assess</p>}
        </div>
      </footer>
    </div>
  );
}

function PortalHome() {
  const api = useApi();
  const list = useAsync(() => fetchPortalAssessments(api), [api]);
  return (
    <>
      <PageHeader title="Your security assessments" />
      {list.loading && !list.data && <Loading label="Loading assessments" />}
      {list.error ? <Banner tone="error">{errorMessage(list.error) || "Assessments could not be loaded."}</Banner> : null}
      {list.data && list.data.length === 0 && <EmptyState title="Nothing here yet">No completed assessments yet. Your security provider will share results here when they are ready.</EmptyState>}
      <ul className="flex flex-col gap-4">
        {(list.data ?? []).map((a) => (
          <li key={a.id}>
            <Card as="article">
              <h2 className="text-2xl font-bold">
                <Link to={`/portal/assessments/${a.id}`} className="text-primary underline underline-offset-4">
                  {a.title}
                </Link>
              </h2>
              <p className="text-muted">
                {a.siteName}
                {a.completedAt ? `, completed ${fmtDate(a.completedAt)}` : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold">Overall residual risk</span>
                {a.overall ? <LevelBadge level={a.overall.level} score={a.overall.residual} /> : <NotScoredBadge />}
              </div>
              <p className="mt-1">{openCounts(a.openFindings)}</p>
              <h3 className="mt-3 font-bold">Proposals</h3>
              {a.quotes.length === 0 ? (
                <p className="text-muted">No proposals yet.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-2">
                  {a.quotes.map((q) => (
                    <li key={q.id} className="flex flex-wrap items-center gap-2">
                      <Link to={`/portal/quotes/${q.id}`} className="inline-flex min-h-12 items-center font-semibold text-primary underline underline-offset-4">
                        {q.number}: {q.title}
                      </Link>
                      <Chip tone={q.status === "accepted" ? "ok" : q.status === "sent" ? "primary" : "neutral"}>{QUOTE_STATUS_LABEL[q.status]}</Chip>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}

function FindingCard({ f }: { f: PortalFinding }) {
  const [open, setOpen] = useState(false);
  const sev = SEVERITY[f.severity as SeverityValue] ?? SEVERITY.info;
  const id = `pf-${f.id}`;
  return (
    <li className="rounded-xl border-2 border-line bg-surface p-3">
      <h3 className="font-bold">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex min-h-12 w-full items-center justify-between gap-2 text-left">
          <span>{f.title}</span>
          <span aria-hidden="true" className="shrink-0 text-base text-primary underline underline-offset-4">
            {open ? "Hide ▴" : "Details ▾"}
          </span>
        </button>
      </h3>
      <Chip tone={sev.tone}>
        <span aria-hidden="true">{sev.icon}</span> {sev.label}
      </Chip>
      <div id={id} hidden={!open} className="mt-2">
        {open && (
          <>
            {f.description && <p>{f.description}</p>}
            {f.recommendation && (
              <p className="mt-2">
                <strong>Recommendation:</strong> {f.recommendation}
              </p>
            )}
            {f.frameworks.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="Counts toward">
                {f.frameworks.map((m) => {
                  const short = m.frameworkShortName ?? m.shortName ?? frameworkName(m.frameworkId);
                  return (
                    <li key={`${m.frameworkId}:${m.requirementCode}`}>
                      <Chip tone="primary">{m.requirementTitle ? `${short}: ${m.requirementTitle} (${m.requirementCode})` : `${short}: ${m.requirementCode}`}</Chip>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function HtmlPreview({ title, load, testId }: { title: string; load: () => Promise<string>; testId: string }) {
  const { data, error, loading } = useAsync(load, [load]);
  const css = new URL("/report-preview.css", import.meta.url).href;
  if (error) return <Banner tone="error">{errorMessage(error) || `${title} could not be loaded.`}</Banner>;
  if (loading && data === undefined) return <Loading label={`Loading ${title.toLowerCase()}`} />;
  // Sandboxed with no permissions, like the report preview in the workspace.
  return <iframe title={title} sandbox="" srcDoc={previewDocument(data ?? "", css)} className="h-[70vh] w-full rounded-lg border-2 border-line bg-white" data-testid={testId} />;
}

function PortalAssessmentScreen() {
  const { id = "" } = useParams();
  const api = useApi();
  const d = useAsync(() => fetchPortalAssessment(api, id), [api, id]);
  const [showReport, setShowReport] = useState(false);
  const [loadReport] = useState(() => () => fetchPortalReport(api, id));
  if (d.error) return <Banner tone="error">{errorMessage(d.error) || "This assessment could not be loaded."}</Banner>;
  if (!d.data) return <Loading label="Loading assessment" />;
  const { assessment: a, risk, findings } = d.data;
  const scenarios = risk ? [...risk.scenarios].sort((x, y) => y.residual.score - x.residual.score) : [];
  return (
    <>
      <PageHeader title={a.title} subtitle={`${a.siteName}${a.completedAt ? `, completed ${fmtDate(a.completedAt)}` : ""}`} back={{ to: "/", label: "All assessments" }} />
      <Card as="section" className="mb-4 border-primary">
        <h2 className="text-2xl font-bold">Risk summary</h2>
        {risk && !isUnscored(risk) ? (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">Overall residual risk</span>
              <LevelBadge level={risk.overall.level} score={risk.overall.residual} />
            </div>
            <ul className="mt-3 flex flex-col gap-2">
              {scenarios.map((s) => (
                <li key={s.scenarioId} className="rounded-lg border-2 border-line p-3">
                  <p className="font-bold">{s.name}</p>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-base text-muted">Before</span> <LevelBadge level={s.inherent.level} score={s.inherent.score} /> <span aria-hidden="true">→</span>
                    <span className="text-base text-muted">after</span> <LevelBadge level={s.residual.level} score={s.residual.score} />
                    <Chip>{CONFIDENCE_LABEL[s.confidence]}</Chip>
                  </p>
                  <p className="text-base">{scenarioReason(s)}</p>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-base text-muted">
              Scores run from 0 to 25 (likelihood times impact, reduced by working controls). Method {risk.methodVersion}; overall inherent {formatScore(risk.overall.inherent)}.
            </p>
          </>
        ) : (
          <p className="mt-2">
            <NotScoredBadge />
          </p>
        )}
      </Card>
      <section aria-labelledby="pf-h" className="mb-4">
        <h2 id="pf-h" className="mb-2 text-2xl font-bold">
          Findings ({findings.length})
        </h2>
        {findings.length === 0 ? <p className="text-muted">No confirmed findings.</p> : <ul className="flex flex-col gap-2">{findings.map((f) => <FindingCard key={f.id} f={f} />)}</ul>}
      </section>
      <section aria-labelledby="pr-h" className="mb-4">
        <h2 id="pr-h" className="mb-2 text-2xl font-bold">
          Report
        </h2>
        <Button variant="secondary" aria-expanded={showReport} onClick={() => setShowReport(!showReport)}>
          {showReport ? "Hide report" : "Show report"}
        </Button>
        {showReport && (
          <div className="mt-3">
            <HtmlPreview title="Report" load={loadReport} testId="portal-report" />
          </div>
        )}
      </section>
      <section aria-labelledby="pq-h">
        <h2 id="pq-h" className="mb-2 text-2xl font-bold">
          Proposals
        </h2>
        {a.quotes.length === 0 ? (
          <p className="text-muted">No proposals yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {a.quotes.map((q) => (
              <li key={q.id}>
                <Link to={`/portal/quotes/${q.id}`} className="inline-flex min-h-12 items-center font-semibold text-primary underline underline-offset-4">
                  {q.number}: {q.title} ({QUOTE_STATUS_LABEL[q.status]})
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Respond({ q, onDone }: { q: PortalQuote; onDone: (q: PortalQuote, tier: Tier | null) => void }) {
  const api = useApi();
  const [mode, setMode] = useState<"accept" | "decline" | null>(null);
  const [tier, setTier] = useState<Tier | null>(q.tiers.length === 1 ? q.tiers[0]! : null);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const price = (t: Tier) => q.totals.find((x) => x.tier === t)?.price ?? 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Type your full name to confirm.");
    if (mode === "accept" && !tier) return setError("Choose an option first.");
    setBusy(true);
    setError(null);
    try {
      const r = await respondToQuote(api, q.id, mode === "accept" ? { action: "accept", tier: tier!, name: name.trim() } : { action: "decline", name: name.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onDone(r, mode === "accept" ? tier : null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "quote_expired"
          ? "This proposal has expired. Contact your provider for an updated proposal."
          : err instanceof ApiError && err.status === 409
            ? "This proposal was already answered or changed. Refresh the page."
            : errorMessage(err) || "Your answer could not be recorded.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section" className="mb-4 border-primary">
      <h2 className="text-2xl font-bold">Your decision</h2>
      {q.tiers.length > 1 && (
        <fieldset className="m-0 mt-2 border-0 p-0">
          <legend className="font-semibold">Choose an option to accept</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {q.tiers.map((t) => (
              <label key={t} className={"flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border-2 p-3 " + (tier === t ? "border-primary bg-primary-soft" : "border-line")}>
                <input type="radio" name="tier" className="size-6" checked={tier === t} onChange={() => (setTier(t), setMode("accept"))} />
                <span>
                  <span className="block font-bold">{TIER_LABEL[t]}</span>
                  {money(price(t))}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button size="lg" onClick={() => setMode("accept")} aria-pressed={mode === "accept"}>
          Accept
        </Button>
        <Button variant="secondary" size="lg" onClick={() => setMode("decline")} aria-pressed={mode === "decline"}>
          Decline
        </Button>
      </div>
      {mode && (
        <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
          {mode === "accept" ? (
            <p className="font-semibold">{tier ? `Accept the ${TIER_LABEL[tier]} option for ${money(price(tier))}? Type your full name to confirm.` : "Choose an option above, then type your full name to confirm."}</p>
          ) : (
            <>
              <p className="font-semibold">Decline this proposal? You can tell us why (optional).</p>
              <TextArea label="Reason (optional)" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </>
          )}
          <Field label="Your full name" autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          {error && <Banner tone="error">{error}</Banner>}
          <Button type="submit" size="lg" variant={mode === "accept" ? "primary" : "danger"} disabled={busy || (mode === "accept" && !tier)}>
            {mode === "accept" ? "Accept proposal" : "Decline proposal"}
          </Button>
          {mode === "accept" && <p className="text-base text-muted">This records your acceptance and notifies your provider. It is not a payment.</p>}
        </form>
      )}
    </Card>
  );
}

function PortalQuoteScreen() {
  const { id = "" } = useParams();
  const api = useApi();
  const d = useAsync(() => fetchPortalQuote(api, id), [api, id]);
  const [q, setQ] = useState<PortalQuote | null>(null);
  const [acceptedTier, setAcceptedTier] = useState<Tier | null>(null);
  const [loadPreview] = useState(() => () => fetchPortalQuotePreview(api, id));
  const quote = q ?? d.data;
  if (d.error) return <Banner tone="error">{errorMessage(d.error) || "This proposal could not be loaded."}</Banner>;
  if (!quote) return <Loading label="Loading proposal" />;
  const tierShown = acceptedTier ?? quote.acceptedTier ?? null;
  return (
    <>
      <PageHeader title={`Proposal ${quote.number}`} subtitle={quote.title} back={{ to: "/", label: "All assessments" }} />
      {quote.status === "accepted" && quote.respondedBy && (
        <div className="mb-4">
          <Banner tone="ok" live>
            Accepted by {quote.respondedBy} on {fmtDate(quote.respondedAt)}
            {tierShown ? `, ${TIER_LABEL[tierShown]} option` : ""}.
          </Banner>
        </div>
      )}
      {quote.status === "declined" && (
        <div className="mb-4">
          <Banner tone="info" live>
            Declined{quote.respondedBy ? ` by ${quote.respondedBy}` : ""} on {fmtDate(quote.respondedAt)}.
          </Banner>
        </div>
      )}
      {quote.status === "expired" && (
        <div className="mb-4">
          <Banner tone="warn">This proposal expired on {fmtDate(quote.validUntil)}. Contact your provider for an updated proposal.</Banner>
        </div>
      )}
      <section aria-labelledby="opt-h" className="mb-4">
        <h2 id="opt-h" className="mb-2 text-2xl font-bold">
          {quote.tiers.length > 1 ? "Options" : "Price"}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {quote.totals.map((t) => (
            <li key={t.tier} className={"rounded-xl border-2 bg-surface p-3 " + (tierShown === t.tier ? "border-ok" : "border-line")} data-testid={`portal-tier-${t.tier}`}>
              <p className="text-xl font-bold">{TIER_LABEL[t.tier]}</p>
              <p className="text-2xl font-bold">{money(t.price)}</p>
              {t.optionalPrice > 0 && <p className="text-base">Optional add-ons (not included): {money(t.optionalPrice)}</p>}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-base text-muted">
          Valid until {fmtDate(quote.validUntil)}. Prices exclude tax unless stated in the terms.
        </p>
      </section>
      {quote.status === "sent" && (
        <Respond
          q={quote}
          onDone={(next, tier) => {
            setQ(next);
            setAcceptedTier(tier);
          }}
        />
      )}
      <section aria-labelledby="qp-h">
        <h2 id="qp-h" className="mb-2 text-2xl font-bold">
          Full proposal
        </h2>
        <HtmlPreview title="Proposal" load={loadPreview} testId="portal-quote-preview" />
      </section>
    </>
  );
}

export function PortalApp() {
  return (
    <PortalShell>
      <Routes>
        <Route path="/portal/assessments/:id" element={<PortalAssessmentScreen />} />
        <Route path="/portal/quotes/:id" element={<PortalQuoteScreen />} />
        <Route path="*" element={<PortalHome />} />
      </Routes>
    </PortalShell>
  );
}
