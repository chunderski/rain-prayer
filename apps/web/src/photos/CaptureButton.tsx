/**
 * "Take photo": a native file input with capture="environment". It opens the rear camera on iOS
 * and Android without getUserMedia, and falls back to a file chooser on desktop. Each photo is
 * processed (downscaled, metadata dropped, capture time kept) and stored locally before anything
 * else happens, so capture never waits for the network.
 */
import { useEffect, useId, useState } from "react";
import type { PhotoMeta } from "@sentinel/shared";
import { savePhotoCapture, type WriteCtx } from "../field/repo";
import { uuid } from "../offline/db";
import { Banner, buttonClass } from "../components/ui";
import { PhotoError, processPhoto } from "./process";

export interface CaptureContext {
  assessmentId: string;
  areaId: string | null;
  controlIds: string[];
  findingId: string | null;
  severity?: PhotoMeta["severity"];
  assetType?: PhotoMeta["assetType"];
}

const LOW_STORAGE_BYTES = 100 * 1024 * 1024;

/** Warn before capture fails: free quota below 100 MB. */
export function useLowStorage(): boolean {
  const [low, setLow] = useState(false);
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then((e) => setLow(e.quota !== undefined && e.usage !== undefined && e.quota - e.usage < LOW_STORAGE_BYTES))
      .catch(() => undefined);
  }, []);
  return low;
}

export async function capturePhotos(ctx: WriteCtx, files: File[], c: CaptureContext): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    const p = await processPhoto(file, { includeLocation: false });
    const id = uuid();
    await savePhotoCapture(
      ctx,
      {
        id,
        assessmentId: c.assessmentId,
        areaId: c.areaId,
        assetId: null,
        findingId: c.findingId,
        controlIds: c.controlIds,
        assetType: c.assetType ?? null,
        severity: c.severity ?? null,
        capturedAt: p.capturedAt,
        gps: null,
        contentType: p.contentType,
        byteSize: p.bytes.byteLength,
      },
      p.bytes,
      p.width && p.height ? { width: p.width, height: p.height } : undefined,
    );
    ids.push(id);
  }
  return ids;
}

export function CaptureButton({
  ctx,
  context,
  onCaptured,
  label = "Take photo",
  pendingUploads = 0,
  variant = "primary",
  className,
}: {
  ctx: WriteCtx | null;
  context: CaptureContext;
  onCaptured: (ids: string[]) => void;
  label?: string;
  pendingUploads?: number;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const low = useLowStorage();

  async function onFiles(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      onCaptured(await capturePhotos(ctx, files, context));
    } catch (err) {
      setError(err instanceof PhotoError ? err.message : "The photo could not be saved on this device. Free up storage and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={"flex flex-col gap-2 " + (className ?? "")}>
      {low && (
        <Banner tone="warn" title="Storage is almost full">
          This device is low on space{pendingUploads ? ` and ${pendingUploads} ${pendingUploads === 1 ? "photo is" : "photos are"} waiting to upload` : ""}. Connect to upload, or free up space before taking more photos.
        </Banner>
      )}
      <label htmlFor={id} className={buttonClass(variant, "lg", true) + " cursor-pointer focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-focus" + (busy || !ctx ? " opacity-60" : "")}>
        {busy ? "Saving photo…" : label}
        <input
          id={id}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          disabled={busy || !ctx}
          className="sr-only"
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {error && <Banner tone="error">{error}</Banner>}
    </div>
  );
}
