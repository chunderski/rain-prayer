# Phase 3 API contract: scoring and reports

Extends [api-phase1.md](api-phase1.md) and [api-phase2.md](api-phase2.md); same auth, envelope, `no-store`, rate limits. Schemas: `packages/shared/src/risk.ts`. Scoring engine: `packages/risk` (pure functions; see its `src/index.ts` interface).

## Assessment lock (CW decision 2026-11-05)

- `PATCH /assessments/:id {status:"complete"}` (admin or assigned assessor) locks it: every field write (REST and sync) on a complete assessment returns 409 `assessment_locked` (sync: `rejected` with that code). On completion the API stores a risk snapshot (`risk_snapshot`) so the report and comparison use frozen numbers.
- `POST /assessments/:id/reopen` (admin) sets status back to `in_review`, audited with a reason `{reason}`.

## Risk

| Method and path | Min role | Body | Response |
|---|---|---|---|
| GET /risk/scenarios | viewer | | `ThreatScenario[]` (library, method version in header `X-Risk-Method`) |
| GET /assessments/:id/risk/inputs | viewer | | `{scenarios: ScenarioInput[]}` (defaults: every scenario relevant to the assessment's frameworks, likelihood and impact null until set) |
| PUT /assessments/:id/risk/inputs | assessor (assigned) | `PutScenarioInputs` | same as GET; locked when complete. Upserts the scenarios sent; others keep their values. With `excluded: true` the client sends likelihood 1 and impact 1; the API ignores those numbers and GET reports null for them. |
| GET /assessments/:id/risk | viewer | | `RiskResult` (live for open assessments, snapshot for complete) |
| GET /risk/compare?assessmentIds=a,b,c | viewer | up to 20 ids | `SiteComparison` |
| GET /dashboard | viewer | | `{assessmentsByStatus, findingsBySeverity, openHighFindings, topResidual: [{assessmentId, siteName, scenarioName, level, residual}], recent: [...]}` |

## Report

| Method and path | Min role | Body | Response |
|---|---|---|---|
| GET /assessments/:id/report/preview | viewer | | `text/html` sanitized preview of the report built by the template engine (same document model the Google Docs export renders). Photos via signed URLs. No script, no `<style>`, no inline style attributes: semantic, class-based HTML (`report-title`, `report-section`, `risk-table`, `level-very_low` to `level-very_high`, `finding`, `severity-<severity>`, `finding-photo`, `notice`, `muted`, `placeholder`) styled by the PWA's `public/report-preview.css`, linked from `WEB_ORIGIN`. Strict CSP header (`default-src 'none'`, `img-src` signed-URL origins, `style-src` WEB_ORIGIN). |
| GET /assessments/:id/narrative | viewer | | `Narrative[]` |
| POST /assessments/:id/narrative/draft | assessor | `{section}` | `Narrative` with status `ai_draft` (calls `draftNarrative` in `@sentinel/ai`; 503 `ai_not_configured` without a key; 422 `ai_draft_rejected` with `details.reason` when the draft fails grounding; 502 `ai_failed` on model errors). Only approved, edited, or assessor text appears in exports; unapproved AI drafts never do. |
| PUT /assessments/:id/narrative/:section | assessor | `PutNarrative` | `Narrative` (`edited`, or `approved` with `approve:true`, audited) |

Report template engine: `apps/api/src/report/` builds a typed document model (`ReportDoc`: title page with tenant branding placeholder, executive summary, scope and frameworks with versions, methodology from docs/risk-method.md, risk summary table, scenario explanations, findings register grouped by severity with inline photos and the framework requirements each finding counts toward, remediation list, appendix of unverified library content notice). Renderers: HTML (preview) and Google Docs `batchUpdate` requests. Template version recorded on every export.

## Google

| Method and path | Min role | Response |
|---|---|---|
| GET /integrations/google | admin | `{connected, email, scopes, connectedAt}` |
| GET /integrations/google/connect | admin | `{url}`: the Google consent URL (scope `https://www.googleapis.com/auth/drive.file` only, offline access, PKCE, state bound to this admin); the PWA navigates to it. Also sets an HttpOnly binding cookie the callback checks. |
| GET /integrations/google/callback | none (state bound to the admin session) | 302 to `WEB_ORIGIN/settings/integrations?google=connected|error` |
| DELETE /integrations/google | admin | 204; revokes the token at Google and deletes it |
| POST /assessments/:id/exports | assessor | `CreateExport` returns `ExportJob` 202 |
| GET /exports/:id | viewer | `ExportJob` |
| GET /assessments/:id/exports | viewer | `ExportJob[]` |

Refresh tokens are stored per tenant, encrypted with AES-256-GCM (`GOOGLE_TOKEN_KEY`, 32 bytes base64), never returned to clients. Exports create, inside a per-tenant folder "Sentinel Assess/<client>/<site>/<assessment>": a Google Doc (narrative report, photos inline), a Google Sheet (tabs: Findings register, Risk scores, Remediation), and a "Photos" subfolder with the stored JPEGs named `<area>-<asset type>-<n>.jpg`. Jobs run in-process with a small queue (one per tenant at a time), are retried once on 5xx and 429, and are idempotent per job. All Google calls go through `src/google/client.ts` with an injectable transport so tests use a fake; without real credentials the endpoints return 503 `google_not_configured`.
