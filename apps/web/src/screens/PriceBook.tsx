/**
 * Settings > Price book (admins): search, add, and edit items, and copy the starter template.
 * Items list the shared controls they remediate; quotes suggest them from matching findings.
 */
import { useEffect, useState, type FormEvent } from "react";
import { PriceBookItem, PriceCategory, PriceUnit } from "@sentinel/shared";
import { ApiError } from "../api/client";
import { fetchPriceBook, importTemplate, money, putPriceBookItem, TIER_LABEL } from "../api/phase4";
import { useApi, useCanAdmin } from "../auth/AuthContext";
import { errorMessage, useAsync } from "../lib/useAsync";
import { SettingsNav } from "../components/SettingsNav";
import { Banner, Button, Card, Chip, EmptyState, Field, Loading, PageHeader, SelectField, TextArea } from "../components/ui";

export const CATEGORY_LABEL: Record<string, string> = { hardware: "Hardware", software: "Software", labor: "Labor", service: "Service", subscription: "Subscription" };
export const UNIT_LABEL: Record<string, string> = { each: "each", ft: "foot", hour: "hour", lot: "lot", month: "month", year: "year" };

type Form = { id: string; sku: string; name: string; description: string; category: string; unit: string; materialCost: string; laborHours: string; defaultMarginPct: string; tier: string; controlIds: string; active: boolean; assetTypes: PriceBookItem["assetTypes"] };
const toForm = (i: PriceBookItem): Form => ({
  ...i,
  materialCost: String(i.materialCost),
  laborHours: String(i.laborHours),
  defaultMarginPct: String(i.defaultMarginPct),
  controlIds: i.controlIds.join(", "),
});
const blank = (): Form => ({ id: crypto.randomUUID(), sku: "", name: "", description: "", category: "hardware", unit: "each", materialCost: "0", laborHours: "0", defaultMarginPct: "35", tier: "any", controlIds: "", active: true, assetTypes: [] });
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

