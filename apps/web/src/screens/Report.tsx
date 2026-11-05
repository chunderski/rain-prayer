/**
 * Report: narrative sections (AI draft, edit, approve), a sandboxed preview of the server-rendered
 * report, and Google export with job polling. AI drafts are labeled and never treated as final:
 * the server leaves `ai_draft` text out of the preview and exports until a person edits or
 * approves it (D-060).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ExportJob, Narrative } from "@sentinel/shared";
import { ApiError } from "../api/client";
import { useApi, useCanAdmin, useCanWrite } from "../auth/AuthContext";
import {
  draftNarrative,
  fetchExport,
  fetchExports,
  fetchNarratives,
  fetchReportPreview,
  NARRATIVE_SECTIONS,
  putNarrative,
  startExport,
  type NarrativeSection,
} from "../api/phase3";
import { useField } from "../field/FieldContext";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Banner, Button, Card, Chip, Loading, PageHeader, TextArea } from "../components/ui";

export const SECTION_LABEL: Record<NarrativeSection, string> = {
  executive_summary: "Executive summary",
  methodology: "Methodology",
  key_findings: "Key findings",
  recommendations: "Recommendations",
};

const STATUS_CHIP: Record<Narrative["status"], { tone: "warn" | "ok" | "primary"; text: string }> = {
  ai_draft: { tone: "warn", text: "AI draft: not in the report until you edit or approve it" },
  edited: { tone: "primary", text: "Edited: in the report" },
  approved: { tone: "ok", text: "Approved: in the report" },
};

export const POLL_MS = 2000;

function NarrativeCard({ section, current, onSaved }: { section: NarrativeSection; current: Narrative | undefined; onSaved: (n: Narrative) => void }) {
  const f = useField();
  const api = useApi();
  const canWrite = useCanWrite();
  const [text, setText] = useState(current?.text ?? "");
  const [busy, setBusy] = useState<null | "draft" | "save" | "approve">(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(current?.text ?? ""), [current?.text, current?.updatedAt]);
  const dirty = text !== (current?.text ?? "");
  const hid = `nar-${section}`;

  async function act(kind: "draft" | "save" | "approve") {
    if (kind === "draft" && current && current.status !== "ai_draft" && current.text.trim() && !window.confirm("Replace the current text with a new AI draft? The draft stays out of the report until you edit or approve it.")) return;
    setBusy(kind);
    setError(null);
    try {
      const n = kind === "draft" ? await draftNarrative(api, f.assessmentId, section) : await putNarrative(api, f.assessmentId, section, text, kind === "approve");
      onSaved(n);
    } catch (e) {
      if (e instanceof ApiError && e.code === "ai_not_configured") setError("AI drafting is not set up on this server. Write the section yourself.");
      else setError(errorMessage(e) || "That did not work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const chip = current ? STATUS_CHIP[current.status] : null;
  return (
    <article aria-labelledby={hid} className="rounded-xl border-2 border-line bg-surface p-4" data-testid={`narrative-${section}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={hid} className="text-xl font-bold">
          {SECTION_LABEL[section]}
        </h3>
        {chip ? <Chip tone={chip.tone}>{chip.text}</Chip> : <Chip>Not written yet</Chip>}
      </div>
      {current?.status === "ai_draft" && (
        <p className="mt-2 font-semibold text-warn">
          Written by AI{current.model ? ` (${current.model})` : ""}. Check every statement against what you saw before approving.
        </p>
      )}
      <div className="mt-3">
        <TextArea label={`${SECTION_LABEL[section]} text`} rows={6} value={text} maxLength={20000} readOnly={!canWrite} onChange={(e) => setText(e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="mt-2 font-semibold text-danger">
          {error}
        </p>
      )}
      {canWrite && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Button variant="secondary" disabled={!!busy || !f.online} onClick={() => void act("draft")}>
            {busy === "draft" ? "Drafting" : "Draft with AI"}
          </Button>
          <Button variant="secondary" disabled={!!busy || !dirty || !f.online} onClick={() => void act("save")}>
            Save edits
          </Button>
          <Button disabled={!!busy || !text.trim() || !f.online || (current?.status === "approved" && !dirty)} onClick={() => void act("approve")}>
            {current?.status === "approved" && !dirty ? "Approved" : "Approve"}
          </Button>
        </div>
      )}
    </article>
  );
}

/** Wraps server HTML for srcdoc and adds the app's preview stylesheet (inline styles are blocked by CSP). */
export function previewDocument(html: string, cssHref: string): string {
  const link = `<link rel="stylesheet" href="${cssHref.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${link}`);
  return `<!doctype html><html><head><meta charset="utf-8">${link}</head><body>${html}</body></html>`;
}

