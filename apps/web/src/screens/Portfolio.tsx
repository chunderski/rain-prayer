/**
 * Portfolio (viewer and up): per client and site, the residual risk trend across completed
 * assessments (a small inline SVG plus the same values as text), open findings, and quote values.
 * Caveats from the API come first. Sites are ranked by their latest residual score.
 */
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import type { Portfolio } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { ClientSummary } from "../api/schemas";
import { fetchPortfolio, money } from "../api/phase4";
import { errorMessage, useAsync } from "../lib/useAsync";
import { formatScore, LEVEL_LABEL, SCORE_MAX } from "../risk/levels";
import { LevelBadge } from "../risk/RiskViz";
import { SEVERITY, type SeverityValue } from "../field/labels";
import { Banner, Card, EmptyState, Loading, PageHeader, SelectField } from "../components/ui";

type Site = Portfolio["clients"][number]["sites"][number];
const SEV: SeverityValue[] = ["critical", "high", "medium", "low", "info"];
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });

/** Residual over time on a fixed 0 to 25 axis. Decorative: the values are printed next to it. */
export function TrendSvg({ values, width = 140, height = 44 }: { values: number[]; width?: number; height?: number }) {
  if (values.length === 0) return null;
  const pad = 5;
  const x = (i: number) => (values.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (values.length - 1));
  const y = (v: number) => height - pad - (Math.min(SCORE_MAX, Math.max(0, v)) / SCORE_MAX) * (height - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false" className="shrink-0 rounded border-2 border-line bg-surface" data-testid="trend-svg">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" className="text-primary" />
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={3.5} className="fill-current text-ink" />
      ))}
    </svg>
  );
}

export function trendText(history: Site["history"]): string {
  if (history.length === 0) return "No completed assessments yet.";
  const parts = history.map((h) => `${formatScore(h.residual)} ${LEVEL_LABEL[h.level]} (${shortDate(h.completedAt)})`);
  if (history.length === 1) return `Residual ${parts[0]}.`;
  const first = history[0]!.residual;
  const last = history[history.length - 1]!.residual;
  const dir = last < first ? "improving" : last > first ? "getting worse" : "unchanged";
  return `Residual ${parts.join(", then ")}: ${dir}.`;
}

function SiteCard({ s }: { s: Site }) {
  const latest = s.history[s.history.length - 1];
  const open = SEV.filter((k) => (s.openFindings[k] ?? 0) > 0).map((k) => `${s.openFindings[k]} ${SEVERITY[k].label.toLowerCase()}`);
  return (
    <li className="rounded-xl border-2 border-line bg-surface p-3" data-testid={`site-${s.siteId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-xl font-bold">{s.siteName}</h3>
        {latest && <LevelBadge level={latest.level} score={latest.residual} />}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <TrendSvg values={s.history.map((h) => h.residual)} />
        <p className="min-w-0 flex-1 text-base" data-testid="trend-text">
          {trendText(s.history)}
        </p>
      </div>
      <p className="mt-2">{open.length ? `Open findings: ${open.join(", ")}` : "No open findings"}</p>
      <p className="text-base">
        Quotes: {s.quotes.sent} sent, {s.quotes.accepted} accepted; accepted value {money(s.quotes.acceptedValue)}, open value {money(s.quotes.openValue)}
      </p>
    </li>
  );
}

export function PortfolioScreen() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const clientId = params.get("clientId") ?? "";
  const clients = useAsync(() => api.get("/clients", z.array(ClientSummary)), [api]);
  const p = useAsync(() => fetchPortfolio(api, clientId), [api, clientId]);
  const data = p.data;
  return (
    <>
      <PageHeader title="Portfolio" subtitle="Residual risk trend per site, open findings, and quote values" back={{ to: "/", label: "Home" }} />
      <div className="mb-4 max-w-md">
        <SelectField label="Client" value={clientId} onChange={(e) => setParams(e.target.value ? { clientId: e.target.value } : {})}>
          <option value="">All clients</option>
          {(clients.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
      </div>
      {p.loading && !data && <Loading label="Loading portfolio" />}
      {p.error ? <Banner tone="error">{errorMessage(p.error) || "The portfolio could not be loaded."}</Banner> : null}
      {data && data.caveats.length > 0 && (
        <div className="mb-4" data-testid="portfolio-caveats">
          <Banner tone="warn" title="Read before comparing">
            <ul className="list-disc pl-5">
              {data.caveats.map((c, n) => (
                <li key={n}>{c}</li>
              ))}
            </ul>
          </Banner>
        </div>
      )}
      {data && data.clients.length === 0 && <EmptyState title="No completed assessments yet">The portfolio fills in as assessments are completed.</EmptyState>}
      <div className="flex flex-col gap-4">
        {data?.clients.map((c) => (
          <Card as="section" key={c.clientId}>
            <h2 className="mb-2 text-2xl font-bold">{c.clientName}</h2>
            <ol className="flex flex-col gap-3" aria-label={`Sites of ${c.clientName}, highest residual risk first`}>
              {[...c.sites]
                .sort((a, b) => (b.history.at(-1)?.residual ?? -1) - (a.history.at(-1)?.residual ?? -1))
                .map((s) => (
                  <SiteCard key={s.siteId} s={s} />
                ))}
            </ol>
          </Card>
        ))}
      </div>
      {data && <p className="mt-3 text-base text-muted">Method {data.methodVersion}. Residual scores run from 0 to {SCORE_MAX}; the trend reads oldest to newest, left to right.</p>}
    </>
  );
}
