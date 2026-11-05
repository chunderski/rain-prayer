/**
 * Admin home: assessments by status, findings by severity, and the top residual risks across the
 * workspace, then the assessments list. Counts are printed beside every bar.
 */
import { Link } from "react-router-dom";
import { useApi, useCanAdmin } from "../auth/AuthContext";
import { fetchDashboard, SEVERITY_ORDER } from "../api/phase3";
import { errorMessage, useAsync } from "../lib/useAsync";

import { CountBars, LevelBadge } from "../risk/RiskViz";
import { Banner, ButtonLink, Card, Loading, PageHeader } from "../components/ui";
import { AssessmentsHome, statusLabel } from "./Assessments";

const STATUS_ORDER = ["draft", "in_progress", "in_review", "complete", "archived"];
const SEVERITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
const SEVERITY_FILL: Record<string, string> = { critical: "bg-lv5", high: "bg-lv4", medium: "bg-lv3", low: "bg-lv2", info: "bg-lv1" };

export function Dashboard() {
  const api = useApi();
  const isAdmin = useCanAdmin();
  const { data, error, loading, reload } = useAsync(() => fetchDashboard(api), [api]);
  const d = data?.data;
  const statuses = d ? [...STATUS_ORDER, ...Object.keys(d.assessmentsByStatus).filter((k) => !STATUS_ORDER.includes(k))] : [];
  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <ButtonLink to="/compare" variant="secondary">
              Compare sites
            </ButtonLink>
            {isAdmin && (
              <ButtonLink to="/settings/integrations" variant="secondary">
                Settings
              </ButtonLink>
            )}
          </>
        }
      />
      {error ? (
        <div className="mb-4">
          <Banner tone="error" action={<button className="min-h-12 underline" onClick={reload}>Try again</button>}>
            {errorMessage(error) || "The dashboard could not be loaded."}
          </Banner>
        </div>
      ) : null}
      {data?.fromCache && (
        <div className="mb-3">
          <Banner tone="info">Showing the dashboard saved on this device.</Banner>
        </div>
      )}
      {loading && !d && <Loading label="Loading dashboard" />}
      {d && (
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <Card as="section">
            <h2 className="mb-3 text-xl font-bold">Assessments by status</h2>
            <CountBars label="Assessments by status" items={statuses.map((k) => ({ key: k, label: statusLabel[k] ?? k, count: d.assessmentsByStatus[k] ?? 0 }))} />
          </Card>
          <Card as="section">
            <h2 className="mb-3 text-xl font-bold">Open findings by severity</h2>
            <CountBars
              label="Findings by severity"
              items={SEVERITY_ORDER.map((k) => ({ key: k, label: SEVERITY_LABEL[k]!, count: d.findingsBySeverity[k] ?? 0, fill: SEVERITY_FILL[k] }))}
            />
            <p className="mt-3 font-semibold" data-testid="open-high">
              {d.openHighFindings} open high or critical {d.openHighFindings === 1 ? "finding" : "findings"}
            </p>
          </Card>
          <Card as="section" className="md:col-span-2">
            <h2 className="mb-3 text-xl font-bold">Top residual risks</h2>
            {d.topResidual.length === 0 ? (
              <p className="text-muted">No completed assessments yet. Top risks appear here once an assessment is completed and its scores are frozen; open an assessment to see its live scores.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {d.topResidual.map((t, n) => (
                  <li key={`${t.assessmentId}-${t.scenarioName}-${n}`}>
                    <Link
                      to={`/assessments/${t.assessmentId}/risk`}
                      className="flex min-h-12 flex-wrap items-center justify-between gap-2 rounded-lg border-2 border-line p-3 no-underline"
                    >
                      <span>
                        <span className="font-bold text-primary underline underline-offset-4">{t.scenarioName}</span>
                        <span className="block text-muted">{t.siteName}</span>
                      </span>
                      <LevelBadge level={t.level} score={t.residual} />
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      )}
      <AssessmentsHome embedded />
    </>
  );
}
