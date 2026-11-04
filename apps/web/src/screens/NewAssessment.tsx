import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { CreateAssessment } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { fetchFrameworks } from "../api/library";
import { AssessmentCreated, ClientSummary, Site } from "../api/schemas";
import { FrameworkPicker, useControlsForFrameworks } from "../components/FrameworkPicker";
import { computeCoverage } from "../components/coverage";
import { Banner, Button, Card, Chip, EmptyState, Field, Loading, PageHeader, categoryLabel, categoryTone } from "../components/ui";
import { errorMessage, useAsync } from "../lib/useAsync";
import { deleteDraft, getDraft, saveDraft } from "../offline/db";
import { useOnline } from "../offline/useOnline";

const DRAFT_ID = "new-assessment";

interface WizardState {
  step: 1 | 2 | 3;
  clientId: string;
  siteId: string;
  frameworks: string[];
  title: string;
  scheduledFor: string;
}

const EMPTY: WizardState = { step: 1, clientId: "", siteId: "", frameworks: [], title: "", scheduledFor: "" };
const STEP_TITLES = { 1: "Client and site", 2: "Frameworks", 3: "Details and review" } as const;

function RadioCard({ name, value, checked, onChange, title, detail }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; detail?: string | null }) {
  return (
    <label
      className={
        "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border-[3px] bg-surface px-4 py-2 " +
        "has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus " +
        (checked ? "border-primary bg-primary-soft" : "border-line")
      }
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="size-6 shrink-0 accent-[var(--sa-primary)]" />
      <span className="flex flex-col">
        <span className="font-bold">{title}</span>
        {detail && <span className="text-base text-muted">{detail}</span>}
      </span>
    </label>
  );
}