function ItemForm({ initial, isNew, onSaved, onCancel }: { initial: Form; isNew: boolean; onSaved: (i: PriceBookItem) => void; onCancel: () => void }) {
  const api = useApi();
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Form>) => setF({ ...f, ...p });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const parsed = PriceBookItem.safeParse({
      ...f,
      materialCost: num(f.materialCost),
      laborHours: num(f.laborHours),
      defaultMarginPct: num(f.defaultMarginPct),
      controlIds: f.controlIds.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean),
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const k = String(i.path[0]);
        errs[k] ??=
          k === "materialCost" ? "Enter a cost of 0 or more." : k === "laborHours" ? "Enter hours from 0 to 1000." : k === "defaultMarginPct" ? "Enter a margin from 0 to 95 percent." : k === "controlIds" ? "Use shared control ids such as SC-LGT-001, separated by commas." : k === "name" ? "Enter a name of at least 2 characters." : k === "sku" ? "Enter a SKU." : "Check this field.";
      }
      return setErrors(errs);
    }
    setErrors({});
    setBusy(true);
    try {
      onSaved(await putPriceBookItem(api, parsed.data));
    } catch (err) {
      if (err instanceof ApiError && err.code === "sku_exists") setErrors({ sku: "Another item already uses this SKU." });
      else setMsg(errorMessage(err) || "The item could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2" aria-label={isNew ? "New price book item" : `Edit ${initial.name}`}>
      <Field label="SKU" value={f.sku} maxLength={40} error={errors.sku} onChange={(e) => set({ sku: e.target.value })} />
      <Field label="Name" value={f.name} maxLength={120} error={errors.name} onChange={(e) => set({ name: e.target.value })} />
      <div className="sm:col-span-2">
        <TextArea label="Description" value={f.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} hint="Client-facing; becomes the quote line text." />
      </div>
      <SelectField label="Category" value={f.category} onChange={(e) => set({ category: e.target.value })}>
        {PriceCategory.options.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABEL[c]}
          </option>
        ))}
      </SelectField>
      <SelectField label="Unit" value={f.unit} onChange={(e) => set({ unit: e.target.value })}>
        {PriceUnit.options.map((u) => (
          <option key={u} value={u}>
            {UNIT_LABEL[u]}
          </option>
        ))}
      </SelectField>
      <Field label="Material cost per unit (USD)" type="number" inputMode="decimal" min={0} step="0.01" value={f.materialCost} error={errors.materialCost} onChange={(e) => set({ materialCost: e.target.value })} />
      <Field label="Labor hours per unit" type="number" inputMode="decimal" min={0} step="0.25" value={f.laborHours} error={errors.laborHours} onChange={(e) => set({ laborHours: e.target.value })} />
      <Field label="Default margin (%)" type="number" inputMode="decimal" min={0} max={95} step="1" value={f.defaultMarginPct} error={errors.defaultMarginPct} onChange={(e) => set({ defaultMarginPct: e.target.value })} />
      <SelectField label="Quote tier" value={f.tier} onChange={(e) => set({ tier: e.target.value })} hint="Where suggested lines go. All tiers puts it in every option.">
        <option value="any">All tiers</option>
        <option value="good">Good</option>
        <option value="better">Better</option>
        <option value="best">Best</option>
      </SelectField>
      <div className="sm:col-span-2">
        <Field label="Remediates controls" value={f.controlIds} error={errors.controlIds} hint="Shared control ids, separated by commas, for example SC-LGT-001. Findings on these controls suggest this item." onChange={(e) => set({ controlIds: e.target.value })} />
      </div>
      <label className="flex min-h-12 items-center gap-3 sm:col-span-2">
        <input type="checkbox" className="size-6" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
        <span className="font-semibold">Active: offered in new quotes</span>
      </label>
      {msg && (
        <div className="sm:col-span-2">
          <Banner tone="error">{msg}</Banner>
        </div>
      )}
      <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving" : "Save item"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PriceBookScreen() {
  const api = useApi();
  const isAdmin = useCanAdmin();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<Form | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [placeholderDismissed, setPlaceholderDismissed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const items = useAsync(() => (isAdmin ? fetchPriceBook(api, query) : Promise.resolve([])), [api, query, isAdmin]);

  if (!isAdmin)
    return (
      <>
        <PageHeader title="Price book" back={{ to: "/", label: "Home" }} />
        <Banner tone="info">Only workspace admins can manage the price book.</Banner>
      </>
    );

  async function runImport() {
    setMsg(null);
    try {
      const r = await importTemplate(api);
      setMsg({ tone: "ok", text: `Added ${r.added} ${r.added === 1 ? "item" : "items"}. Skipped ${r.skipped} that you already have.` });
      setPlaceholderDismissed(false);
      items.reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) || "The template could not be imported." });
    }
  }

  const list = items.data ?? [];
  return (
    <>
      <PageHeader
        title="Price book"
        subtitle="Settings"
        back={{ to: "/", label: "Home" }}
        actions={
          <>
            <Button onClick={() => (setAdding(blank()), setEditing(null))}>Add item</Button>
            <Button variant="secondary" onClick={() => void runImport()}>
              Import starter price book
            </Button>
          </>
        }
      />
      <SettingsNav />
      {msg && (
        <div className="mb-3">
          <Banner tone={msg.tone} live>
            {msg.text}
          </Banner>
        </div>
      )}
      {adding && (
        <Card as="section" className="mb-4 border-primary">
          <h2 className="mb-3 text-2xl font-bold">New item</h2>
          <ItemForm
            initial={adding}
            isNew
            onCancel={() => setAdding(null)}
            onSaved={(i) => {
              setAdding(null);
              setMsg({ tone: "ok", text: `${i.name} added.` });
              items.reload();
            }}
          />
        </Card>
      )}
      {list.some((i) => i.fromTemplate) && !placeholderDismissed && (
        <div className="mb-3">
          <Banner tone="warn" title="Placeholder prices" action={<Button variant="secondary" onClick={() => setPlaceholderDismissed(true)}>Dismiss</Button>}>
            These starter prices are illustrative placeholders, not market prices. Replace them with your own costs, labor hours, and margins before you send a quote.
          </Banner>
        </div>
      )}
      <div className="mb-3">
        <Field label="Search the price book" type="search" value={q} onChange={(e) => setQ(e.target.value)} hint="Name, SKU, or description" />
      </div>
      <p role="status" className="mb-2 text-muted">
        {items.data ? `${list.length} ${list.length === 1 ? "item" : "items"}` : ""}
      </p>
      {items.loading && !items.data && <Loading label="Loading price book" />}
      {items.error ? <Banner tone="error">{errorMessage(items.error)}</Banner> : null}
      {items.data && list.length === 0 && (
        <EmptyState title={query ? "No matching items" : "Your price book is empty"} action={!query ? <Button onClick={() => void runImport()}>Import starter price book</Button> : undefined}>
          {query ? "Try a different search." : "Import the starter price book to get going, or add your first item."}
        </EmptyState>
      )}
      <ul className="flex flex-col gap-3">
        {list.map((i) => (
          <li key={i.id} className="rounded-xl border-2 border-line bg-surface p-4" data-testid={`pb-${i.sku}`}>
            {editing === i.id ? (
              <ItemForm
                initial={toForm(i)}
                isNew={false}
                onCancel={() => setEditing(null)}
                onSaved={(saved) => {
                  setEditing(null);
                  setMsg({ tone: "ok", text: `${saved.name} saved.` });
                  items.reload();
                }}
              />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xl font-bold">{i.name}</p>
                  <p className="text-base text-muted">
                    {i.sku} · {CATEGORY_LABEL[i.category]} · per {UNIT_LABEL[i.unit]}
                  </p>
                  <p>
                    Cost {money(i.materialCost)}, {i.laborHours} labor h, {i.defaultMarginPct}% margin · {i.tier === "any" ? "All tiers" : TIER_LABEL[i.tier]}
                  </p>
                  {i.controlIds.length > 0 && <p className="text-base text-muted">Remediates {i.controlIds.join(", ")}</p>}
                  <span className="mt-1 flex flex-wrap gap-2">
                    {i.fromTemplate && <Chip tone="warn">! Placeholder price</Chip>}
                    {!i.active && <Chip>Inactive</Chip>}
                  </span>
                </div>
                <Button variant="secondary" onClick={() => (setEditing(i.id), setAdding(null))} aria-label={`Edit ${i.name}`}>
                  Edit
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
