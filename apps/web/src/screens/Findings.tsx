/**
 * Findings for one assessment, with framework chips showing every framework requirement each
 * finding counts toward (through its shared controls), plus the finding editor.
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Finding } from "@sentinel/shared";
import { areaIdOf, areaName, useField } from "../field/FieldContext";
import { deleteFinding, saveFinding } from "../field/repo";
import { SEVERITIES, SEVERITY, controlsFrameworks, frameworkChips, type SeverityValue } from "../field/labels";
import { uuid } from "../offline/db";
import { AreaPicker, ControlPicker, SeverityPicker } from "../components/FieldPickers";
import { Banner, Button, ButtonLink, Card, Chip, EmptyState, Field, PageHeader, TextArea } from "../components/ui";

const STATUS_LABEL = { draft: "Draft", confirmed: "Confirmed", resolved: "Resolved" } as const;
const SOURCE_LABEL = { assessor: null, ai_accepted: "AI-assisted, accepted", ai_edited: "AI-assisted, human-edited" } as const;

export function FindingsList() {
  const f = useField();
  const base = `/assessments/${f.assessmentId}`;
  const rank = (s: string) => SEVERITIES.indexOf(s as SeverityValue);
  const findings = [...f.findings].sort((a, b) => rank(b.data.severity) - rank(a.data.severity) || a.data.title.localeCompare(b.data.title));
  return (
    <>
      <PageHeader
        title="Findings"
        subtitle={f.assessment.title}
        back={{ to: base, label: "Assessment" }}
        actions={
          f.ctx ? (
            <ButtonLink to={`${base}/findings/new`} size="lg">
              <span aria-hidden="true">+</span> Add finding
            </ButtonLink>
          ) : undefined
        }
      />
      {findings.length === 0 ? (
        <EmptyState title="No findings yet">Findings are created when you answer No in the walkthrough, add one by hand, or accept an AI suggestion.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="findings-list">
          {findings.map((x) => {
            const sev = SEVERITY[x.data.severity];
            const chips = frameworkChips(controlsFrameworks(x.data.controlIds, f.controls));
            const photos = f.photos.filter((p) => p.data.findingId === x.id).length;
            return (
              <li key={x.id}>
                <Link to={`${base}/findings/${x.id}`} className="block rounded-xl border-2 border-line bg-surface p-4 no-underline">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={sev.tone}>
                      <span aria-hidden="true">{sev.icon}</span> {sev.label}
                    </Chip>
                    <Chip>{STATUS_LABEL[x.data.status]}</Chip>
                    {SOURCE_LABEL[x.data.source] && <Chip tone="hybrid">{SOURCE_LABEL[x.data.source]}</Chip>}
                    {x.pendingOps > 0 && <Chip tone="warn">Pending sync</Chip>}
                  </span>
                  <span className="mt-2 block text-xl font-bold text-primary underline underline-offset-4">{x.data.title}</span>
                  <span className="block text-muted">
                    {areaName(f.areas, x.data.areaId)} · {photos} {photos === 1 ? "photo" : "photos"}
                  </span>
                  {chips.length > 0 && (
                    <span className="mt-2 block">
                      <span className="text-base font-semibold text-muted">Counts toward</span>
                      <span className="mt-1 flex flex-wrap gap-2">
                        {chips.map((c) => (
                          <Chip key={c.key} tone="primary">
                            {c.label}
                          </Chip>
                        ))}
                      </span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function FindingEdit() {
  const f = useField();
  const { findingId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const base = `/assessments/${f.assessmentId}`;
  const existing = findingId ? f.findings.find((x) => x.id === findingId) : undefined;
  const control = search.get("control");
  const returnTo = search.get("return");
  const start: Finding = existing?.data ?? {
    id: uuid(),
    assessmentId: f.assessmentId,
    areaId: search.has("area") ? areaIdOf(search.get("area")!) : null,
    assetId: null,
    title: "",
    description: "",
    severity: (control && f.controls.get(control)?.defaultSeverity) || "medium",
    status: "draft",
    source: "assessor",
    controlIds: control ? [control] : [],
    suggestionId: null,
  };
  const [d, setD] = useState<Finding>(start);
  const [errors, setErrors] = useState<{ title?: string; controls?: string }>({});
  if (findingId && !existing) return <Banner tone="error">This finding is not on this device.</Banner>;
  const set = (p: Partial<Finding>) => setD({ ...d, ...p });
  const chips = frameworkChips(controlsFrameworks(d.controlIds, f.controls));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = { title: d.title.trim().length < 3 ? "Enter a title of at least 3 characters." : undefined, controls: d.controlIds.length ? undefined : "Choose at least one control." };
    setErrors(errs);
    if (errs.title || errs.controls || !f.ctx) return;
    await saveFinding(f.ctx, { ...d, title: d.title.trim(), recommendation: d.recommendation?.trim() ? d.recommendation : undefined });
    navigate(returnTo ?? `${base}/findings`);
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5 pb-32">
      <PageHeader title={existing ? "Edit finding" : "New finding"} back={{ to: returnTo ?? `${base}/findings`, label: returnTo ? "Back to walkthrough" : "Findings" }} />
      {existing && SOURCE_LABEL[existing.data.source] && <Banner tone="info">{SOURCE_LABEL[existing.data.source]}.</Banner>}
      <Field label="Title" value={d.title} onChange={(e) => set({ title: e.target.value })} error={errors.title} />
      <SeverityPicker value={d.severity} onChange={(s) => s && set({ severity: s })} />
      <AreaPicker areas={f.areas} value={d.areaId} onChange={(areaId) => set({ areaId })} />
      <ControlPicker controls={f.controls} value={d.controlIds} onChange={(controlIds) => set({ controlIds })} suggested={control ? [control] : []} />
      {errors.controls && (
        <p role="alert" className="font-semibold text-danger">
          ! {errors.controls}
        </p>
      )}
      {chips.length > 0 && (
        <Card>
          <p className="font-semibold">Counts toward</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {chips.map((c) => (
              <Chip key={c.key} tone="primary">
                {c.label}
              </Chip>
            ))}
          </div>
        </Card>
      )}
      <TextArea label="Description" value={d.description} onChange={(e) => set({ description: e.target.value })} />
      <TextArea label="Recommendation (optional)" value={d.recommendation ?? ""} onChange={(e) => set({ recommendation: e.target.value })} />
      <fieldset>
        <legend className="mb-1 font-semibold">Status</legend>
        <div className="flex flex-wrap gap-2">
          {(["draft", "confirmed", "resolved"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={d.status === s} onClick={() => set({ status: s })} className={"min-h-12 rounded-full border-2 px-4 font-semibold " + (d.status === s ? "border-primary bg-primary text-on-primary" : "border-line bg-surface")}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-line bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-2 sm:grid-cols-2">
          <Button type="submit" size="lg" disabled={!f.ctx}>
            Save finding
          </Button>
          {existing && f.ctx && (
            <Button
              variant="danger"
              size="lg"
              onClick={() => {
                if (!window.confirm("Delete this finding? Photos linked to it are kept.")) return;
                void deleteFinding(f.ctx!, existing.data).then(() => navigate(`${base}/findings`));
              }}
            >
              Delete finding
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