function Preview({ version }: { version: number }) {
  const f = useField();
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => fetchReportPreview(api, f.assessmentId), [api, f.assessmentId, version]);
  const css = new URL("/report-preview.css", import.meta.url).href;
  return (
    <section aria-labelledby="prev-h" className="mb-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="prev-h" className="text-2xl font-bold">
          Preview
        </h2>
        <Button variant="secondary" onClick={reload} disabled={!f.online}>
          Refresh preview
        </Button>
      </div>
      <p className="mb-2 text-muted">The same content the Google Doc gets. Unapproved AI drafts are left out.</p>
      {error ? <Banner tone="error">{errorMessage(error) || "The preview could not be loaded."}</Banner> : null}
      {loading && !data && <Loading label="Building preview" />}
      {data !== undefined && (
        // No allow-scripts and no allow-same-origin: the preview cannot run code or reach the app.
        <iframe title="Report preview" sandbox="" srcDoc={previewDocument(data, css)} className="h-[70vh] w-full rounded-lg border-2 border-line bg-white" data-testid="report-preview" />
      )}
    </section>
  );
}

const TARGETS = [
  { id: "docs", label: "Google Docs: narrative report with photos" },
  { id: "sheets", label: "Google Sheets: findings, scores, remediation" },
  { id: "drive", label: "Google Drive: photo archive" },
] as const;
const TARGET_NAME: Record<string, string> = { docs: "Google Doc", sheets: "Google Sheet", drive: "Drive folder" };
const safeUrl = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);

