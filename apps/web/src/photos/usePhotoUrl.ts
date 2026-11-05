import { useEffect, useState } from "react";
import type { PhotoMeta } from "@sentinel/shared";
import { useApi } from "../auth/AuthContext";
import { getPhotoBytes } from "../field/repo";
import { SignedUrl } from "../field/schemas";
import type { LocalPhoto } from "../offline/db";

/**
 * Image source for a photo: the bytes on this device as a blob: URL, otherwise a short-lived signed
 * URL from the API (GET /photos/:id/url). Blob URLs are revoked on unmount.
 */
export function usePhotoUrl(photo: LocalPhoto<PhotoMeta> | undefined, variant: "thumb" | "full" = "thumb"): string | null {
  const api = useApi();
  const [url, setUrl] = useState<string | null>(null);
  const id = photo?.id;
  const stored = photo?.serverStatus === "stored";
  useEffect(() => {
    if (!id) return;
    let live = true;
    let objectUrl: string | null = null;
    (async () => {
      const blob = await getPhotoBytes(id).catch(() => undefined);
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        if (live) setUrl(objectUrl);
        return;
      }
      if (!stored) return;
      const signed = await api.get(`/photos/${encodeURIComponent(id)}/url?variant=${variant}`, SignedUrl).catch(() => null);
      if (live && signed) setUrl(signed.url);
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, id, stored, variant]);
  return url;
}
