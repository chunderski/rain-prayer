/**
 * Photo pipeline: content sniffing, decode, re-encode. The original bytes are never stored.
 *  1. Magic bytes (file-type) must say JPEG, PNG, WebP, or HEIC/HEIF; the Content-Type header alone is not trusted.
 *  2. sharp decodes the image with a pixel limit (decompression bombs) and failOn "error" (truncated or corrupt data).
 *  3. Orientation is applied, then the image is re-encoded as JPEG q85, sRGB, long edge at most 4096 px.
 *     sharp writes no EXIF, XMP, IPTC, or ICC unless asked to, so all metadata is dropped; anything
 *     appended after the image data (polyglots) is dropped too, because only decoded pixels are written.
 *  4. A 512 px thumbnail is derived from the re-encoded image.
 */
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp, { type OutputInfo } from "sharp";
import { AppError } from "../lib/errors.js";

export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const MAX_LONG_EDGE = 4096;
export const THUMB_EDGE = 512;
/** 100 megapixels: above any phone camera, far below what would exhaust memory. */
export const MAX_INPUT_PIXELS = 100_000_000;

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Whether this sharp/libvips build can decode HEVC-coded HEIC (prebuilt binaries ship AV1 only). */
export const HEIC_DECODE_SUPPORTED = (() => {
  const heif = (sharp.format as unknown as Record<string, { input?: { buffer?: boolean; fileSuffix?: string[] } }>).heif;
  return !!heif?.input?.buffer && (heif.input.fileSuffix ?? []).includes(".heic");
})();

sharp.cache(false);

export interface ProcessedPhoto {
  full: Buffer;
  thumb: Buffer;
  sha256: string;
  width: number;
  height: number;
  detectedType: string;
}

const unsupported = (message: string) => new AppError(415, "unsupported_media", message);

export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  if (input.length === 0) throw unsupported("Empty upload");
  if (input.length > MAX_PHOTO_BYTES) throw new AppError(413, "payload_too_large", "Photos are limited to 15 MB");
  const ft = await fileTypeFromBuffer(input);
  if (!ft || !ALLOWED.has(ft.mime)) {
    throw unsupported("Only JPEG, PNG, WebP, or HEIC photos are accepted (checked by content, not by name or header)");
  }
  const isHeic = ft.mime === "image/heic" || ft.mime === "image/heif";
  if (isHeic && !HEIC_DECODE_SUPPORTED) {
    throw unsupported("HEIC photos cannot be decoded by this server; set the camera to Most Compatible (JPEG) or let the app convert the photo before upload");
  }
  let full: Buffer;
  let info: OutputInfo;
  try {
    const r = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", pages: 1 })
      .rotate()
      .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({ quality: 85, chromaSubsampling: "4:2:0" })
      .toBuffer({ resolveWithObject: true });
    full = r.data;
    info = r.info;
  } catch {
    throw unsupported(isHeic ? "HEIC photo could not be decoded; upload JPEG instead" : "The file is not a decodable image");
  }
  const thumb = await sharp(full).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return {
    full,
    thumb,
    sha256: createHash("sha256").update(full).digest("hex"),
    width: info.width,
    height: info.height,
    detectedType: ft.mime,
  };
}
