/**
 * Photos for an assessment: the list (with "Needs a finding" filter, US-2.06), the tagging sheet
 * shown right after capture (US-2.05 to US-2.07), and the photo detail with AI suggestions.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Asset, PhotoMeta } from "@sentinel/shared";
import { areaName, useField } from "../field/FieldContext";
import { saveAsset, updatePhotoTags } from "../field/repo";
import { ASSET_TYPES, SEVERITY, assetTypeLabel, type SeverityValue } from "../field/labels";
import { uuid, type LocalPhoto } from "../offline/db";
import { usePhotoUrl } from "../photos/usePhotoUrl";
import { CaptureButton } from "../photos/CaptureButton";
import { currentPosition } from "../photos/process";
import { AreaPicker, ControlPicker, SeverityPicker } from "../components/FieldPickers";
import { SuggestionReview } from "../components/SuggestionReview";
import { Banner, Button, ButtonLink, Card, Chip, EmptyState, Field, PageHeader, SelectField, TextArea } from "../components/ui";

export function uploadLabel(p: LocalPhoto): { text: string; tone: "ok" | "warn" | "danger" } {
  if (p.lastUploadError && p.nextUploadAt === Number.MAX_SAFE_INTEGER) return { text: "Upload refused", tone: "danger" };
  if (p.upload === "done" || p.serverStatus === "stored") return { text: "Uploaded", tone: "ok" };
  return { text: "Pending sync", tone: "warn" };
}

function Thumb({ photo, className }: { photo: LocalPhoto<PhotoMeta>; className?: string }) {
  const url = usePhotoUrl(photo, "thumb");
  const f = useField();
  const alt = `Photo, ${areaName(f.areas, photo.data.areaId)}, ${new Date(photo.data.capturedAt).toLocaleString()}`;
  return url ? (
    <img src={url} alt={alt} className={"aspect-[4/3] w-full rounded-lg border-2 border-line object-cover " + (className ?? "")} />
  ) : (
    <div role="img" aria-label={alt} className={"flex aspect-[4/3] w-full items-center justify-center rounded-lg border-2 border-dashed border-line text-muted " + (className ?? "")}>
      Preview not on this device
    </div>
  );
}

export function PhotosList() {
  const f = useField();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | "untagged">("all");
  const base = `/assessments/${f.assessmentId}`;
  const photos = [...f.photos].sort((a, b) => b.data.capturedAt.localeCompare(a.data.capturedAt));
  const shown = filter === "untagged" ? photos.filter((p) => !p.data.findingId) : photos;
  return (
    <>
      <PageHeader title="Photos" subtitle={f.assessment.title} back={{ to: base, label: "Assessment" }} />
      <CaptureButton
        ctx={f.ctx}
        context={{ assessmentId: f.assessmentId, areaId: null, controlIds: [], findingId: null }}
        pendingUploads={f.photos.filter((p) => p.upload !== "done").length}
        onCaptured={(ids) => navigate(`${base}/photos/${ids[0]}/tag?next=${encodeURIComponent(ids.slice(1).join(","))}`)}
      />
      <div className="my-4 flex flex-wrap gap-2" role="group" aria-label="Filter photos">
        {(["all", "untagged"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={"min-h-12 rounded-full border-2 px-4 font-semibold " + (filter === k ? "border-primary bg-primary text-on-primary" : "border-line bg-surface")}>
            {k === "all" ? `All (${photos.length})` : `Needs a finding (${photos.filter((p) => !p.data.findingId).length})`}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No photos here yet">Take photos from the walkthrough or with the button above.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {shown.map((p) => {
            const s = uploadLabel(p);
            return (
              <li key={p.id}>
                <Link to={`${base}/photos/${p.id}`} className="block rounded-xl border-2 border-line bg-surface p-2 no-underline">
                  <Thumb photo={p} />
                  <span className="mt-1 block font-semibold text-ink">{areaName(f.areas, p.data.areaId)}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <Chip tone={s.tone}>{s.text}</Chip>
                    {p.data.severity && <Chip tone={SEVERITY[p.data.severity].tone}>{SEVERITY[p.data.severity].label}</Chip>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------- tagging sheet ----------

export function PhotoTagScreen() {
  const f = useField();
  const { photoId = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const base = `/assessments/${f.assessmentId}`;
  const photo = f.photos.find((p) => p.id === photoId);
  const [draft, setDraft] = useState<PhotoMeta | null>(null);
  const [newAsset, setNewAsset] = useState("");
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (photo && (!draft || draft.id !== photo.id)) setDraft(photo.data);
  }, [photo, draft]);

  const returnTo = search.get("return");
  const queue = (search.get("next") ?? "").split(",").filter(Boolean);
  const url = usePhotoUrl(photo, "full");
  if (!photo || !draft) return <Banner tone="error">This photo is not on this device.</Banner>;

  const set = (patch: Partial<PhotoMeta>) => setDraft({ ...draft, ...patch });
  const assets = f.assets.filter((a) => draft.areaId === null || a.data.areaId === draft.areaId || a.data.areaId === null);
  const contextControls = draft.areaId !== undefined ? [...new Set([...draft.controlIds, ...f.findings.filter((x) => x.data.areaId === draft.areaId).flatMap((x) => x.data.controlIds)])] : [];
  const suggestions = [...contextControls, ...[...f.controls.values()].filter((c) => draft.assetType && c.assetTypes.includes(draft.assetType)).map((c) => c.id)].slice(0, 8);

  async function addAsset() {
    if (!f.ctx || !newAsset.trim()) return;
    const asset: Asset = { id: uuid(), assessmentId: f.assessmentId, areaId: draft!.areaId, assetType: draft!.assetType ?? "other", label: newAsset.trim() };
    await saveAsset(f.ctx, asset);
    set({ assetId: asset.id, assetType: draft!.assetType ?? asset.assetType });
    setNewAsset("");
  }

  async function includeLocation() {
    setLocating(true);
    setLocError(null);
    const gps = await currentPosition();
    setLocating(false);
    if (gps) set({ gps });
    else setLocError("Location is not available. The photo is saved without it.");
  }

  async function save(next: "done" | "another") {
    if (!f.ctx) return;
    const meta = { ...draft!, notes: draft!.notes?.trim() ? draft!.notes : undefined, gps: f.settings.allowGps ? draft!.gps : null };
    await updatePhotoTags(f.ctx, meta);
    setSaved(true);
    if (queue.length) {
      const [n, ...rest] = queue;
      navigate(`${base}/photos/${n}/tag?next=${encodeURIComponent(rest.join(","))}${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}`);
      return;
    }
    if (next === "done") navigate(returnTo ?? `${base}/photos/${photo!.id}`);
  }

  return (
    <div className="pb-44">
      <PageHeader title="Tag photo" subtitle={queue.length ? `${queue.length} more to tag after this one` : undefined} back={{ to: returnTo ?? `${base}/photos`, label: returnTo ? "Back to walkthrough" : "Photos" }} />
      <div className="flex flex-col gap-5">
        {url ? <img src={url} alt="The photo you are tagging" className="max-h-72 w-full rounded-xl border-2 border-line object-contain" /> : null}
        <p className="text-muted">
          Taken {new Date(draft.capturedAt).toLocaleString()} · <Chip tone={uploadLabel(photo).tone}>{uploadLabel(photo).text}</Chip>
        </p>
        {saved && !queue.length && <Banner tone="ok" live>Tags saved on this device.</Banner>}
        <AreaPicker areas={f.areas} value={draft.areaId} onChange={(areaId) => set({ areaId })} />
        <SelectField label="Asset type" value={draft.assetType ?? ""} onChange={(e) => set({ assetType: (e.target.value || null) as PhotoMeta["assetType"] })}>
          <option value="">Not set</option>
          {ASSET_TYPES.map((t) => (
            <option key={t} value={t}>
              {assetTypeLabel(t)}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-col gap-2">
          <SelectField label="Asset" value={draft.assetId ?? ""} onChange={(e) => set({ assetId: e.target.value || null })}>
            <option value="">No specific asset</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.data.label} ({assetTypeLabel(a.data.assetType)})
              </option>
            ))}
          </SelectField>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="New asset name" value={newAsset} onChange={(e) => setNewAsset(e.target.value)} hint="Uses the asset type above" />
            </div>
            <Button variant="secondary" onClick={() => void addAsset()} disabled={!newAsset.trim()}>
              Add asset
            </Button>
          </div>
        </div>
        <SeverityPicker allowNone value={draft.severity as SeverityValue | null} onChange={(severity) => set({ severity })} />
        <ControlPicker controls={f.controls} value={draft.controlIds} onChange={(controlIds) => set({ controlIds })} suggested={suggestions} />
        <SelectField label="Finding" value={draft.findingId ?? ""} onChange={(e) => set({ findingId: e.target.value || null })}>
          <option value="">Not linked to a finding</option>
          {f.findings.map((x) => (
            <option key={x.id} value={x.id}>
              {x.data.title}
            </option>
          ))}
        </SelectField>
        <TextArea label="Notes" value={draft.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        {f.settings.allowGps ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              aria-pressed={!!draft.gps}
              disabled={locating}
              onClick={() => (draft.gps ? set({ gps: null }) : void includeLocation())}
              className={"min-h-12 rounded-lg border-2 px-4 text-left font-semibold " + (draft.gps ? "border-primary bg-primary text-on-primary" : "border-line bg-surface")}
            >
              {draft.gps ? "✓ Location included: tap to remove" : locating ? "Finding location…" : "Include location"}
            </button>
            <p className="text-base text-muted">Off by default. Location is read once for this photo, never tracked.</p>
            {locError && <p className="text-base font-semibold">{locError}</p>}
          </div>
        ) : (
          <p className="text-base text-muted">Location is turned off for this workspace, so none is recorded.</p>
        )}
      </div>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-line bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-2">
          <Button size="lg" block onClick={() => void save("done")}>
            {queue.length ? "Save and tag next photo" : "Save tags"}
          </Button>
          {!queue.length && (
            <CaptureButton
              ctx={f.ctx}
              variant="secondary"
              label="Save and take another"
              context={{ assessmentId: f.assessmentId, areaId: draft.areaId, controlIds: draft.controlIds, findingId: draft.findingId }}
              onCaptured={async (ids) => {
                await save("another");
                navigate(`${base}/photos/${ids[0]}/tag?next=${encodeURIComponent(ids.slice(1).join(","))}${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}`);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- detail ----------

export function PhotoDetail() {
  const f = useField();
  const { photoId = "" } = useParams();
  const base = `/assessments/${f.assessmentId}`;
  const photo = f.photos.find((p) => p.id === photoId);
  if (!photo) return <Banner tone="error">This photo is not on this device.</Banner>;
  const s = uploadLabel(photo);
  const finding = f.findings.find((x) => x.id === photo.data.findingId);
  const asset = f.assets.find((a) => a.id === photo.data.assetId);
  return (
    <>
      <PageHeader title="Photo" back={{ to: `${base}/photos`, label: "Photos" }} actions={<ButtonLink to={`${base}/photos/${photo.id}/tag`} variant="secondary">Edit tags</ButtonLink>} />
      <div className="flex flex-col gap-4">
        <Thumb photo={photo} />
        <Card>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Row k="Status">
              <Chip tone={s.tone}>{s.text}</Chip>
              {photo.lastUploadError && <span className="block text-base">{photo.lastUploadError}</span>}
            </Row>
            <Row k="Taken">{new Date(photo.data.capturedAt).toLocaleString()}</Row>
            <Row k="Area">{areaName(f.areas, photo.data.areaId)}</Row>
            <Row k="Asset">{asset ? asset.data.label : photo.data.assetType ? assetTypeLabel(photo.data.assetType) : "Not set"}</Row>
            <Row k="Severity">{photo.data.severity ? `${SEVERITY[photo.data.severity].icon} ${SEVERITY[photo.data.severity].label}` : "Not set"}</Row>
            <Row k="Finding">{finding ? <Link className="font-semibold text-primary underline" to={`${base}/findings/${finding.id}`}>{finding.data.title}</Link> : "None"}</Row>
            <Row k="Controls">{photo.data.controlIds.map((c) => f.controls.get(c)?.title ?? c).join("; ") || "None"}</Row>
            <Row k="Location">{photo.data.gps ? "Included" : "Not recorded"}</Row>
          </dl>
          {photo.data.notes && <p className="mt-2 whitespace-pre-wrap">{photo.data.notes}</p>}
        </Card>
        <SuggestionReview photo={photo} />
      </div>
    </>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-base text-muted">{k}</dt>
      <dd className="font-semibold">{children}</dd>
    </div>
  );
}
