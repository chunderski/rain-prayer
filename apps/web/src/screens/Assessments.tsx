import { Link } from "react-router-dom";
import { frameworkName } from "../field/labels";
import { z } from "zod";
import { useApi, useCanAdmin } from "../auth/AuthContext";
import { AssessmentSummary } from "../api/schemas";
import { cachedGet } from "../api/library";
import { useField } from "../field/FieldContext";
import { LockPanel } from "../field/Lock";
import { getPosition } from "../field/walkthrough";
import { useLocal } from "../lib/useLocal";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Banner, ButtonLink, Card, Chip, EmptyState, Loading, PageHeader } from "../components/ui";

export const statusLabel: Record<string, string> = {
  draft: "Draft",
  in_progress: "In progress",
  in_review: "In review",
  complete: "Complete",
  archived: "Archived",
};

/** The assessments list; `embedded` renders it as a section of the admin dashboard. */
export function AssessmentsHome({ embedded = false }: { embedded?: boolean }) {
  const api = useApi();
  const { data: cached, error, loading, reload } = useAsync(() => cachedGet(api, "/assessments", z.array(AssessmentSummary)), [api]);
  const data = cached?.data;
  return (
    <>
      {embedded ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">Assessments</h2>
          <ButtonLink to="/assessments/new" size="lg">
            <span aria-hidden="true">+</span> New assessment
          </ButtonLink>
        </div>
      ) : (
        <PageHeader
          title="Assessments"
          actions={
            <ButtonLink to="/assessments/new" size="lg">
              <span aria-hidden="true">+</span> New assessment
            </ButtonLink>
          }
        />
      )}
      {error ? (
        <Banner tone="error" action={<button className="min-h-12 underline" onClick={reload}>Try again</button>}>
          {errorMessage(error)}
        </Banner>
      ) : null}
      {cached?.fromCache && (
        <div className="mb-3">
          <Banner tone="info">Showing assessments saved on this device. Open one you worked on before to continue offline.</Banner>
        </div>
      )}
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
                  {embedded ? (
                    <h3 className="text-xl font-bold text-primary underline underline-offset-4">{a.title}</h3>
                  ) : (
                    <h2 className="text-xl font-bold text-primary underline underline-offset-4">{a.title}</h2>
                  )}
                  <Chip>{statusLabel[a.status] ?? a.status}</Chip>
                </div>
                <p className="text-muted">
                  {[a.clientName, a.siteName].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-2 flex flex-wrap gap-2">
                  {a.frameworks.map((f) => (
                    <Chip key={f.frameworkId} tone="primary">
                      {f.shortName ?? frameworkName(f.frameworkId)} v{f.version}
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
  const f = useField();
  const isAdmin = useCanAdmin();
  const data = f.assessment;
  const base = `/assessments/${f.assessmentId}`;
  const resume = useLocal(() => getPosition(f.assessmentId), [f.assessmentId]);
  const untagged = f.photos.filter((p) => !p.data.findingId).length;
  return (
    <>
      <PageHeader title={data.title} back={{ to: "/", label: "Assessments" }} subtitle={[data.clientName, data.siteName].filter(Boolean).join(" · ")} />
      {f.fromCache && (
        <div className="mb-4">
          <Banner tone="info">Showing the copy saved on this device.</Banner>
        </div>
      )}
      <LockPanel />
      <Card as="section" className="mb-4 border-primary">
        <h2 className="text-xl font-bold">Next steps</h2>
        <div className="mt-3 flex flex-col gap-2">
          <ButtonLink to={`${base}/walkthrough${resume.data ? `/${resume.data.areaKey}` : ""}`} size="lg" block>
            {resume.data ? "Continue walkthrough" : "Start walkthrough"}
          </ButtonLink>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ButtonLink to={`${base}/findings`} variant="secondary" size="lg" block>
              Findings ({f.findings.length})
            </ButtonLink>
            <ButtonLink to={`${base}/photos`} variant="secondary" size="lg" block>
              Photos ({f.photos.length}
              {untagged ? `, ${untagged} need a finding` : ""})
            </ButtonLink>
            <ButtonLink to={`${base}/areas`} variant="secondary" size="lg" block>
              Areas ({f.areas.length})
            </ButtonLink>
            <ButtonLink to={`${base}/risk/inputs`} variant="secondary" size="lg" block>
              Risk inputs
            </ButtonLink>
            <ButtonLink to={`${base}/risk`} variant="secondary" size="lg" block>
              Risk results
            </ButtonLink>
            <ButtonLink to={`${base}/report`} variant="secondary" size="lg" block>
              Report and export
            </ButtonLink>
            <ButtonLink to={`${base}/quotes`} variant="secondary" size="lg" block>
              Quotes
            </ButtonLink>
            {isAdmin && (
              <ButtonLink to={`${base}/assessors`} variant="secondary" size="lg" block>
                Assign assessors
              </ButtonLink>
            )}
          </div>
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card as="section">
          <h2 className="text-xl font-bold">Status</h2>
          <p className="mt-1">
            <Chip>{statusLabel[data.status] ?? data.status}</Chip>
          </p>
          {data.scheduledFor && <p className="mt-2">Scheduled for {data.scheduledFor}</p>}
          <p className="mt-2 text-base text-muted">
            Assessors: {f.structure.assessors.length ? f.structure.assessors.map((a) => a.name).join(", ") : "None assigned yet"}
          </p>
        </Card>
        <Card as="section">
          <h2 className="text-xl font-bold">Scope</h2>
          <dl className="mt-1 grid grid-cols-2 gap-2">
            <div>
              <dt className="text-base text-muted">Controls to check</dt>
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
            {data.frameworks.map((fw) => (
              <li key={fw.frameworkId}>
                <Chip tone="primary">
                  {fw.shortName ?? frameworkName(fw.frameworkId)} v{fw.version}
                </Chip>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-base text-muted">Later library updates do not change this assessment.</p>
        </Card>
      </div>
    </>
  );
}
