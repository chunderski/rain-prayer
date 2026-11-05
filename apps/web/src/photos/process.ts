/**
 * Client-side photo processing before anything is stored:
 *  - Downscale so the long edge is at most 4096 px and re-encode as JPEG. Re-encoding through a
 *    canvas also drops all EXIF, XMP, and IPTC metadata (including any GPS the camera wrote), so
 *    location only leaves the device when the assessor opts in and the tenant allows it.
 *  - Read the capture time from EXIF (exifr) before it is dropped; fall back to the file time.
 *  - Location: only when `includeLocation` is true. EXIF GPS first, otherwise one
 *    getCurrentPosition call (never continuous tracking).
 * Formats the browser cannot decode (HEIC on most non-Safari browsers) are kept as captured; the
 * API re-encodes and strips metadata server side.
 */

export const MAX_EDGE = 4096;
export const MAX_BYTES = 15 * 1024 * 1024;
const SUPPORTED = ["image/jpeg", "image/png", "image/webp", "image/heic"] as const;
type SupportedType = (typeof SUPPORTED)[number];

export interface ProcessedPhoto {
  bytes: ArrayBuffer;
  contentType: SupportedType;
  width: number | null;
  height: number | null;
  capturedAt: string;
  gps: { lat: number; lon: number; accuracyM?: number } | null;
}

export function scaledSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const k = maxEdge / long;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

function normalizeType(file: File): SupportedType | null {
  const t = file.type.toLowerCase();
  if (t === "image/jpg") return "image/jpeg";
  if ((SUPPORTED as readonly string[]).includes(t)) return t as SupportedType;
  if (t === "image/heif" || /\.hei[cf]$/i.test(file.name)) return "image/heic";
  return null;
}

async function readExif(file: File): Promise<{ taken?: Date; lat?: number; lon?: number }> {
  try {
    // Loaded on first capture so the parser stays out of the startup bundle (still precached for offline use).
    const exifr = (await import("exifr")).default;
    const out = (await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate", "latitude", "longitude"], gps: true })) as
      | { DateTimeOriginal?: Date; CreateDate?: Date; latitude?: number; longitude?: number }
      | undefined;
    const taken = out?.DateTimeOriginal ?? out?.CreateDate;
    return { taken: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : undefined, lat: out?.latitude, lon: out?.longitude };
  } catch {
    return {};
  }
}

export function currentPosition(timeoutMs = 10_000): Promise<ProcessedPhoto["gps"]> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.min(100_000, Math.round(p.coords.accuracy)) }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: timeoutMs },
    );
  });
}

async function reencode(file: File): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null; // not decodable here (for example HEIC outside Safari)
  }
  const { width, height } = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const q of [0.9, 0.8, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= MAX_BYTES) return { blob, width, height };
  }
  return null;
}

export class PhotoError extends Error {}

export async function processPhoto(file: File, opts: { includeLocation: boolean }): Promise<ProcessedPhoto> {
  const type = normalizeType(file);
  if (!type) throw new PhotoError("That file is not a supported photo. Use JPEG, PNG, WebP, or HEIC.");
  const exif = await readExif(file);
  const encoded = await reencode(file);
  let bytes: ArrayBuffer;
  let contentType: SupportedType;
  let width: number | null = null;
  let height: number | null = null;
  if (encoded) {
    bytes = await encoded.blob.arrayBuffer();
    contentType = "image/jpeg";
    width = encoded.width;
    height = encoded.height;
  } else {
    if (file.size > MAX_BYTES) throw new PhotoError("That photo is larger than 15 MB and could not be reduced on this device.");
    bytes = await file.arrayBuffer();
    contentType = type;
  }
  let gps: ProcessedPhoto["gps"] = null;
  if (opts.includeLocation) {
    gps = exif.lat !== undefined && exif.lon !== undefined ? { lat: exif.lat, lon: exif.lon } : await currentPosition();
  }
  const capturedAt = (exif.taken ?? (file.lastModified ? new Date(file.lastModified) : new Date())).toISOString();
  return { bytes, contentType, width, height, capturedAt, gps };
}
