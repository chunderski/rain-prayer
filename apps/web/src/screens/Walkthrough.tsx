/**
 * Guided walkthrough (US-2.01 to US-2.04): choose or add an area, then go section by section, one
 * control at a time. Answers save on every tap (local first, then the sync outbox). A "No" that
 * means the control is not in place creates a draft finding and offers a photo. Primary actions
 * sit in a fixed bottom bar for one-handed use.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Answer, AnswerValue, Area, Finding } from "@sentinel/shared";
import { areaIdOf, areaKeyOf, areaName, useField, type FieldData } from "../field/FieldContext";
import { saveAnswer, saveArea, saveFinding } from "../field/repo";
import { getPosition, getSkipped, setPosition, setSkipped, type Position } from "../field/walkthrough";
import { AREA_KINDS, AREA_KIND_LABEL, frameworkChips, isDeficient, type AreaKindValue } from "../field/labels";
import type { WalkthroughControl, WalkthroughSection } from "../field/schemas";
import { useLocal } from "../lib/useLocal";
import { uuid, type LocalRecord } from "../offline/db";
import { AnswerInput } from "../components/AnswerInput";
import { PersistStorage } from "../components/PersistStorage";
import { CaptureButton } from "../photos/CaptureButton";
import { Banner, Button, ButtonLink, Card, Chip, Field, PageHeader } from "../components/ui";

interface Step {
  section: WalkthroughSection;
  control: WalkthroughControl;
}

const answerKey = (questionId: string, areaId: string | null) => `${questionId}|${areaId ?? ""}`;

export function answersIndex(answers: LocalRecord<Answer>[]) {
  const m = new Map<string, LocalRecord<Answer>>();
  for (const a of answers) m.set(answerKey(a.data.questionId, a.data.areaId), a);
  return m;
}

export type ControlState = "answered" | "partly" | "skipped" | "todo";

export function controlState(c: WalkthroughControl, areaId: string | null, idx: Map<string, LocalRecord<Answer>>, skipped: string[]): ControlState {
  const n = c.questions.filter((q) => idx.has(answerKey(q.id, areaId))).length;
  if (n === c.questions.length && n > 0) return "answered";
  if (skipped.includes(c.id)) return "skipped";
  return n > 0 ? "partly" : "todo";
}

const STATE_LABEL: Record<ControlState, string> = { answered: "Answered", partly: "In progress", skipped: "Skipped", todo: "Not started" };

function progressFor(f: FieldData, areaId: string | null, skipped: string[]) {
  const idx = answersIndex(f.answers);
  let answered = 0;
  let skip = 0;
  let total = 0;
  for (const s of f.structure.sections)
    for (const c of s.controls) {
      total++;
      const st = controlState(c, areaId, idx, skipped);
      if (st === "answered") answered++;
      else if (st === "skipped") skip++;
    }
  return { answered, skipped: skip, total, remaining: total - answered - skip };
}

// ---------- add area ----------

export function AddAreaForm({ onAdded, compact }: { onAdded?: (a: Area) => void; compact?: boolean }) {
  const f = useField();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AreaKindValue>("other");
  const [error, setError] = useState<string | null>(null);
  const siteId = f.assessment.siteId;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter an area name.");
    if (!f.ctx) return;
    const area: Area = { id: uuid(), siteId, name: name.trim(), kind, sortOrder: Math.max(0, ...f.areas.map((a) => a.data.sortOrder + 1)) };
    await saveArea(f.ctx, f.assessmentId, area);
    setName("");
    setKind("other");
    setError(null);
    onAdded?.(area);
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3">
      {!compact && <h2 className="text-xl font-bold">Add an area</h2>}
      <Field label="Area name" value={name} onChange={(e) => setName(e.target.value)} error={error ?? undefined} hint="For example: Loading dock, Lobby, Server room" />
      <fieldset>
        <legend className="mb-1 font-semibold">Kind of area</legend>
        <div className="flex flex-wrap gap-2">
          {AREA_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={"min-h-12 rounded-full border-2 px-4 font-semibold " + (kind === k ? "border-primary bg-primary text-on-primary" : "border-line bg-surface text-ink")}
            >
              {kind === k && <span aria-hidden="true">✓ </span>}
              {AREA_KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </fieldset>
      <Button type="submit" size="lg">
        Add area
      </Button>
    </form>
  );
}

// ---------- area picker ----------

export function WalkthroughHome() {
  const f = useField();
  const navigate = useNavigate();
  const base = `/assessments/${f.assessmentId}`;
  const keys = [null, ...f.areas.map((a) => a.id)];
  const skips = useLocal(async () => Object.fromEntries(await Promise.all(keys.map(async (k) => [areaKeyOf(k), await getSkipped(f.assessmentId, areaKeyOf(k))] as const))), [f.assessmentId, keys.join()]);
  const resume = useLocal(() => getPosition(f.assessmentId), [f.assessmentId]);
  const pos = resume.data;
  const resumeControl = pos ? f.controls.get(pos.controlId) : undefined;
  const canWrite = !!f.ctx;

  return (
    <>
      <PageHeader title="Walkthrough" subtitle={f.assessment.title} back={{ to: base, label: "Assessment" }} />
      <div className="flex flex-col gap-4">
        {f.walkthroughError && <Banner tone="error" title="The walkthrough is not available">{f.walkthroughError}</Banner>}
        {f.fromCache && (
          <Banner tone="info" title="Using the copy saved on this device">
            Your answers and photos are saved here and sync when you are back online.
          </Banner>
        )}
        {pos && resumeControl && (
          <Card className="border-primary">
            <p className="font-semibold">Continue where you left off</p>
            <p className="text-muted">
              {areaName(f.areas, areaIdOf(pos.areaKey))} · {resumeControl.title}
            </p>
            <ButtonLink to={`${base}/walkthrough/${pos.areaKey}`} size="lg" block className="mt-3">
              Continue walkthrough
            </ButtonLink>
          </Card>
        )}
        <PersistStorage />
        <section aria-labelledby="areas-h">
          <h2 id="areas-h" className="mb-2 text-2xl font-bold">
            Choose an area
          </h2>
          <ul className="flex flex-col gap-3">
            {keys.map((areaId) => {
              const key = areaKeyOf(areaId);
              const p = progressFor(f, areaId, skips.data?.[key] ?? []);
              return (
                <li key={key}>
                  <Link to={`${base}/walkthrough/${key}`} className="block rounded-xl border-2 border-line bg-surface p-4 no-underline">
                    <span className="block text-xl font-bold text-primary underline underline-offset-4">{areaName(f.areas, areaId)}</span>
                    <span className="mt-1 block text-muted">
                      {p.answered} of {p.total} controls answered · {p.skipped} skipped · {p.remaining} remaining
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
        {canWrite && (
          <Card as="section">
            <AddAreaForm onAdded={(a) => navigate(`${base}/walkthrough/${a.id}`)} />
          </Card>
        )}
      </div>
    </>
  );
}

// ---------- one control at a time ----------

export function WalkthroughStep() {
  const f = useField();
  const { areaKey = "site" } = useParams();
  const navigate = useNavigate();
  const areaId = areaIdOf(areaKey);
  const base = `/assessments/${f.assessmentId}`;
  const steps = useMemo<Step[]>(() => [...f.structure.sections].sort((a, b) => a.order - b.order).flatMap((s) => s.controls.map((c) => ({ section: s, control: c }))), [f.structure]);
  const idx = useMemo(() => answersIndex(f.answers), [f.answers]);
  const skippedQ = useLocal(() => getSkipped(f.assessmentId, areaKey), [f.assessmentId, areaKey]);
  const skipped = skippedQ.data ?? [];
  const [i, setI] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ findingId: string; title: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Resume at the saved position for this area, else the first control not yet answered.
  useEffect(() => {
    if (i !== null || skippedQ.data === undefined) return;
    void getPosition(f.assessmentId).then((p: Position | undefined) => {
      const saved = p && p.areaKey === areaKey ? steps.findIndex((s) => s.control.id === p.controlId) : -1;
      const firstOpen = steps.findIndex((s) => controlState(s.control, areaId, idx, skipped) !== "answered");
      setI(saved >= 0 ? saved : firstOpen >= 0 ? firstOpen : 0);
    });
  }, [i, skippedQ.data, f.assessmentId, areaKey, steps, areaId, idx, skipped]);

  useEffect(() => {
    if (i === null || i >= steps.length) return;
    const s = steps[i]!;
    void setPosition(f.assessmentId, { areaKey, sectionId: s.section.id, controlId: s.control.id });
  }, [i, steps, f.assessmentId, areaKey]);

  const go = (n: number) => {
    setNotice(null);
    setI(n);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  if (i === null) return <p role="status">Loading walkthrough…</p>;
  if (!steps.length) return <Banner tone="info">This assessment has no controls to walk through.</Banner>;

  const progress = progressFor(f, areaId, skipped);
  const done = i >= steps.length;
  const step = steps[Math.min(i, steps.length - 1)]!;
  const sections = [...f.structure.sections].sort((a, b) => a.order - b.order);
  const sectionNo = sections.findIndex((s) => s.id === step.section.id) + 1;
  const controlFindings = f.findings.filter((x) => x.data.areaId === areaId && x.data.controlIds.includes(step.control.id));
  const deficiencyFinding = controlFindings[0];

  async function answer(q: WalkthroughControl["questions"][number], value: AnswerValue, notes?: string) {
    if (!f.ctx) return;
    const existing = idx.get(answerKey(q.id, areaId));
    const a: Answer = {
      id: existing?.id ?? uuid(),
      assessmentId: f.assessmentId,
      questionId: q.id,
      areaId,
      value,
      ...(notes ?? existing?.data.notes ? { notes: notes ?? existing?.data.notes } : {}),
      answeredAt: new Date().toISOString(),
    };
    await saveAnswer(f.ctx, a);
    if (skipped.includes(step.control.id)) await setSkipped(f.assessmentId, areaKey, skipped.filter((x) => x !== step.control.id));
    // US-2.02: a deficient answer creates a draft finding linked to this control and asks for a photo.
    if (isDeficient(q, value) && !deficiencyFinding) {
      const finding: Finding = {
        id: uuid(),
        assessmentId: f.assessmentId,
        areaId,
        assetId: null,
        title: `${step.control.title}: not in place`.slice(0, 200),
        description: q.text,
        severity: step.control.defaultSeverity,
        status: "draft",
        source: "assessor",
        controlIds: [step.control.id],
        suggestionId: null,
      };
      await saveFinding(f.ctx, finding);
      setNotice({ findingId: finding.id, title: finding.title });
    }
  }

  async function skip() {
    if (!skipped.includes(step.control.id)) await setSkipped(f.assessmentId, areaKey, [...skipped, step.control.id]);
    go(i! + 1);
  }

  const chips = frameworkChips(step.control.frameworks, f.requirementTitle);

  return (
    <div className="pb-48">
      <PageHeader title={areaName(f.areas, areaId)} back={{ to: `${base}/walkthrough`, label: "Areas" }} />
      <p className="mb-1 font-semibold" data-testid="walkthrough-progress">
        {progress.answered} of {progress.total} controls answered · {progress.skipped} skipped
      </p>
      <div className="mb-4 h-3 w-full overflow-hidden rounded-full border-2 border-line bg-surface" aria-hidden="true">
        <div className="h-full bg-primary" style={{ width: `${progress.total ? Math.round((progress.answered / progress.total) * 100) : 0}%` }} />
      </div>

      <details className="mb-4 rounded-xl border-2 border-line bg-surface">
        <summary className="flex min-h-12 cursor-pointer items-center px-4 font-semibold">All sections and skipped items</summary>
        <ol className="flex flex-col gap-3 px-4 pb-4">
          {sections.map((s, si) => {
            const answered = s.controls.filter((c) => controlState(c, areaId, idx, skipped) === "answered").length;
            return (
              <li key={s.id}>
                <p className="font-bold">
                  {si + 1}. {s.title} <span className="font-normal text-muted">({answered} of {s.controls.length})</span>
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {s.controls.map((c) => {
                    const st = controlState(c, areaId, idx, skipped);
                    return (
                      <li key={c.id}>
                        <button type="button" onClick={() => go(steps.findIndex((x) => x.control.id === c.id))} className="flex min-h-12 w-full items-center justify-between gap-2 rounded-lg border-2 border-line px-3 text-left">
                          <span>{c.title}</span>
                          <Chip tone={st === "answered" ? "ok" : st === "skipped" ? "warn" : "neutral"}>{STATE_LABEL[st]}</Chip>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      </details>

      {done ? (
        <Card as="section">
          <h2 ref={headingRef} tabIndex={-1} className="text-2xl font-bold">
            End of this area
          </h2>
          <p className="mt-2">
            {progress.answered} answered, {progress.skipped} skipped, {progress.remaining} not started. Skipped items stay on the list above until you answer them.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <ButtonLink to={`${base}/walkthrough`} size="lg" block>
              Choose another area
            </ButtonLink>
            <ButtonLink to={`${base}/findings`} variant="secondary" size="lg" block>
              Review findings
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <article aria-labelledby="control-h" className="flex flex-col gap-4">
          <p className="text-muted">
            Section {sectionNo} of {sections.length}: <strong className="text-ink">{step.section.title}</strong> · Control {i + 1} of {steps.length}
          </p>
          <Card>
            <h2 id="control-h" ref={headingRef} tabIndex={-1} className="text-2xl font-bold">
              {step.control.title}
            </h2>
            <p className="mt-1">{step.control.objective}</p>
            {chips.length > 0 && (
              <div className="mt-3">
                <p className="text-base font-semibold text-muted">Counts toward</p>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {chips.map((c) => (
                    <li key={c.key}>
                      <Chip tone="primary">{c.label}</Chip>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {notice && (
            <Banner tone="warn" title="Draft finding added" live>
              {notice.title}. Take a photo of the problem with the camera button below.
            </Banner>
          )}

          {step.control.questions.map((q, qi) => {
            const rec = idx.get(answerKey(q.id, areaId));
            return (
              <QuestionCard key={q.id} index={qi + 1} question={q} record={rec} onAnswer={(v, n) => void answer(q, v, n)} />
            );
          })}

          {controlFindings.length > 0 && (
            <Card>
              <h3 className="text-lg font-bold">Findings for this control</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {controlFindings.map((x) => (
                  <li key={x.id}>
                    <Link to={`${base}/findings/${x.id}`} className="inline-flex min-h-12 items-center font-semibold text-primary underline underline-offset-4">
                      {x.data.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </article>
      )}

      {!done && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-line bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3" role="group" aria-label="Walkthrough actions">
          <div className="mx-auto flex max-w-5xl flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <CaptureButton
                ctx={f.ctx}
                context={{ assessmentId: f.assessmentId, areaId, controlIds: [step.control.id], findingId: notice?.findingId ?? deficiencyFinding?.id ?? null }}
                pendingUploads={f.photos.filter((p) => p.upload !== "done").length}
                onCaptured={(ids) =>
                  navigate(`${base}/photos/${ids[0]}/tag?next=${encodeURIComponent(ids.slice(1).join(","))}&return=${encodeURIComponent(`${base}/walkthrough/${areaKey}`)}`)
                }
              />
              <ButtonLink
                to={`${base}/findings/new?control=${encodeURIComponent(step.control.id)}&area=${areaKey}&return=${encodeURIComponent(`${base}/walkthrough/${areaKey}`)}`}
                variant="secondary"
                size="lg"
                block
              >
                Add finding
              </ButtonLink>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" size="lg" disabled={i === 0} onClick={() => go(i - 1)}>
                Back
              </Button>
              <Button variant="secondary" size="lg" onClick={() => void skip()}>
                Skip
              </Button>
              <Button size="lg" onClick={() => go(i + 1)}>
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ index, question: q, record, onAnswer }: { index: number; question: WalkthroughControl["questions"][number]; record: LocalRecord<Answer> | undefined; onAnswer: (v: AnswerValue, notes?: string) => void }) {
  const [noteOpen, setNoteOpen] = useState(!!record?.data.notes);
  const [note, setNote] = useState(record?.data.notes ?? "");
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setNote(record?.data.notes ?? ""), [record?.data.notes]);
  const saveNote = (text: string) => {
    if (record && text !== (record.data.notes ?? "")) onAnswer(record.data.value, text);
  };
  return (
    <Card as="section">
      <h3 className="text-xl font-bold" id={`q-${q.id}`}>
        <span className="text-muted">{index}. </span>
        {q.text}
      </h3>
      <details className="mt-2">
        <summary className="inline-flex min-h-12 cursor-pointer items-center font-semibold text-primary underline underline-offset-4">How to check</summary>
        <p className="mt-1 whitespace-pre-wrap">{q.guidance}</p>
      </details>
      <div className="mt-3">
        <AnswerInput question={q} value={record?.data.value} onChange={(v) => onAnswer(v)} />
      </div>
      {record && record.pendingOps > 0 && <p className="mt-2 text-base text-muted">Saved on this device</p>}
      {noteOpen ? (
        <div className="mt-3 flex flex-col gap-1">
          <label htmlFor={`note-${q.id}`} className="font-semibold">
            Note
          </label>
          {!record && <p className="text-base text-muted">Answer the question first; the note is saved with the answer.</p>}
          <textarea
            id={`note-${q.id}`}
            rows={3}
            value={note}
            disabled={!record}
            onChange={(e) => {
              setNote(e.target.value);
              if (noteTimer.current) clearTimeout(noteTimer.current);
              const text = e.target.value;
              noteTimer.current = setTimeout(() => saveNote(text), 600);
            }}
            onBlur={() => saveNote(note)}
            className="block min-h-12 w-full rounded-lg border-2 border-line bg-surface px-3 py-2 text-lg text-ink"
          />
        </div>
      ) : (
        <Button variant="ghost" className="mt-2" onClick={() => setNoteOpen(true)}>
          Add note
        </Button>
      )}
    </Card>
  );
}
