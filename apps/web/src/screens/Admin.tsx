/**
 * Admin screens for one assessment: assessor assignment (online only) and the site's areas
 * (add and rename work offline through sync; reorder with Move up and Move down buttons, no
 * drag; delete needs a connection and an admin role).
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import { useApi, useCanAdmin } from "../auth/AuthContext";
import { ApiError, NetworkError } from "../api/client";
import { useField } from "../field/FieldContext";
import { saveArea } from "../field/repo";
import { Member } from "../field/schemas";
import { AREA_KIND_LABEL } from "../field/labels";
import { getDb, notifyLocalChange } from "../offline/db";
import { errorMessage, useAsync } from "../lib/useAsync";
import { AddAreaForm } from "./Walkthrough";
import { Banner, Button, Card, Field, Loading, PageHeader } from "../components/ui";

export function AssessorsScreen() {
  const f = useField();
  const api = useApi();
  const isAdmin = useCanAdmin();
  const members = useAsync(() => (f.online ? api.get("/members", z.array(Member)) : Promise.resolve(null)), [api, f.online]);
  const [selected, setSelected] = useState<string[]>(f.structure.assessors.map((a) => a.userId));
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/assessments/${f.assessmentId}`;

  if (!isAdmin) return <Banner tone="error">Only an admin can assign assessors.</Banner>;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.request(`/assessments/${encodeURIComponent(f.assessmentId)}/assessors`, { method: "PUT", body: { userIds: selected }, schema: z.object({ userIds: z.array(z.string()) }) });
      setSelected(res.userIds);
      setMsg({ tone: "ok", text: "Assessors saved. They now see this assessment in their list." });
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof NetworkError ? "No connection. Try again when you are online." : errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Assign assessors" subtitle={f.assessment.title} back={{ to: base, label: "Assessment" }} />
      {!f.online && <Banner tone="warn">Assigning assessors needs a connection.</Banner>}
      {members.loading && f.online && <Loading label="Loading members" />}
      {members.error ? <Banner tone="error">{errorMessage(members.error)}</Banner> : null}
      {members.data && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xl font-bold">Workspace members</legend>
          {members.data.filter((m) => m.role !== "client_viewer" && m.role !== "viewer" && m.status !== "disabled").map((m) => (
            <label key={m.userId} className="flex min-h-14 items-center gap-3 rounded-xl border-2 border-line bg-surface px-4">
              <input type="checkbox" className="size-6" checked={selected.includes(m.userId)} onChange={(e) => setSelected(e.target.checked ? [...selected, m.userId] : selected.filter((x) => x !== m.userId))} />
              <span>
                <span className="block font-semibold">{m.name}</span>
                <span className="block text-base text-muted">
                  {m.email} · {m.role}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {msg && (
        <div className="mt-3">
          <Banner tone={msg.tone} live>
            {msg.text}
          </Banner>
        </div>
      )}
      <Button size="lg" block className="mt-4" disabled={busy || !f.online || !members.data} onClick={() => void save()}>
        {busy ? "Saving…" : "Save assessors"}
      </Button>
    </>
  );
}

export function AreasScreen() {
  const f = useField();
  const api = useApi();
  const isAdmin = useCanAdmin();
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const base = `/assessments/${f.assessmentId}`;
  const areas = f.areas;
  useEffect(() => setMsg(null), [areas.length]);

  async function move(i: number, dir: -1 | 1) {
    const a = areas[i];
    const b = areas[i + dir];
    if (!a || !b || !f.ctx) return;
    await saveArea(f.ctx, f.assessmentId, { ...a.data, sortOrder: b.data.sortOrder === a.data.sortOrder ? i + dir : b.data.sortOrder });
    await saveArea(f.ctx, f.assessmentId, { ...b.data, sortOrder: b.data.sortOrder === a.data.sortOrder ? i : a.data.sortOrder });
  }

  async function rename(id: string) {
    const a = areas.find((x) => x.id === id);
    if (!a || !f.ctx || !name.trim()) return;
    await saveArea(f.ctx, f.assessmentId, { ...a.data, name: name.trim() });
    setRenaming(null);
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this area from the site? This cannot be undone.")) return;
    try {
      await api.request(`/areas/${encodeURIComponent(id)}`, { method: "DELETE" });
      await (await getDb()).delete("areas", id);
      notifyLocalChange();
      setMsg({ tone: "ok", text: "Area deleted." });
    } catch (err) {
      if (err instanceof ApiError && err.code === "area_in_use") setMsg({ tone: "error", text: "This area has answers, findings, or photos, so it cannot be deleted. Rename it instead." });
      else setMsg({ tone: "error", text: err instanceof NetworkError ? "Deleting an area needs a connection." : errorMessage(err) });
    }
  }

  return (
    <>
      <PageHeader title="Areas" subtitle="Areas belong to the site and are reused by later assessments." back={{ to: base, label: "Assessment" }} />
      {msg && (
        <div className="mb-3">
          <Banner tone={msg.tone} live>
            {msg.text}
          </Banner>
        </div>
      )}
      <ol className="mb-6 flex flex-col gap-3">
        {areas.map((a, i) => (
          <li key={a.id}>
            <Card>
              {renaming === a.id ? (
                <div className="flex flex-col gap-2">
                  <Field label={`New name for ${a.data.name}`} value={name} onChange={(e) => setName(e.target.value)} />
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                    <Button onClick={() => void rename(a.id)}>Save name</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xl font-bold">{a.data.name}</p>
                  <p className="text-muted">
                    {AREA_KIND_LABEL[a.data.kind]}
                    {a.pendingOps > 0 ? " · Pending sync" : ""}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Button variant="secondary" disabled={i === 0 || !f.ctx} onClick={() => void move(i, -1)}>
                      Move up<span className="sr-only"> {a.data.name}</span>
                    </Button>
                    <Button variant="secondary" disabled={i === areas.length - 1 || !f.ctx} onClick={() => void move(i, 1)}>
                      Move down<span className="sr-only"> {a.data.name}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={!f.ctx}
                      onClick={() => {
                        setRenaming(a.id);
                        setName(a.data.name);
                      }}
                    >
                      Rename<span className="sr-only"> {a.data.name}</span>
                    </Button>
                    {isAdmin && (
                      <Button variant="danger" disabled={!f.online} onClick={() => void remove(a.id)}>
                        Delete<span className="sr-only"> {a.data.name}</span>
                      </Button>
                    )}
                  </div>
                </>
              )}
            </Card>
          </li>
        ))}
      </ol>
      {f.ctx && (
        <Card as="section">
          <AddAreaForm />
        </Card>
      )}
    </>
  );
}
