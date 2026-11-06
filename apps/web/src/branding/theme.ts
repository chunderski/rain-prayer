/**
 * Brand color math (WCAG 2.1 relative luminance and contrast ratio) and the mapping from a
 * workspace's branding to the app's CSS variables. Anything unusable falls back to the default
 * theme: the app never renders text below 4.5:1 because of a brand color.
 */
import { BrandingResponse } from "@sentinel/shared";

const HEX = /^#([0-9a-f]{6})$/i;

export function parseHex(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: [number, number, number]) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

export function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two #RRGGBB colors (1 to 21), or null when either is invalid. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_TEXT_CONTRAST = 4.5;
export const WHITE = "#ffffff";

/** Darkens a color step by step until white text on it reaches 4.5:1 (the API's rule). */
export function accessibleAlternative(hex: string, target = MIN_TEXT_CONTRAST): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  for (let k = 1; k >= 0; k -= 0.02) {
    const c = toHex([rgb[0] * k, rgb[1] * k, rgb[2] * k]);
    if ((contrastRatio(c, WHITE) ?? 0) >= target) return c;
  }
  return "#000000";
}

/** Mix a color toward white (share 0..1 of white). */
export function tint(hex: string, share: number): string {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  return toHex(rgb.map((v) => v + (255 - v) * share) as [number, number, number]);
}

/** Surfaces of the built-in themes (index.css): brand colors must read on them. */
const SURFACE = { light: "#ffffff", dark: "#0f172a" };
const DARK_TEXT = "#05080f";

/**
 * CSS variables for a brand, or null to keep the default theme. Light theme: primary must carry
 * white text at 4.5:1 (it then also reads as link text on white). Dark theme: the brand color is
 * used only when it reads on the dark surface; otherwise the default dark primary stays.
 */
export function brandVars(primaryColor: string, dark: boolean): Record<string, string> | null {
  if (!parseHex(primaryColor)) return null;
  if (!dark) {
    if ((contrastRatio(primaryColor, WHITE) ?? 0) < MIN_TEXT_CONTRAST) return null;
    return { "--sa-primary": primaryColor, "--sa-on-primary": WHITE, "--sa-primary-soft": tint(primaryColor, 0.85) };
  }
  if ((contrastRatio(primaryColor, SURFACE.dark) ?? 0) < MIN_TEXT_CONTRAST) return null;
  if ((contrastRatio(primaryColor, DARK_TEXT) ?? 0) < MIN_TEXT_CONTRAST) return null;
  return { "--sa-primary": primaryColor, "--sa-on-primary": DARK_TEXT };
}

/** Validates what the server sent; anything malformed means "use the default brand". */
export function parseBranding(raw: unknown): BrandingResponse | null {
  const r = BrandingResponse.safeParse(raw);
  return r.success ? r.data : null;
}

/** Only https (or the API origin in development) logo URLs are rendered. */
export function safeLogoUrl(url: string | null | undefined, apiBase: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return u.href;
    if (u.origin === new URL(apiBase).origin) return u.href;
  } catch {
    /* invalid */
  }
  return null;
}
