import { useEffect, useState } from "react";
import { frameworkName } from "../field/labels";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ControlDomain } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { fetchControl, fetchControls, fetchFrameworks } from "../api/library";
import type { FrameworkSummary, Relationship } from "../api/schemas";
import { Banner, Card, Chip, EmptyState, Field, Loading, PageHeader, SelectField, categoryTone } from "../components/ui";
import { errorMessage, useAsync } from "../lib/useAsync";

export const DOMAIN_LABELS: Record<string, string> = {
  PER: "Perimeter",
  ACC: "Access control",
  VSS: "Video surveillance",
  IDS: "Intrusion detection and alarms",
  LCK: "Locks and hardware",
  LGT: "Lighting",
  GRD: "Guard operations",
  POL: "Physical security policy",
  ENV: "Environmental design (CPTED)",
  GOV: "Cyber governance",
  IDN: "Cyber identification",
  PRT: "Cyber protection",
  DET: "Cyber detection",
  RSP: "Cyber response",
  RCV: "Cyber recovery",
  CRY: "Cryptography and PQC",
};

const RELATIONSHIP: Record<Relationship, { label: string; help: string }> = {
  satisfies: { label: "Satisfies", help: "This control fully addresses the requirement." },
  supports: { label: "Supports", help: "This control partly addresses the requirement." },
  informs: { label: "Informs", help: "Evidence from this control feeds the framework's analysis." },
};

function useFrameworkMap() {
  const api = useApi();
  const fw = useAsync(() => fetchFrameworks(api), [api]);
  const map = new Map<string, FrameworkSummary>((fw.data?.data ?? []).map((f) => [f.id, f]));
  return { fw, map };
}

function NeedsReviewBadge() {
  return (
    <Chip tone="warn">
      <span aria-hidden="true">!</span> Wording pending review
    </Chip>
  );
}