export function NewAssessment() {
  const api = useApi();
  const navigate = useNavigate();
  const [s, setS] = useState<WizardState>(EMPTY);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Restore an unfinished wizard (drafts survive app switches and reloads).
  useEffect(() => {
    getDraft<WizardState>(DRAFT_ID)
      .then((d) => d && setS({ ...EMPTY, ...d.data }))
      .catch(() => undefined)
      .finally(() => setRestored(true));
  }, []);
  useEffect(() => {
    if (restored) saveDraft(DRAFT_ID, "assessment_wizard", s).catch(() => undefined);
  }, [s, restored]);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [s.step]);

  const clients = useAsync(() => api.get("/clients", z.array(ClientSummary)), [api]);
  const sites = useAsync(
    () => (s.clientId ? api.get(`/sites?clientId=${encodeURIComponent(s.clientId)}`, z.array(Site)) : Promise.resolve([])),
    [api, s.clientId],
  );
  const frameworks = useAsync(() => fetchFrameworks(api), [api]);
  const { controlsByFramework, error: controlsError } = useControlsForFrameworks(api, s.frameworks);
  const coverage = computeCoverage(s.frameworks, controlsByFramework);

  const update = (patch: Partial<WizardState>) => {
    setError(null);
    setS((prev) => ({ ...prev, ...patch }));
  };

  function next() {
    if (s.step === 1) {
      if (!s.clientId) return setError("Choose a client.");
      if (!s.siteId) return setError("Choose a site.");
      update({ step: 2 });
    } else if (s.step === 2) {
      if (s.frameworks.length === 0) return setError("Choose at least one framework.");
      update({ step: 3 });
    }
  }

  async function create() {
    const fwList = frameworks.data?.data ?? [];
    const parsed = CreateAssessment.safeParse({
      siteId: s.siteId,
      title: s.title,
      scheduledFor: s.scheduledFor || undefined,
      frameworks: s.frameworks.map((id) => ({ frameworkId: id, version: fwList.find((f) => f.id === id)?.version ?? "" })),
    });
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors;
      setError(f.title ? "Enter a title." : f.frameworks ? "Choose at least one framework." : f.scheduledFor ? "Enter a valid date." : "Check the details and try again.");
      return;
    }
    setBusy(true);
    try {
      const created = await api.post("/assessments", parsed.data, AssessmentCreated);
      await deleteDraft(DRAFT_ID).catch(() => undefined);
      navigate(`/assessments/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "Your role cannot create assessments." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const client = clients.data?.find((c) => c.id === s.clientId);
  const site = sites.data?.find((x) => x.id === s.siteId);
  const fwList = frameworks.data?.data ?? [];
  const selectedFw = fwList.filter((f) => s.frameworks.includes(f.id));

  return (
    <>
      <PageHeader title="New assessment" back={{ to: "/", label: "Assessments" }} />
      <ol className="mb-4 flex gap-2" aria-label="Progress">
        {([1, 2, 3] as const).map((n) => (
          <li
            key={n}
            aria-current={s.step === n ? "step" : undefined}
            className={"flex-1 rounded-lg border-2 px-2 py-1 text-center text-base font-semibold " + (s.step === n ? "border-primary bg-primary text-on-primary" : s.step > n ? "border-primary text-ink" : "border-line text-muted")}
          >
            {s.step > n && <span aria-hidden="true">✓ </span>}
            {n}. {STEP_TITLES[n]}
          </li>
        ))}
      </ol>
      <h2 ref={headingRef} tabIndex={-1} className="mb-3 text-2xl font-bold">
        Step {s.step} of 3: {STEP_TITLES[s.step]}
      </h2>

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {s.step === 1 && (
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xl font-bold">Client</legend>
            {clients.loading && !clients.data && <Loading label="Loading clients" />}
            {clients.error ? <Banner tone="error">{errorMessage(clients.error)}</Banner> : null}
            {clients.data?.length === 0 && (
              <EmptyState title="No clients yet" action={<Link className="font-semibold text-primary underline" to="/clients">Add a client</Link>} />
            )}
            {clients.data?.map((c) => (
              <RadioCard key={c.id} name="client" value={c.id} checked={s.clientId === c.id} onChange={() => update({ clientId: c.id, siteId: "" })} title={c.name} detail={c.industry} />
            ))}
          </fieldset>
          {s.clientId && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xl font-bold">Site</legend>
              {sites.loading && <Loading label="Loading sites" />}
              {!sites.loading && sites.data?.length === 0 && (
                <EmptyState title="This client has no sites" action={<Link className="font-semibold text-primary underline" to={`/clients/${s.clientId}`}>Add a site</Link>} />
              )}
              {sites.data?.map((x) => (
                <RadioCard key={x.id} name="site" value={x.id} checked={s.siteId === x.id} onChange={() => update({ siteId: x.id })} title={x.name} detail={[x.siteType, x.address].filter(Boolean).join(" · ")} />
              ))}
            </fieldset>
          )}
        </div>
      )}

      {s.step === 2 && (
        <>
          {frameworks.loading && !frameworks.data && <Loading label="Loading frameworks" />}
          {frameworks.error ? <Banner tone="error">{errorMessage(frameworks.error)}</Banner> : null}
          {frameworks.data?.fromCache && (
            <div className="mb-3">
              <Banner tone="info">Showing the framework library saved on this device.</Banner>
            </div>
          )}
          {controlsError && (
            <div className="mb-3">
              <Banner tone="warn">{controlsError}</Banner>
            </div>
          )}
          {frameworks.data && (
            <FrameworkPicker frameworks={frameworks.data.data} value={s.frameworks} onChange={(frameworks) => update({ frameworks })} controlsByFramework={controlsByFramework} />
          )}
        </>
      )}

      {s.step === 3 && (
        <div className="flex flex-col gap-5">
          <Field label="Assessment title" value={s.title} onChange={(e) => update({ title: e.target.value })} required placeholder="For example: HQ annual survey" />
          <Field label="Scheduled date (optional)" type="date" value={s.scheduledFor} onChange={(e) => update({ scheduledFor: e.target.value })} />
          <Card as="section">
            <h3 className="text-xl font-bold">Review</h3>
            <dl className="mt-2 grid gap-3">
              <div>
                <dt className="text-base text-muted">Client and site</dt>
                <dd className="font-semibold">{[client?.name, site?.name].filter(Boolean).join(" · ")}</dd>
              </div>
              <div>
                <dt className="text-base text-muted">Frameworks (version pinned)</dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {selectedFw.map((f) => (
                    <Chip key={f.id} tone={categoryTone(f.category)}>
                      {f.shortName} v{f.version}
                      <span className="sr-only"> ({categoryLabel(f.category)})</span>
                    </Chip>
                  ))}
                </dd>
              </div>
            </dl>
            <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-primary-soft p-3" data-testid="review-counts">
              <div>
                <p className="text-base text-muted">Shared controls</p>
                <p className="text-3xl font-bold">{coverage.complete ? coverage.controlCount : "…"}</p>
              </div>
              <div>
                <p className="text-base text-muted">Questions</p>
                <p className="text-3xl font-bold">{coverage.complete ? coverage.questionCount : "…"}</p>
              </div>
              {coverage.complete && coverage.separateCount > coverage.controlCount && (
                <p className="col-span-2 text-base">
                  Deduplicated: {coverage.separateCount - coverage.controlCount} checks saved, because {coverage.overlapCount}{" "}
                  {coverage.overlapCount === 1 ? "control counts" : "controls count"} toward more than one framework.
                </p>
              )}
            </div>
          </Card>
        </div>
      )}

      <div className="sticky bottom-16 z-30 -mx-4 mt-6 flex gap-3 border-t-2 border-line bg-surface px-4 py-3 sm:bottom-0">
        {s.step > 1 && (
          <Button variant="secondary" size="lg" onClick={() => update({ step: (s.step - 1) as 1 | 2 })}>
            Back
          </Button>
        )}
        {s.step < 3 ? (
          <Button size="lg" className="flex-1" onClick={next}>
            Next
          </Button>
        ) : (
          <div className="flex flex-1 flex-col gap-1">
            <Button size="lg" className="w-full" onClick={() => void create()} disabled={busy || !online} aria-describedby={online ? undefined : "offline-create-note"}>
              {busy ? "Creating…" : "Create assessment"}
            </Button>
            {!online && (
              <p id="offline-create-note" className="text-base font-semibold">
                You are offline. Your choices are saved on this device; create the assessment when you have signal.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
