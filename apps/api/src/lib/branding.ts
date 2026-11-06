/**
 * Phase 4 branding: stored settings with defaults, WCAG contrast check, effective "Powered by" rule,
 * and the logo pipeline (content sniffing, decode, PNG re-encode without metadata, 512 px box).
 */
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import type { Branding, BrandingResponse, Plan } from "@sentinel/shared";
import type { Config } from "../config.js";
import type { Tx } from "../db/pool.js";
import type { ObjectStorage } from "../storage/index.js";
import { AppError } from "./errors.js";

/** Matches the PWA default theme (--sa-primary, white text 10.2:1). */
export const DEFAULT_PRIMARY = "#0b3d91";
export const DEFAULT_ACCENT = "#0f766e";
export const MIN_CONTRAST = 4.5;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_EDGE = 512;
const MAX_LOGO_INPUT_PIXELS = 40_000_000;

/** WCAG 2.x relative luminance of a #RRGGBB color. */
export function relativeLuminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Contrast ratio of white text on the given background. */
export const contrastWithWhite = (hex: string) => 1.05 / (relativeLuminance(hex) + 0.05);

export interface StoredBranding extends Branding {
  plan: Plan;
  logoKey: string | null;
  /** Effective rule: only the partner plan may hide "Powered by Sentinel Assess". */
  poweredBy: boolean;
}

/** Branding of the current tenant (inside its transaction), with defaults when nothing is saved yet. */
export async function loadBranding(tx: Tx): Promise<StoredBranding> {
  const { rows } = await tx.query(
    `SELECT t.name AS "tenantName", t.plan, b.display_name AS "displayName", b.primary_color AS "primaryColor",
            b.accent_color AS "accentColor", b.report_footer AS "reportFooter", b.contact_email AS "contactEmail",
            b.contact_phone AS "contactPhone", b.website, b.show_powered_by AS "showPoweredBy", b.logo_key AS "logoKey"
       FROM tenant t LEFT JOIN tenant_branding b ON b.tenant_id = t.id
      WHERE t.id = app_current_tenant()`,
  );
  const r = rows[0];
  if (!r) throw new AppError(404, "not_found", "Workspace not found");
  const plan: Plan = r.plan === "partner" ? "partner" : "standard";
  const showPoweredBy = r.showPoweredBy ?? true;
  return {
    displayName: r.displayName ?? r.tenantName,
    primaryColor: r.primaryColor ?? DEFAULT_PRIMARY,
    accentColor: r.accentColor ?? DEFAULT_ACCENT,
    reportFooter: r.reportFooter ?? "",
    contactEmail: r.contactEmail ?? null,
    contactPhone: r.contactPhone ?? null,
    website: r.website ?? null,
    showPoweredBy,
    plan,
    logoKey: r.logoKey ?? null,
    poweredBy: showPoweredBy || plan !== "partner",
  };
}

export async function brandingResponse(cfg: Config, storage: ObjectStorage, b: StoredBranding): Promise<BrandingResponse> {
  const { logoKey, poweredBy, ...rest } = b;
  return { ...rest, showPoweredBy: poweredBy, logoUrl: logoKey ? (await storage.signedUrl(logoKey, cfg.SIGNED_URL_TTL_SECONDS)).url : null };
}

/** Contact line for reports, quotes, and the portal ("email; phone; website"). */
export const contactLine = (b: Pick<Branding, "contactEmail" | "contactPhone" | "website">) =>
  [b.contactEmail, b.contactPhone, b.website].filter((x): x is string => !!x).join("; ");

const unsupported = () => new AppError(415, "unsupported_media", "Logos must be PNG or JPEG (checked by content); SVG and other formats are refused");

/**
 * Decodes a PNG or JPEG logo and re-encodes it as PNG within 512x512. Only decoded pixels are written,
 * so EXIF, XMP, ICC, text chunks, and anything appended to the file are dropped.
 */
export async function processLogo(input: Buffer): Promise<{ png: Buffer; width: number; height: number; detectedType: string }> {
  if (input.length === 0) throw unsupported();
  if (input.length > MAX_LOGO_BYTES) throw new AppError(413, "payload_too_large", "Logos are limited to 2 MB");
  const ft = await fileTypeFromBuffer(input);
  if (!ft || (ft.mime !== "image/png" && ft.mime !== "image/jpeg")) throw unsupported();
  try {
    const r = await sharp(input, { limitInputPixels: MAX_LOGO_INPUT_PIXELS, failOn: "error", pages: 1 })
      .rotate()
      .resize({ width: LOGO_EDGE, height: LOGO_EDGE, fit: "inside", withoutEnlargement: true })
      .toColourspace("srgb")
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { png: r.data, width: r.info.width, height: r.info.height, detectedType: ft.mime };
  } catch {
    throw new AppError(415, "unsupported_media", "The file is not a decodable PNG or JPEG image");
  }
}
