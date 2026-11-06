import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { CreateClient, CreateSite } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { ClientCreated, ClientDetail as ClientDetailSchema, ClientSummary, Site } from "../api/schemas";
import { errorMessage, useAsync } from "../lib/useAsync";
import { Banner, Button, ButtonLink, Card, EmptyState, Field, Loading, PageHeader, TextArea } from "../components/ui";

function friendly(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "Your role cannot do this. Ask an admin.";
  return errorMessage(err);
}

export function ClientsList() {
  const api = useApi();
  const navigate = useNavigate();
  const list = useAsync(() => api.get("/clients", z.array(ClientSummary)), [api]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", industry: "", notes: "" });
  const [errors, setErrors] = useState<{ name?: string; form?: string }>({});
  const [duplicate, setDuplicate] = useState<ClientSummary | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent | null, allowDuplicate = false) {
    e?.preventDefault();
    const parsed = CreateClient.safeParse({
      name: form.name,
      industry: form.industry.trim() || undefined,
      notes: form.notes.trim() || undefined,
    });
    if (!parsed.success) {
      setErrors({ name: "Enter a client name." });
      return;
    }
    const dup = list.data?.find((c) => c.name.trim().toLowerCase() === parsed.data.name.toLowerCase());
    if (dup && !allowDuplicate) {
      setDuplicate(dup);
      return;
    }
    setErrors({});
    setDuplicate(null);
    setBusy(true);
    try {
      const created = await api.post("/clients", parsed.data, ClientCreated);
      navigate(`/clients/${created.id}`);
    } catch (err) {
      setErrors({ form: friendly(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          <>
            <ButtonLink to="/portfolio" variant="secondary" size="lg">
              Portfolio
            </ButtonLink>
            {!open && (
              <Button size="lg" onClick={() => setOpen(true)}>
                <span aria-hidden="true">+</span> Add client
              </Button>
            )}
          </>
        }
      />
      {open && (
        <Card as="section" className="mb-5">
          <form onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-4">
            <h2 className="text-xl font-bold">New client</h2>
            {errors.form && <Banner tone="error">{errors.form}</Banner>}
            <Field label="Client name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} required autoFocus />
            <Field label="Industry (optional)" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
            <TextArea label="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            {duplicate && (
              <Banner tone="warn" title={`A client named "${duplicate.name}" already exists.`}>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => navigate(`/clients/${duplicate.id}`)}>
                    Open existing
                  </Button>
                  <Button onClick={() => void save(null, true)}>Save anyway</Button>
                </div>
              </Banner>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="lg" disabled={busy}>
                {busy ? "Saving…" : "Save client"}
              </Button>
              <Button variant="secondary" size="lg" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {list.error ? <Banner tone="error">{errorMessage(list.error)}</Banner> : null}
      {list.loading && !list.data && <Loading label="Loading clients" />}
      {list.data && list.data.length === 0 && <EmptyState title="No clients yet">Add the organizations you assess.</EmptyState>}
      {list.data && list.data.length > 0 && (
        <ul className="flex flex-col gap-3">
          {list.data.map((c) => (
            <li key={c.id}>
              <Link to={`/clients/${c.id}`} className="block rounded-xl border-2 border-line bg-surface p-4">
                <span className="text-xl font-bold text-primary underline underline-offset-4">{c.name}</span>
                <span className="block text-muted">
                  {[c.industry, `${c.siteCount} ${c.siteCount === 1 ? "site" : "sites"}`].filter(Boolean).join(" · ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ClientDetail() {
  const { id = "" } = useParams();
  const api = useApi();
  const client = useAsync(() => api.get(`/clients/${encodeURIComponent(id)}`, ClientDetailSchema), [api, id]);
  const [form, setForm] = useState({ name: "", address: "", siteType: "" });
  const [errors, setErrors] = useState<{ name?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function addSite(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateSite.safeParse({
      clientId: id,
      name: form.name,
      address: form.address.trim() || undefined,
      siteType: form.siteType.trim() || undefined,
    });
    if (!parsed.success) {
      setErrors({ name: parsed.error.flatten().fieldErrors.name ? "Enter a site name." : undefined, form: parsed.error.flatten().fieldErrors.clientId ? "Invalid client." : undefined });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const site = await api.post("/sites", parsed.data, Site);
      setSaved(`Site "${site.name}" added.`);
      setForm({ name: "", address: "", siteType: "" });
      client.reload();
    } catch (err) {
      setErrors({ form: friendly(err) });
    } finally {
      setBusy(false);
    }
  }

  if (client.loading && !client.data) return <Loading label="Loading client" />;
  if (!client.data) return <Banner tone="error">{errorMessage(client.error) || "Client not found."}</Banner>;
  const c = client.data;
  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={c.industry ?? undefined}
        back={{ to: "/clients", label: "Clients" }}
        actions={
          <ButtonLink to={`/portfolio?clientId=${encodeURIComponent(c.id)}`} variant="secondary">
            Portfolio for this client
          </ButtonLink>
        }
      />
      {c.notes && <p className="mb-4 whitespace-pre-wrap">{c.notes}</p>}
      <section aria-labelledby="sites-h" className="mb-6">
        <h2 id="sites-h" className="mb-2 text-2xl font-bold">
          Sites
        </h2>
        {c.sites.length === 0 ? (
          <EmptyState title="No sites yet">Add a site below to start an assessment there.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {c.sites.map((s) => (
              <li key={s.id}>
                <Card>
                  <p className="text-xl font-bold">{s.name}</p>
                  <p className="text-muted">{[s.siteType, s.address].filter(Boolean).join(" · ") || "No address yet"}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Card as="section">
        <form onSubmit={(e) => void addSite(e)} noValidate className="flex flex-col gap-4">
          <h2 className="text-xl font-bold">Add a site</h2>
          {saved && <Banner tone="ok" live>{saved}</Banner>}
          {errors.form && <Banner tone="error">{errors.form}</Banner>}
          <Field label="Site name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={errors.name} required />
          <Field label="Address (optional)" autoComplete="street-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <Field label="Site type (optional)" hint="For example: office, warehouse, data center, retail" value={form.siteType} onChange={(e) => setForm({ ...form, siteType: e.target.value })} />
          <Button type="submit" size="lg" disabled={busy}>
            {busy ? "Saving…" : "Add site"}
          </Button>
        </form>
      </Card>
    </>
  );
}
