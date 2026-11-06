/**
 * Settings > Branding (admins): name, logo, colors with a live contrast check, report footer,
 * contact line, and the "Powered by" credit (partner plan only may hide it, D-078). Saving applies
 * the branding app-wide at once.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { Branding, type BrandingResponse } from "@sentinel/shared";
import { ApiError } from "../api/client";
import { deleteLogo, fetchBranding, putBranding, putLogo } from "../api/phase4";
import { useApi, useCanAdmin } from "../auth/AuthContext";
import { useBranding } from "../branding/BrandingContext";
import { accessibleAlternative, contrastRatio, MIN_TEXT_CONTRAST, parseHex, safeLogoUrl, WHITE } from "../branding/theme";
import { errorMessage, useAsync } from "../lib/useAsync";
import { SettingsNav } from "../components/SettingsNav";
import { Banner, Button, Card, Field, Loading, Logo, PageHeader, TextArea } from "../components/ui";

const MAX_LOGO = 2 * 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg"];
const DEFAULT: Branding = { displayName: "", primaryColor: "#0b3d91", accentColor: "#b45309", reportFooter: "", contactEmail: null, contactPhone: null, website: null, showPoweredBy: true };

type Form = { displayName: string; primaryColor: string; accentColor: string; reportFooter: string; contactEmail: string; contactPhone: string; website: string; showPoweredBy: boolean };
const toForm = (b: Branding): Form => ({ ...b, contactEmail: b.contactEmail ?? "", contactPhone: b.contactPhone ?? "", website: b.website ?? "" });
const fromForm = (f: Form) => ({
  ...f,
  displayName: f.displayName.trim(),
  primaryColor: f.primaryColor.trim().toLowerCase(),
  accentColor: f.accentColor.trim().toLowerCase(),
  contactEmail: f.contactEmail.trim() || null,
  contactPhone: f.contactPhone.trim() || null,
  website: f.website.trim() || null,
});

const ratioText = (r: number | null) => (r === null ? "not a valid color" : `${r.toFixed(1)}:1`);

function ColorField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  const id = useId();
  const valid = !!parseHex(value);
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="font-semibold">{label}</legend>
      <p className="text-base text-muted">{hint}</p>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${id}-pick`} className="sr-only">
          {label} picker
        </label>
        <input id={`${id}-pick`} type="color" value={valid ? value : "#000000"} onChange={(e) => onChange(e.target.value)} className="h-12 w-16 cursor-pointer rounded-lg border-2 border-line bg-surface" />
        <div className="min-w-0 flex-1">
          <Field label={`${label} code`} value={value} maxLength={7} onChange={(e) => onChange(e.target.value)} error={valid ? undefined : "Use the form #RRGGBB, for example #0b3d91."} spellCheck={false} autoCapitalize="off" />
        </div>
      </div>
    </fieldset>
  );
}

function BrandPreview({ form, logoUrl }: { form: Form; logoUrl: string | null }) {
  const primary = parseHex(form.primaryColor) ? form.primaryColor : "#0b3d91";
  const accent = parseHex(form.accentColor) ? form.accentColor : "#b45309";
  const contact = [form.contactEmail, form.contactPhone, form.website].map((x) => x.trim()).filter(Boolean).join(" · ");
  return (
    <section aria-labelledby="brand-prev-h" className="rounded-xl border-2 border-line bg-white text-[#0b1220]" data-testid="brand-preview">
      <div className="flex items-center gap-3 rounded-t-lg p-3" style={{ background: primary, color: WHITE }}>
        {logoUrl ? <img src={logoUrl} alt="" className="size-10 rounded bg-white object-contain" /> : <Logo size={40} />}
        <p className="text-xl font-bold">{form.displayName.trim() || "Your company"}</p>
      </div>
      <div className="h-2" style={{ background: accent }} aria-hidden="true" />
      <div className="flex flex-col gap-2 p-3">
        <p className="font-bold">Security assessment report</p>
        <p>Findings, risk scores, and recommendations appear in your colors.</p>
        <span className="inline-flex min-h-12 items-center self-start rounded-lg px-4 font-semibold" style={{ background: primary, color: WHITE }}>
          Sample button
        </span>
        {form.reportFooter.trim() && <p className="border-t border-[#475569] pt-2 text-base">{form.reportFooter}</p>}
        {contact && <p className="text-base">{contact}</p>}
        {form.showPoweredBy && <p className="text-base">Powered by Sentinel Assess</p>}
      </div>
    </section>
  );
}

export function BrandingScreen() {
  const api = useApi();
  const isAdmin = useCanAdmin();
  const { setBranding } = useBranding();
  const current = useAsync(() => fetchBranding(api), [api]);
  const [server, setServer] = useState<BrandingResponse | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (current.data && !form) {
      setServer(current.data.data);
      setForm(toForm(current.data.data));
    }
  }, [current.data, form]);
  useEffect(() => {
    if (!file) return setFileUrl(null);
    const u = URL.createObjectURL(file);
    setFileUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  if (!isAdmin)
    return (
      <>
        <PageHeader title="Branding" back={{ to: "/", label: "Home" }} />
        <Banner tone="info">Only workspace admins can change branding.</Banner>
      </>
    );

  const f = form ?? toForm(DEFAULT);
  const set = (patch: Partial<Form>) => setForm({ ...f, ...patch });
  const ratio = contrastRatio(f.primaryColor, WHITE);
  const passes = ratio !== null && ratio >= MIN_TEXT_CONTRAST;
  const alt = !passes ? accessibleAlternative(f.primaryColor) : null;
  const accentRatio = contrastRatio(f.accentColor, WHITE);
  const standard = server?.plan !== "partner";
  const serverLogo = safeLogoUrl(server?.logoUrl, api.baseUrl);

  function pickFile(next: File | null) {
    setFileError(null);
    if (!next) return setFile(null);
    if (!LOGO_TYPES.includes(next.type)) return setFileError("Choose a PNG or JPEG image. SVG and other formats are not accepted."), setFile(null);
    if (next.size > MAX_LOGO) return setFileError("The logo must be 2 MB or smaller."), setFile(null);
    setFile(next);
  }

  async function uploadLogo() {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const b = await putLogo(api, file);
      setServer(b);
      setBranding(b);
      setFile(null);
      setMsg({ tone: "ok", text: "Logo uploaded. It was resized and saved as PNG without photo metadata." });
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof ApiError && e.status === 415 ? "That file type is not accepted. Use PNG or JPEG." : errorMessage(e) || "The logo could not be uploaded." });
    } finally {
      setBusy(false);
    }
  }

  async function removeLogo() {
    setBusy(true);
    setMsg(null);
    try {
      await deleteLogo(api);
      const b = server ? { ...server, logoUrl: null } : null;
      setServer(b);
      setBranding(b);
      setMsg({ tone: "ok", text: "Logo removed." });
    } catch (e) {
      setMsg({ tone: "error", text: errorMessage(e) || "The logo could not be removed." });
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!passes) return setMsg({ tone: "error", text: `White text on the primary color must reach ${MIN_TEXT_CONTRAST}:1. Choose a darker color${alt ? ` such as ${alt}` : ""}.` });
    const parsed = Branding.safeParse(fromForm(f));
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path[0];
      const text =
        path === "displayName" ? "Enter a display name." : path === "contactEmail" ? "Enter a valid contact email or leave it empty." : path === "website" ? "Enter the website as a full address starting with https://, or leave it empty." : "Check the fields and try again.";
      return setMsg({ tone: "error", text });
    }
    setBusy(true);
    try {
      const b = await putBranding(api, parsed.data);
      setServer(b);
      setForm(toForm(b));
      setBranding(b);
      setMsg({ tone: "ok", text: "Branding saved. The app, reports, quotes, and client portal now use it." });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setMsg({
        tone: "error",
        text:
          code === "contrast_too_low"
            ? "The server refused the primary color: white text on it is below 4.5:1."
            : code === "plan_required"
              ? "Hiding \"Powered by Sentinel Assess\" needs the partner plan."
              : errorMessage(err) || "Branding could not be saved.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Branding" subtitle="Settings" back={{ to: "/", label: "Home" }} />
      <SettingsNav />
      {current.loading && !form && <Loading label="Loading branding" />}
      {current.error && !form ? <Banner tone="error">{errorMessage(current.error) || "Branding could not be loaded."}</Banner> : null}
      {form && (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <form onSubmit={save} noValidate className="flex flex-col gap-4">
            <Card as="section" className="flex flex-col gap-3">
              <h2 className="text-2xl font-bold">Name and logo</h2>
              <Field label="Display name" value={f.displayName} maxLength={80} onChange={(e) => set({ displayName: e.target.value })} hint="Shown in the app header, reports, quotes, and the client portal." />
              <div className="flex flex-wrap items-center gap-3">
                {serverLogo ? <img src={serverLogo} alt="Current logo" className="size-16 rounded-lg border-2 border-line bg-white object-contain" /> : <p className="text-muted">No logo yet: the Sentinel shield is shown.</p>}
                {serverLogo && (
                  <Button variant="secondary" disabled={busy} onClick={() => void removeLogo()}>
                    Remove logo
                  </Button>
                )}
              </div>
              <Field label="Logo file" type="file" accept="image/png,image/jpeg" hint="PNG or JPEG, up to 2 MB. It is resized to fit 512 by 512 and photo metadata is removed." error={fileError ?? undefined} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              {fileUrl && (
                <div className="flex flex-wrap items-center gap-3">
                  <img src={fileUrl} alt="New logo preview" className="size-16 rounded-lg border-2 border-line bg-white object-contain" data-testid="logo-preview" />
                  <Button disabled={busy} onClick={() => void uploadLogo()}>
                    Upload logo
                  </Button>
                </div>
              )}
            </Card>
            <Card as="section" className="flex flex-col gap-4">
              <h2 className="text-2xl font-bold">Colors</h2>
              <ColorField label="Primary color" value={f.primaryColor} onChange={(v) => set({ primaryColor: v })} hint="Buttons, header, and links. White text sits on it, so it must be dark enough." />
              <div role="status" data-testid="contrast-check">
                {passes ? (
                  <Banner tone="ok">White text on this color: {ratioText(ratio)}. Passes (needs {MIN_TEXT_CONTRAST}:1).</Banner>
                ) : (
                  <Banner tone="warn" title={`White text on this color: ${ratioText(ratio)}. Needs ${MIN_TEXT_CONTRAST}:1.`} action={alt ? <Button variant="secondary" onClick={() => set({ primaryColor: alt })}>Use {alt}</Button> : undefined}>
                    {alt ? `A darker shade that passes: ${alt}.` : "Enter a valid color."}
                  </Banner>
                )}
              </div>
              <ColorField label="Accent color" value={f.accentColor} onChange={(v) => set({ accentColor: v })} hint="Stripes and highlights only; text never sits on it." />
              <p className="text-base text-muted" data-testid="accent-check">
                Accent against white: {ratioText(accentRatio)}
                {accentRatio !== null && accentRatio < 3 ? ". Below 3:1, so it may be hard to see as a line or border." : "."}
              </p>
            </Card>
            <Card as="section" className="flex flex-col gap-3">
              <h2 className="text-2xl font-bold">Reports and contact</h2>
              <TextArea label="Report footer" value={f.reportFooter} maxLength={500} onChange={(e) => set({ reportFooter: e.target.value })} hint="Printed at the bottom of reports and quotes." />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Contact email" type="email" autoComplete="off" value={f.contactEmail} maxLength={254} onChange={(e) => set({ contactEmail: e.target.value })} />
                <Field label="Contact phone" type="tel" autoComplete="off" value={f.contactPhone} maxLength={40} onChange={(e) => set({ contactPhone: e.target.value })} />
              </div>
              <Field label="Website" type="url" value={f.website} maxLength={200} onChange={(e) => set({ website: e.target.value })} hint="Full address, for example https://example.com" />
              <label className="flex min-h-12 items-center gap-3">
                <input type="checkbox" className="size-6" checked={f.showPoweredBy} disabled={standard && f.showPoweredBy} aria-describedby="powered-hint" onChange={(e) => set({ showPoweredBy: e.target.checked })} />
                <span className="font-semibold">Show "Powered by Sentinel Assess"</span>
              </label>
              <p id="powered-hint" className="text-base text-muted">
                {standard
                  ? "Your workspace is on the standard plan, which always shows this credit. The partner plan can turn it off; your Sentinel Assess contact can change the plan."
                  : "Your workspace is on the partner plan, so you may hide this credit on reports, quotes, and the portal."}
              </p>
            </Card>
            {msg && (
              <Banner tone={msg.tone} live>
                {msg.text}
              </Banner>
            )}
            <Button type="submit" size="lg" block disabled={busy}>
              {busy ? "Saving" : "Save branding"}
            </Button>
          </form>
          <div className="lg:sticky lg:top-4 lg:self-start">
            <h2 id="brand-prev-h" className="mb-2 text-2xl font-bold">
              Preview
            </h2>
            <BrandPreview form={f} logoUrl={fileUrl ?? serverLogo} />
          </div>
        </div>
      )}
    </>
  );
}