function JobResults({ job }: { job: ExportJob }) {
  const label = { queued: "Waiting to start", running: "Exporting", succeeded: "Export finished", failed: "Export failed" }[job.status];
  return (
    <div data-testid="export-job">
      <p className="font-semibold" role="status">
        {label}
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {job.results.map((r) => {
          const url = safeUrl(r.url);
          return (
            <li key={r.target} className="flex flex-wrap items-center gap-2">
              <Chip tone={r.status === "succeeded" ? "ok" : r.status === "failed" ? "danger" : "neutral"}>
                {TARGET_NAME[r.target]}: {r.status === "succeeded" ? "done" : r.status === "failed" ? "failed" : "pending"}
              </Chip>
              {url && (
                <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center font-semibold text-primary underline underline-offset-4">
                  Open {TARGET_NAME[r.target]}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
              {r.error && <span className="text-danger">{r.error}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExportPanel() {
  const f = useField();
  const api = useApi();
  const canWrite = useCanWrite();
  const isAdmin = useCanAdmin();
  const [targets, setTargets] = useState<string[]>(["docs", "sheets", "drive"]);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const history = useAsync(() => fetchExports(api, f.assessmentId).catch(() => [] as ExportJob[]), [api, f.assessmentId, job?.status === "succeeded" || job?.status === "failed"]);

  const jobId = job?.id;
  const finished = job?.status === "succeeded" || job?.status === "failed";
  useEffect(() => {
    if (!jobId || finished) return;
    let live = true;
    const t = setTimeout(() => {
      fetchExport(api, jobId).then(
        (j) => live && setJob(j),
        (e: unknown) => live && setError({ code: "poll", text: errorMessage(e) || "Could not check the export." }),
      );
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, jobId, finished, job]);

  async function start() {
    if (!targets.length) return setError({ code: "none", text: "Choose at least one destination." });
    setError(null);
    try {
      setJob(await startExport(api, f.assessmentId, targets));
    } catch (e) {
      if (e instanceof ApiError && (e.code === "google_not_configured" || e.code === "google_not_connected"))
        setError({ code: e.code, text: e.code === "google_not_configured" ? "Google export is not set up on this server." : "Google is not connected for this workspace." });
      else setError({ code: "error", text: errorMessage(e) || "The export could not start." });
    }
  }

  const running = !!job && !finished;
  return (
    <section aria-labelledby="exp-h" className="mb-6">
      <h2 id="exp-h" className="mb-2 text-2xl font-bold">
        Export to Google
      </h2>
      <Card>
        {!f.locked && <p className="mb-2 text-muted">This assessment is still open, so exports use live scores. Complete it first to export frozen numbers.</p>}
        <fieldset className="m-0 min-w-0 border-0 p-0" disabled={!canWrite || running}>
          <legend className="font-semibold">Destinations</legend>
          <div className="mt-2 flex flex-col gap-2">
            {TARGETS.map((t) => (
              <label key={t.id} className="flex min-h-12 items-center gap-3 rounded-lg border-2 border-line p-3">
                <input type="checkbox" className="size-6" checked={targets.includes(t.id)} onChange={(e) => setTargets((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))} />
                {t.label}
              </label>
            ))}
          </div>
          <Button className="mt-3" size="lg" block onClick={() => void start()} disabled={!f.online}>
            {running ? "Exporting" : "Start export"}
          </Button>
        </fieldset>
        {!f.online && <p className="mt-2 text-muted">Exporting needs a connection.</p>}
        {error && (
          <div className="mt-3">
            <Banner tone="error">
              {error.text}{" "}
              {(error.code === "google_not_configured" || error.code === "google_not_connected") &&
                (isAdmin ? (
                  <Link to="/settings/integrations" className="font-semibold underline">
                    Open Settings, Integrations
                  </Link>
                ) : (
                  "Ask an admin to connect Google in Settings, Integrations."
                ))}
            </Banner>
          </div>
        )}
        {job && (
          <div className="mt-3">
            <JobResults job={job} />
          </div>
        )}
      </Card>
      {history.data && history.data.filter((j) => j.id !== job?.id).length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-xl font-bold">Earlier exports</h3>
          <ul className="flex flex-col gap-2">
            {history.data
              .filter((j) => j.id !== job?.id)
              .map((j) => (
                <li key={j.id}>
                  <Card>
                    <p className="text-base text-muted">{new Date(j.createdAt).toLocaleString()}</p>
                    <JobResults job={j} />
                  </Card>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function ReportScreen() {
  const f = useField();
  const api = useApi();
  const narratives = useAsync(() => fetchNarratives(api, f.assessmentId), [api, f.assessmentId]);
  const [saved, setSaved] = useState<Record<string, Narrative>>({});
  const [version, setVersion] = useState(0);
  const bySection = (s: NarrativeSection) => saved[s] ?? narratives.data?.find((n) => n.section === s);

  return (
    <>
      <PageHeader title="Report" back={{ to: `/assessments/${f.assessmentId}`, label: f.assessment.title }} />
      {!f.online && (
        <div className="mb-4">
          <Banner tone="warn">The report, AI drafting, and export need a connection.</Banner>
        </div>
      )}
      <section aria-labelledby="nar-h" className="mb-6">
        <h2 id="nar-h" className="mb-2 text-2xl font-bold">
          Narrative
        </h2>
        <p className="mb-3 text-muted">AI can write a first draft. A draft stays out of the report until you edit it or approve it.</p>
        {narratives.error ? <Banner tone="error">{errorMessage(narratives.error) || "Narrative could not be loaded."}</Banner> : null}
        {narratives.loading && !narratives.data && <Loading label="Loading narrative" />}
        {narratives.data && (
          <div className="flex flex-col gap-4">
            {NARRATIVE_SECTIONS.map((s) => (
              <NarrativeCard
                key={s}
                section={s}
                current={bySection(s)}
                onSaved={(n) => {
                  setSaved((p) => ({ ...p, [s]: n }));
                  setVersion((v) => v + 1);
                }}
              />
            ))}
          </div>
        )}
      </section>
      {f.online && <Preview version={version} />}
      <ExportPanel />
    </>
  );
}
