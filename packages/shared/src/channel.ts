/**
 * Phase 4 contracts: integrator branding, members and client logins, price book,
 * findings-to-quote, client portal, and portfolio. Quote math lives here so the API
 * and the PWA always compute identical totals.
 */
import { z } from "zod";
import { AssetType, SharedControlId } from "./frameworks.js";
import { RiskLevel } from "./risk.js";

const Id = z.uuid();
const IsoTime = z.iso.datetime({ offset: true });
const Money = z.number().min(0).max(10_000_000); // USD, two decimals in display
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #RRGGBB");

// ---------- branding ----------

export const Plan = z.enum(["standard", "partner"]);
export type Plan = z.infer<typeof Plan>;

export const Branding = z.object({
  displayName: z.string().trim().min(1).max(80),
  /** Primary brand color; must reach 4.5:1 contrast with white text (checked server side). */
  primaryColor: Hex,
  accentColor: Hex,
  reportFooter: z.string().max(500).default(""),
  contactEmail: z.email().max(254).nullable().default(null),
  contactPhone: z.string().max(40).nullable().default(null),
  website: z.url().max(200).nullable().default(null),
  /** "Powered by Sentinel Assess" on reports and portal. Only the partner plan may turn it off. */
  showPoweredBy: z.boolean().default(true),
});
export type Branding = z.infer<typeof Branding>;

export const BrandingResponse = Branding.extend({
  plan: Plan,
  /** Signed, short-lived URL of the stored logo (PNG, metadata stripped), or null. */
  logoUrl: z.string().url().nullable(),
});
export type BrandingResponse = z.infer<typeof BrandingResponse>;

// ---------- members and client logins ----------

/** client_viewer: read-only login for one client of the workspace (CW decision, D-new). */
export const MemberRole = z.enum(["owner", "admin", "assessor", "viewer", "client_viewer"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const CreateMember = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(120),
    role: MemberRole,
    /** Required for client_viewer, forbidden otherwise. */
    clientId: Id.nullable().default(null),
  })
  .refine((m) => (m.role === "client_viewer") === (m.clientId !== null), { message: "clientId is required for client_viewer and only for it", path: ["clientId"] });
export type CreateMember = z.infer<typeof CreateMember>;

export const Member = z.object({
  userId: Id,
  email: z.string(),
  name: z.string(),
  role: MemberRole,
  clientId: Id.nullable(),
  clientName: z.string().nullable(),
  status: z.enum(["invited", "active", "disabled"]),
});
export type Member = z.infer<typeof Member>;

/** Returned once when a member is created: a single-use setup link the admin shares out of band. */
export const MemberInvite = z.object({ member: Member, setupUrl: z.string().url(), expiresAt: IsoTime });
export const CompleteSetup = z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(256) });

// ---------- price book ----------

export const PriceCategory = z.enum(["hardware", "software", "labor", "service", "subscription"]);
export const PriceUnit = z.enum(["each", "ft", "hour", "lot", "month", "year"]);
export const Tier = z.enum(["good", "better", "best"]);
export type Tier = z.infer<typeof Tier>;

export const PriceBookItem = z.object({
  id: Id,
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(120),
  description: z.string().max(1000).default(""),
  category: PriceCategory,
  unit: PriceUnit,
  /** Cost to the integrator per unit (materials or third-party). */
  materialCost: Money,
  /** Labor hours per unit, priced at the quote's labor rate. */
  laborHours: z.number().min(0).max(1000),
  defaultMarginPct: z.number().min(0).max(95),
  /** Shared controls this item remediates; used to suggest lines from findings. */
  controlIds: z.array(SharedControlId).max(30).default([]),
  assetTypes: z.array(AssetType).max(10).default([]),
  /** Which option tier this item belongs to when suggesting (any = all tiers). */
  tier: z.enum(["good", "better", "best", "any"]).default("any"),
  active: z.boolean().default(true),
});
export type PriceBookItem = z.infer<typeof PriceBookItem>;
export const UpsertPriceBookItem = PriceBookItem.omit({ id: true }).extend({ id: Id.optional() });

// ---------- quotes ----------

export const QuoteStatus = z.enum(["draft", "pending_approval", "approved", "sent", "accepted", "declined", "expired"]);
export type QuoteStatus = z.infer<typeof QuoteStatus>;

