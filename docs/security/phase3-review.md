# Phase 3 security review (scoring and reports)

Reviewer: qa-security-reviewer. Date: 2026-11-05. Verdict: **PASS** (no blocking issues), with the recommendations below.

## Scope

Migration `005_risk_report.sql`; `apps/api/src/{risk,report,google}/`; routes `risk`, `report`, `integrations`, `field`; `packages/risk`; `packages/ai/src/narrative.ts` and prompts; web PIN, Report, Settings, and Lock screens.

## Checks and results

| Area | Result | Evidence |
|---|---|---|
| RLS on the 7 new tables | Enabled and forced; `risk_snapshot` SELECT and INSERT only for the app role | `isolation-phase3.test.ts` |
| Cross-tenant risk, narrative, preview, exports, compare | 404, no data in body; mixed own and foreign ids in compare also 404 | `isolation-phase3.test.ts` (QA P3 test added) |
| Stored XSS in preview | All strings escaped, class tokens whitelisted, no script or style; CSP `default-src 'none'`; PWA `<iframe sandbox="" srcdoc>` | `report/html.ts`, `phase3.test.ts` |
| Docs and Sheets injection | Text inserted literally; Sheets RAW | `google-export.test.ts` |
| OAuth connect | JWE state with PKCE verifier and cookie binding hash; single-use DB row bound to the admin; admin role rechecked; fixed redirect URI | `routes/integrations.ts`, `google-export.test.ts` |
| Token encryption | AES-256-GCM, random 12 byte IV per seal, tenant AAD, 32 byte key checked; state key derived separately with HMAC | `google/tokens.ts` |
| Token exposure | Never in responses; refresh token only sent to the Google token endpoint | `google-export.test.ts` |
| Scope and revoke | `drive.file` only; revoke on disconnect, local delete even if revoke fails | `google/client.ts`, `google-export.test.ts` |
| Temporary Drive links | Removed in `finally`, also when the Docs batch fails | `google-export.test.ts` (QA P3 test added) |
| Lock | One gate for every write path; reopen admin only, reason required, audited | D-068, `field.ts` |
| Narrative | `ai_draft` never in preview or export; 409 `narrative_exists`; escaped delimited facts; grounding checks | `report/model.ts`, `google-export.test.ts` (QA P3 test added) |
| PIN | PBKDF2-SHA256, 310000 iterations, 16 byte salt, 256 bit verifier in IndexedDB; counter written before derive; wipe at 5 | `apps/web/src/auth/pin.ts` |
| Secrets | Tree grep for Anthropic, Google, AWS keys, private keys: none; `.env.example` placeholders only (git history not checked: no git in this session) | |

## Recommendations (non-blocking)

- R3-1: `PUT /narrative/:section` without `approve` marks an unchanged AI draft as `edited`, which D-060 lets into exports. Keep `ai_draft` when the text is unchanged, or export only `approved`.
- R3-2: `requireAssessmentWrite` reads status without a row lock; a write can commit after a concurrent completion snapshot. Use `FOR SHARE` on writes and `FOR UPDATE` when completing.
- R3-3: The PIN is a gate, not encryption; IndexedDB is readable with device access, and an online start with a valid refresh cookie skips the PIN. Consider wrapping cached data with a PIN-derived key.
- R3-4: Drive temporary links are granted for every image before the first batch, so the exposure lasts for the whole Doc build. Grant per batch, and record outstanding permission ids in `export_job.state` so a rerun removes any whose deletion failed.
- R3-5: `GOOGLE_TOKEN_KEY` has no key id; add a version byte to support rotation.
- R3-6: Helmet still sends `X-Frame-Options: SAMEORIGIN` on the preview next to the `frame-ancestors` allowlist; drop it on that route for consistent embed behavior.
- R3-7: Carry-over R-4: `Cache-Control: no-store` on authenticated responses, including the preview.