export function Library() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const framework = params.get("framework") ?? "";
  const domain = params.get("domain") ?? "";
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const { fw, map } = useFrameworkMap();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // Debounce typing so each keystroke is not a request.
  useEffect(() => {
    const t = setTimeout(() => text !== q && setParam("q", text.trim()), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const controls = useAsync(() => fetchControls(api, { framework, domain, q }), [api, framework, domain, q]);
  const list = controls.data?.data ?? [];

  return (
    <>
      <PageHeader title="Control library" subtitle="One shared control can count toward several frameworks." />
      <form role="search" className="mb-4 grid gap-3 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()}>
        <Field label="Search controls" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: lighting" />
        <SelectField label="Framework" value={framework} onChange={(e) => setParam("framework", e.target.value)}>
          <option value="">All frameworks</option>
          {(fw.data?.data ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.shortName}
            </option>
          ))}
        </SelectField>
        <SelectField label="Domain" value={domain} onChange={(e) => setParam("domain", e.target.value)}>
          <option value="">All domains</option>
          {ControlDomain.options.map((d) => (
            <option key={d} value={d}>
              {DOMAIN_LABELS[d] ?? d}
            </option>
          ))}
        </SelectField>
      </form>

      {controls.data?.fromCache && (
        <div className="mb-3">
          <Banner tone="info">Showing the library saved on this device.</Banner>
        </div>
      )}
      {controls.error ? <Banner tone="error">{errorMessage(controls.error)}</Banner> : null}
      {controls.loading && !controls.data && <Loading label="Loading controls" />}
      <p role="status" className="mb-2 text-muted">
        {controls.data ? `${list.length} ${list.length === 1 ? "control" : "controls"}` : ""}
      </p>
      {controls.data && list.length === 0 && <EmptyState title="No matching controls">Try a different search or clear a filter.</EmptyState>}
      <ul className="flex flex-col gap-3">
        {list.map((c) => {
          const fws = [...new Set(c.mappings.map((m) => m.frameworkId))];
          return (
            <li key={c.id}>
              <Link to={`/library/${encodeURIComponent(c.id)}`} className="block rounded-xl border-2 border-line bg-surface p-4">
                <span className="block text-xl font-bold text-primary underline underline-offset-4">{c.title}</span>
                <span className="block text-base font-semibold text-muted">
                  {c.id} · {DOMAIN_LABELS[c.domain] ?? c.domain}
                </span>
                <span className="mt-1 block">{c.objective}</span>
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  {c.status === "needs_review" && <NeedsReviewBadge />}
                  <span className="text-base text-muted">Counts toward:</span>
                  {fws.map((id) => {
                    const f = map.get(id);
                    return (
                      <Chip key={id} tone={categoryTone(f?.category ?? "")}>
                        {f?.shortName ?? frameworkName(id)}
                        {f && <span className="font-normal"> v{f.version}</span>}
                      </Chip>
                    );
                  })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ControlDetailScreen() {
  const { controlId = "" } = useParams();
  const api = useApi();
  const { map } = useFrameworkMap();
  const control = useAsync(() => fetchControl(api, controlId), [api, controlId]);

  if (control.loading && !control.data) return <Loading label="Loading control" />;
  if (!control.data) return <Banner tone="error">{errorMessage(control.error) || "Control not found."}</Banner>;
  const c = control.data.data;

  // Group mappings by framework so "one control, many frameworks" is obvious.
  const groups = new Map<string, typeof c.mappings>();
  for (const m of c.mappings) groups.set(m.frameworkId, [...(groups.get(m.frameworkId) ?? []), m]);

  return (
    <>
      <PageHeader
        title={c.title}
        back={{ to: "/library", label: "Control library" }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {c.id} · {DOMAIN_LABELS[c.domain] ?? c.domain} · default severity {c.defaultSeverity}
            </span>
            {c.status === "needs_review" && <NeedsReviewBadge />}
          </span>
        }
      />
      {control.data.fromCache && (
        <div className="mb-3">
          <Banner tone="info">Showing the copy saved on this device.</Banner>
        </div>
      )}
      <Card as="section" className="mb-4">
        <h2 className="text-xl font-bold">Objective</h2>
        <p className="mt-1">{c.objective}</p>
      </Card>

      <section aria-labelledby="counts-h" className="mb-4" data-testid="counts-toward">
        <h2 id="counts-h" className="text-2xl font-bold">
          Counts toward
        </h2>
        <p className="mb-2 text-muted">
          A finding on this control counts toward {c.mappings.length} {c.mappings.length === 1 ? "requirement" : "requirements"} in {groups.size}{" "}
          {groups.size === 1 ? "framework" : "frameworks"}.
        </p>
        <ul className="flex flex-col gap-3">
          {[...groups.entries()].map(([fwId, ms]) => {
            const f = map.get(fwId);
            return (
              <li key={fwId}>
                <Card>
                  <h3 className="flex flex-wrap items-center gap-2 text-xl font-bold">
                    {ms[0]?.frameworkShortName ?? f?.shortName ?? frameworkName(fwId)}
                    {f && <Chip tone={categoryTone(f.category)}>v{f.version}</Chip>}
                  </h3>
                  <ul className="mt-2 flex flex-col gap-3">
                    {ms.map((m) => (
                      <li key={m.requirementCode} className="border-l-4 border-primary pl-3">
                        <p className="font-semibold">
                          {m.requirementCode}: {m.requirementTitle}
                        </p>
                        <p className="text-base">
                          <strong>{RELATIONSHIP[m.relationship].label}</strong>: {RELATIONSHIP[m.relationship].help}
                        </p>
                        {m.rationale && <p className="text-base text-muted">{m.rationale}</p>}
                      </li>
                    ))}
                  </ul>
                </Card>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="q-h" className="mb-4">
        <h2 id="q-h" className="mb-2 text-2xl font-bold">
          Questions ({c.questions.length})
        </h2>
        <ol className="flex flex-col gap-3">
          {c.questions.map((qn) => (
            <li key={qn.id}>
              <Card>
                <p className="text-base font-semibold text-muted">{qn.id}</p>
                <p className="font-semibold">{qn.text}</p>
                <p className="mt-1 text-base">{qn.guidance}</p>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      {c.evidence.length > 0 && (
        <Card as="section">
          <h2 className="text-xl font-bold">Evidence to collect</h2>
          <ul className="mt-2 list-disc pl-6">
            {c.evidence.map((e, i) => (
              <li key={i}>
                <strong className="capitalize">{e.type}</strong>: {e.description}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
