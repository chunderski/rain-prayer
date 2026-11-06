# Phase 4 API contract: channel

Extends phases 1 to 3 (same auth, envelope, `no-store`, rate limits). Schemas: `packages/shared/src/channel.ts`. Quote math: `quoteTotals` and `unitPrice` in the same file; the API stores what they return.

## Tour fixes carried into Phase 4

- Report and Docs "Counts toward" use framework short names and requirement titles ("CARVER: Accessibility (SA-CARVER-A)"), not framework ids.

## Branding

| Method and path | Min role | Body | Response |
|---|---|---|---|
| GET /branding | client_viewer | | `BrandingResponse` |
| PUT /branding | admin | `Branding` | `BrandingResponse`; 422 `contrast_too_low` when white text on primaryColor is under 4.5:1; 403 `plan_required` when showPoweredBy is false on the standard plan |
| PUT /branding/logo | admin | raw PNG or JPEG, max 2 MB | `BrandingResponse`; decoded, re-encoded to PNG, metadata stripped, fit within 512x512; SVG and everything else 415 |
| DELETE /branding/logo | admin | | 204 |

`tenant.plan` (`standard` default, `partner`) is set by the platform operator only (seed and SQL), never through the API. Branding applies to: the PWA header and theme (primary color via CSS variable), the report preview and Google Docs export (logo, display name, colors, footer, contact line, "Powered by Sentinel Assess" unless turned off), quote previews, and the client portal.

## Members and client logins

| Method and path | Min role | Body | Response |
|---|---|---|---|
| GET /members | admin | | `Member[]` (replaces the Phase 2 shape; adds clientId, status) |
| POST /members | admin | `CreateMember` | `MemberInvite`, 201. Owners only may create owners or admins. Existing user email: added to this tenant without a new password. |
| PATCH /members/:userId | admin | `{role?, clientId?, status?: "active"|"disabled"}` | `Member`; the last active owner cannot be demoted or disabled |
| POST /auth/setup | none, rate limited | `CompleteSetup` | `{accessToken, session}` and refresh cookie; token single use, 72 h, stored hashed |

`client_viewer` users see only the client portal routes below and `GET /branding`, `/auth/*`. Every other route refuses them (they rank below viewer). Their membership row carries `client_id`; portal queries filter by it in addition to tenant RLS, and a test iterates every registered route to prove a client viewer gets 403 or 404 outside the portal.

## Client portal

| Method and path | Role | Response |
|---|---|---|
| GET /portal/assessments | client_viewer (their client) or viewer+ with `?clientId=` | `PortalAssessment[]`: complete assessments only |
| GET /portal/assessments/:id | same | `{assessment: PortalAssessment, risk: RiskResult (snapshot), findings: confirmed findings with framework mappings}` |
| GET /portal/assessments/:id/report | same | report preview HTML (branded, approved narrative only) |
| GET /portal/quotes/:id | same | `Quote` (sent, accepted, or declined only), plus branded preview at `/portal/quotes/:id/preview` |
| POST /quotes/:id/actions accept / decline | client_viewer (their client) or admin | records name, time, tier; audited |

## Price book

| Method and path | Min role | Body | Response |
|---|---|---|---|
| GET /price-book | assessor | `?q=&category=&active=` | `PriceBookItem[]` |
| PUT /price-book/:id | admin | `UpsertPriceBookItem` | `PriceBookItem` (sku unique per tenant: 409 `sku_exists`) |
| DELETE /price-book/:id | admin | | 204 (soft: active false when used by any quote) |
| POST /price-book/import-template | admin | `{}` | `{added, skipped}`: copies `apps/api/data/price-book-template.json` into the tenant, skipping existing skus |
| GET /tenant/quote-settings, PUT (admin) | admin | `{defaultLaborRate, minMarginPct, defaultTerms, validDays}` | same |

## Quotes (proposals only: no signatures, tax, or payments in Phase 4)

| Method and path | Min role | Body | Response |
|---|---|---|---|
| GET /assessments/:id/quotes | viewer | | `Quote[]` |
| POST /assessments/:id/quotes | assessor | `GenerateQuote` | `Quote` 201: a draft whose lines are suggested from the assessment's **confirmed** findings: candidates share a control with the finding; items made for other asset types are dropped when the finding's asset types are known (its asset or tagged photos); then ONE best item per presented tier (asset match, then shared controls, then sku); untiered items only when no tiered item fits; a finding with no match gets one `needsPricing` line. Quote number `Q-<year>-<NNNN>` per tenant. Allowed on complete assessments (the field lock does not apply to quotes). |
| GET /quotes/:id | viewer | | `Quote` |
| PUT /quotes/:id | assessor | `QuoteInput` | `Quote`; only in draft (409 `quote_locked` otherwise); totals recomputed with `quoteTotals` |
| POST /quotes/:id/actions | per action | `QuoteAction` | `Quote`. submit: draft to approved, or to pending_approval when any tier marginPct is under the tenant minimum or any line needsPricing (needsPricing lines block submit entirely: 422 `lines_need_pricing`). approve: owner only. send: admin, approved only. revise: creates a new draft `Q-...-R2`. accept/decline: sent only. All audited. |
| GET /quotes/:id/preview | viewer | | branded HTML proposal (escaped, class-based, strict CSP like the report preview) |
| GET /quotes/:id/csv | viewer | | CSV of lines and tier totals; cells starting with `= + - @` tab or CR are prefixed with `'` |

## Portfolio

`GET /portfolio?clientId=` (viewer): `Portfolio` built from risk snapshots of complete assessments plus open findings and quote values; caveats when method or library versions differ across the history.

## Head of Engineering additions (2026-11-06)

- Expiry: a sent quote whose `validUntil` date has passed reads as status `expired` (computed on read, persisted the next time an action touches it). accept or decline on it returns 409 `quote_expired`; revise still works and the new draft gets a fresh validity when the old date has passed.
- Price book responses carry `fromTemplate: boolean` (response only, not part of `UpsertPriceBookItem`): true for items copied from the template until an admin changes materialCost, laborHours, or defaultMarginPct, so the PWA can show a "Placeholder price" badge.
- Quote responses also carry `acceptedTier` and `declineReason` (response only).
- Setup link: `MemberInvite.setupUrl` is `<WEB_ORIGIN>/setup#token=<token>`. For an email that already has an account, POST /auth/setup expects that account's current password (401 `invalid_credentials` otherwise) and never sets a new one; 409 `existing_account` when that account has no password (Google only). Re-inviting a still-invited member issues a new link and voids the old one.
- Errors added: 409 `member_exists`, 409 `last_owner`, 409 `invite_pending` (PATCH status active on an invited member), 403 `member_disabled` on login, 400 `invalid_setup_token`, 400 `unknown_client`, 503 `template_unavailable`, 400 `unknown_finding` and `unknown_price_book_item` on PUT /quotes/:id.
- Brand colors in preview HTML: CSS custom properties `--brand-primary`, `--brand-accent`, `--brand-on-primary` in a hashed `<style>` block; new classes `report-logo`, `report-footer-text`, `report-contact`, `report-powered-by`, and quote classes listed in `apps/api/src/quotes/render.ts`.