export const QuoteLine = z.object({
  id: Id,
  findingId: Id.nullable().default(null),
  priceBookItemId: Id.nullable().default(null),
  description: z.string().trim().min(1).max(500),
  category: PriceCategory,
  unit: PriceUnit,
  quantity: z.number().min(0).max(100_000),
  materialCost: Money, // per unit
  laborHours: z.number().min(0).max(1000), // per unit
  marginPct: z.number().min(0).max(95),
  /** "all" lines appear in every tier. */
  tier: z.enum(["good", "better", "best", "all"]),
  optional: z.boolean().default(false),
  /** Set when generated from a finding with no matching price book item. */
  needsPricing: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const QuoteInput = z.object({
  title: z.string().trim().min(1).max(200),
  laborRate: Money, // per hour
  validUntil: z.iso.date(),
  /** Which tiers this quote presents; one tier means a single-option quote. */
  tiers: z.array(Tier).min(1).max(3),
  notes: z.string().max(4000).default(""),
  terms: z.string().max(4000).default(""),
  lines: z.array(QuoteLine).max(500),
});
export type QuoteInput = z.infer<typeof QuoteInput>;

export const TierTotals = z.object({
  tier: Tier,
  materials: z.number(),
  labor: z.number(),
  cost: z.number(),
  price: z.number(),
  margin: z.number(),
  marginPct: z.number(),
  /** Optional lines, priced separately and not included in price. */
  optionalPrice: z.number(),
});
export type TierTotals = z.infer<typeof TierTotals>;

export const Quote = QuoteInput.extend({
  id: Id,
  assessmentId: Id,
  number: z.string(), // e.g. Q-2026-0001, per tenant
  status: QuoteStatus,
  currency: z.literal("USD"),
  totals: z.array(TierTotals),
  /** Tenant minimum margin at the time of the last save. */
  minMarginPct: z.number(),
  belowMinMargin: z.boolean(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  approvedBy: Id.nullable(),
  sentAt: IsoTime.nullable(),
  respondedAt: IsoTime.nullable(),
  respondedBy: z.string().nullable(),
});
export type Quote = z.infer<typeof Quote>;

export const GenerateQuote = z.object({ title: z.string().trim().min(1).max(200).optional(), tiers: z.array(Tier).min(1).max(3).default(["good", "better", "best"]) });
export const QuoteAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }), // draft -> approved, or pending_approval when below min margin
  z.object({ action: z.literal("approve") }), // owner only: pending_approval -> approved
  z.object({ action: z.literal("send") }), // approved -> sent (visible in the client portal)
  z.object({ action: z.literal("revise") }), // any non-draft -> new draft copy with a new number suffix
  z.object({ action: z.literal("accept"), tier: Tier, name: z.string().trim().min(1).max(120) }), // client_viewer or admin
  z.object({ action: z.literal("decline"), reason: z.string().max(1000).optional(), name: z.string().trim().min(1).max(120) }),
]);
export type QuoteAction = z.infer<typeof QuoteAction>;

/** Unit sell price for a line: (material + labor) / (1 - margin). */
export function unitPrice(line: Pick<QuoteLine, "materialCost" | "laborHours" | "marginPct">, laborRate: number): number {
  const cost = line.materialCost + line.laborHours * laborRate;
  return round2(cost / (1 - line.marginPct / 100));
}

/** Totals per tier. Lines with tier "all" count in every tier; optional lines are priced separately. */
export function quoteTotals(input: Pick<QuoteInput, "laborRate" | "tiers" | "lines">): TierTotals[] {
  return input.tiers.map((tier) => {
    let materials = 0, labor = 0, price = 0, optionalPrice = 0;
    for (const l of input.lines) {
      if (l.tier !== "all" && l.tier !== tier) continue;
      const p = unitPrice(l, input.laborRate) * l.quantity;
      if (l.optional) {
        optionalPrice += p;
        continue;
      }
      materials += l.materialCost * l.quantity;
      labor += l.laborHours * input.laborRate * l.quantity;
      price += p;
    }
    const cost = materials + labor;
    const margin = price - cost;
    return {
      tier,
      materials: round2(materials),
      labor: round2(labor),
      cost: round2(cost),
      price: round2(price),
      margin: round2(margin),
      marginPct: price > 0 ? round2((margin / price) * 100) : 0,
      optionalPrice: round2(optionalPrice),
    };
  });
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------- client portal and portfolio ----------

export const PortalAssessment = z.object({
  id: Id,
  title: z.string(),
  siteName: z.string(),
  completedAt: IsoTime.nullable(),
  overall: z.object({ level: RiskLevel, residual: z.number() }).nullable(),
  openFindings: z.record(z.string(), z.number().int()),
  quotes: z.array(z.object({ id: Id, number: z.string(), title: z.string(), status: QuoteStatus })),
});
export type PortalAssessment = z.infer<typeof PortalAssessment>;

export const Portfolio = z.object({
  methodVersion: z.string(),
  clients: z.array(
    z.object({
      clientId: Id,
      clientName: z.string(),
      sites: z.array(
        z.object({
          siteId: Id,
          siteName: z.string(),
          /** Completed assessments, oldest first, so the trend reads left to right. */
          history: z.array(z.object({ assessmentId: Id, completedAt: IsoTime, level: RiskLevel, residual: z.number(), inherent: z.number() })),
          openFindings: z.record(z.string(), z.number().int()),
          quotes: z.object({ sent: z.number(), accepted: z.number(), acceptedValue: z.number(), openValue: z.number() }),
        }),
      ),
    }),
  ),
  caveats: z.array(z.string()),
});
export type Portfolio = z.infer<typeof Portfolio>;
