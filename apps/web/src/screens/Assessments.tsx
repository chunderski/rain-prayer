import { Link, useParams } from "react-router-dom";
import { z } from "zod";
import { useApi } from "../auth/AuthContext";
import { AssessmentDetail as AssessmentDetailSchema, AssessmentSummary } from "../api/schemas";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Banner, ButtonLink, Card, Chip, EmptyState, Loading, PageHeader } from "../components/ui";

export const statusLabel: Record<string, string> = {
  draft: "Draft",
  in_progress: "In progress",
  in_review: "In review",
  complete: "Complete",
  archived: "Archived",
};

export function AssessmentsHome() {
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.get("/assessments", z.array(AssessmentSummary)), [api]);
  return (
    <>
      <PageHeader
        title="Assessments"
        actions={
          <ButtonLink to="/assessments/new" size="lg">
            <span aria-hidden="true">+</span> New assessment
          </ButtonLink>
        }
      />
      {error ? (
        <Banner tone="error" action={<button className="min-h-12 underline" onClick={reload}>Try again</button>}>
          {errorMessage(error)}
        </Banner>
      ) : null}
      {loading && !data && <Loading label="Loading assessments" />}
      {data && data.length === 0 && (
        <EmptyState title="No assessments yet" action={<ButtonLink to="/assessments/new">Create your first assessment</ButtonLink>}>
          Pick a client site and any mix of physical and cyber frameworks.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {data.map((a) => (
            <li key={a.id}>
              <Link to={`/assessments/${a.id}`} className="block rounded-xl border-2 border-line bg-surface p-4 no-underline">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-xl font-bold text-primary underline underline-offset-4">{a.title}</h2>
                  <Chip>{statusLabel[a.status] ?? a.status}</Chip>
                </div>
                <p className="text-muted">
                  {[a.clientName, a.siteName].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-2 flex flex-wrap gap-2">
                  {a.frameworks.map((f) => (
                    <Chip key={f.frameworkId} tone="primary">
                      {f.shortName ?? f.frameworkId} v{f.version}
                    </Chip>
                  ))}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function AssessmentDetail() {
  const { id = "" } = useParams();
  const api = useApi();
  const { data, error, loading } = useAsync(() => api.get(`/assessments/${encodeURIComponent(id)}`, AssessmentDetailSchema), [api, id]);
  if (loading && !data) return <Loading label="Loading assessment" />;
  if (error || !data) return <Banner tone="error">{errorMessage(error) || "Assessment not found."}</Banner>;
  return (
    <>
      <PageHeader
        title={data.title}
        back={{ to: "/", label: "Assessments" }}
        subtitle={[data.clientName, data.siteName].filter(Boolean).join(" · ")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card as="section">
          <h2 className="text-xl font-bold">Status</h2>
          <p className="mt-1">
            <Chip>{statusLabel[data.status] ?? data.status}</Chip>
          </p>
          {data.scheduledFor && <p className="mt-2">Scheduled for {data.scheduledFor}</p>}
        </Card>
        <Card as="section">
          <h2 className="text-xl font-bold">Scope</h2>
          <dl className="mt-1 grid grid-cols-2 gap-2">
            <div>
              <dt className="text-base text-muted">Shared controls</dt>
              <dd className="text-2xl font-bold" data-testid="assessment-control-count">{data.controlCount ?? "–"}</dd>
            </div>
            <div>
              <dt className="text-base text-muted">Questions</dt>
              <dd className="text-2xl font-bold">{data.questionCount ?? "–"}</dd>
            </div>
          </dl>
          <p className="mt-2 text-base text-muted">Counted once even when a control serves several frameworks.</p>
        </Card>
        <Card as="section" className="sm:col-span-2">
          <h2 className="text-xl font-bold">Frameworks (pinned versions)</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {data.frameworks.map((f) => (
              <li key={f.frameworkId}>
                <Chip tone="primary">
                  {f.shortName ?? f.frameworkId} v{f.version}
                </Chip>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-base text-muted">Later library updates do not change this assessment.</p>
        </Card>
      </div>
      <p className="mt-6 text-muted">The guided walkthrough and photo capture arrive in Phase 2.</p>
    </>
  );
}
