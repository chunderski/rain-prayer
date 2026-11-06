/**
 * Phase 4 API calls (docs/api-phase4.md): branding, members and setup links, price book, quotes,
 * client portal, and portfolio. Shapes come from @sentinel/shared (channel.ts); the portal views
 * parse only what they show, so internal cost and margin never enter client-facing state.
 */
import { z } from "zod";
import {
  BrandingResponse,
  Member,
  MemberInvite,
  Portfolio,
  PortalAssessment,
  PriceBookItem,
  Quote,
  QuoteStatus,
  RiskResult,
  Severity,
  Tier,
  type Branding,
  type CreateMember,
  type QuoteAction,
  type QuoteInput,
} from "@sentinel/shared";
import type { ApiClient } from "./client";
import { cachedGet } from "./library";

const enc = encodeURIComponent;

// ---------- branding ----------
export const fetchBranding = (api: ApiClient) => cachedGet(api, "/branding", BrandingResponse);
export const putBranding = (api: ApiClient, b: Branding) => api.request("/branding", { method: "PUT", body: b, schema: BrandingResponse });
export const putLogo = (api: ApiClient, file: Blob) => api.request("/branding/logo", { method: "PUT", rawBody: file, contentType: file.type, schema: BrandingResponse });
export const deleteLogo = (api: ApiClient) => api.request("/branding/logo", { method: "DELETE" });

// ---------- members ----------
export const fetchMembers = (api: ApiClient) => api.get("/members", z.array(Member));
export const createMember = (api: ApiClient, body: CreateMember) => api.post("/members", body, MemberInvite);
export const patchMember = (api: ApiClient, userId: string, body: { role?: string; clientId?: string | null; status?: "active" | "disabled" }) =>
  api.request(`/members/${enc(userId)}`, { method: "PATCH", body, schema: Member });

// ---------- price book ----------
export const fetchPriceBook = (api: ApiClient, q = "") => api.get(`/price-book${q.trim() ? `?q=${enc(q.trim())}` : ""}`, z.array(PriceBookItem));
export const putPriceBookItem = (api: ApiClient, item: PriceBookItem) => api.request(`/price-book/${enc(item.id)}`, { method: "PUT", body: item, schema: PriceBookItem });
export const importTemplate = (api: ApiClient) => api.post("/price-book/import-template", {}, z.object({ added: z.number(), skipped: z.number() }));

// ---------- quotes ----------
export const fetchQuotes = (api: ApiClient, assessmentId: string) => api.get(`/assessments/${enc(assessmentId)}/quotes`, z.array(Quote));
export const createQuote = (api: ApiClient, assessmentId: string, body: { title?: string; tiers: Tier[] }) => api.post(`/assessments/${enc(assessmentId)}/quotes`, body, Quote);
export const fetchQuote = (api: ApiClient, id: string) => api.get(`/quotes/${enc(id)}`, Quote);
export const putQuote = (api: ApiClient, id: string, body: QuoteInput) => api.request(`/quotes/${enc(id)}`, { method: "PUT", body, schema: Quote });
export const quoteAction = (api: ApiClient, id: string, body: QuoteAction) => api.post(`/quotes/${enc(id)}/actions`, body, Quote);
export const fetchQuotePreview = (api: ApiClient, id: string) => api.request(`/quotes/${enc(id)}/preview`, { text: true }) as Promise<string>;
export const fetchQuoteCsv = (api: ApiClient, id: string) => api.request(`/quotes/${enc(id)}/csv`, { text: true }) as Promise<string>;

// ---------- portal ----------
export const PortalFinding = z.object({
  id: z.string(),
  title: z.string(),
  severity: Severity,
  description: z.string().nullish(),
  recommendation: z.string().nullish(),
  frameworks: z
    .array(
      z.object({
        frameworkId: z.string(),
        shortName: z.string().nullish(),
        frameworkShortName: z.string().nullish(),
        requirementCode: z.string(),
        requirementTitle: z.string().nullish(),
      }),
    )
    .default([]),
});
export type PortalFinding = z.infer<typeof PortalFinding>;
export const PortalDetail = z.object({ assessment: PortalAssessment, risk: RiskResult.nullable(), findings: z.array(PortalFinding) });
export type PortalDetail = z.infer<typeof PortalDetail>;

/** Client-facing quote: prices only. Cost, margin, and line internals are dropped by parsing. */
export const PortalQuote = z.object({
  id: z.string(),
  number: z.string(),
  title: z.string(),
  status: QuoteStatus,
  validUntil: z.string(),
  tiers: z.array(Tier).min(1),
  totals: z.array(z.object({ tier: Tier, price: z.number(), optionalPrice: z.number() })),
  respondedAt: z.string().nullable(),
  respondedBy: z.string().nullable(),
});
export type PortalQuote = z.infer<typeof PortalQuote>;

export const fetchPortalAssessments = (api: ApiClient) => api.get("/portal/assessments", z.array(PortalAssessment));
export const fetchPortalAssessment = (api: ApiClient, id: string) => api.get(`/portal/assessments/${enc(id)}`, PortalDetail);
export const fetchPortalReport = (api: ApiClient, id: string) => api.request(`/portal/assessments/${enc(id)}/report`, { text: true }) as Promise<string>;
export const fetchPortalQuote = (api: ApiClient, id: string) => api.get(`/portal/quotes/${enc(id)}`, PortalQuote);
export const fetchPortalQuotePreview = (api: ApiClient, id: string) => api.request(`/portal/quotes/${enc(id)}/preview`, { text: true }) as Promise<string>;
export const respondToQuote = (api: ApiClient, id: string, body: Extract<QuoteAction, { action: "accept" | "decline" }>) =>
  api.post(`/quotes/${enc(id)}/actions`, body, PortalQuote);

// ---------- portfolio ----------
export const fetchPortfolio = (api: ApiClient, clientId = "") => api.get(`/portfolio${clientId ? `?clientId=${enc(clientId)}` : ""}`, Portfolio);

// ---------- labels ----------
export const TIER_LABEL: Record<Tier, string> = { good: "Good", better: "Better", best: "Best" };
export const QUOTE_STATUS_LABEL: Record<z.infer<typeof QuoteStatus>, string> = {
  draft: "Draft",
  pending_approval: "Waiting for owner approval",
  approved: "Approved, not sent",
  sent: "Sent to client",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};
export const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", assessor: "Assessor", viewer: "Viewer", client_viewer: "Client viewer" };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (n: number) => usd.format(n);
