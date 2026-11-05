# Phase 2 security review: field capture

Reviewer: qa-security-reviewer. Date: 2026-11-05. Scope: migration 004, `apps/api/src/{field,photos,storage}`, `apps/api/src/routes/{field,photos,ai,sync}.ts`, `packages/ai`, `apps/web/src/{sync,field,offline,auth}`, and the built web app.

## Verdict: PASS

No blocking issues remain. Two authorization and integrity bugs and one data-at-rest gap were found and fixed in this review, each with a proving test (below). The open items are recommendations, none of them blocking for Phase 2.

## Checks run

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` (all workspaces) | pass: shared 26, frameworks 21, api 127 (121 plus 6 new QA tests), web 53 |
| `npm run validate:frameworks` | pass (all requirements still `needs_review`, as expected before SME review) |
| `npm run build -w @sentinel/web` | pass; built `index.html` has a strict CSP meta tag (`script-src 'self'`, `object-src 'none'`, no `unsafe-inline`) and one external module script |
| `npx playwright test` (apps/web) | 57 passed, including mobile viewports and the CSP violation check |
| Secrets scan (tree and history) | only `sk-ant-replace-me` placeholders |

## Fixed in this review

| # | Severity | Issue | Fix | Proof |
|---|---|---|---|---|
| F-1 | Medium | An assessor could delete an area through `POST /sync/push` although `DELETE /areas/:id` is admin only | Admin check for area deletes in the records engine delete path, `apps/api/src/field/records.ts` | `apps/api/test/qa-phase2.test.ts` "an assessor cannot delete an area through sync" |
| F-2 | Medium | A `clientUpdatedAt` far in the future (bad device clock or a malicious assessor) set field clocks that made every later edit lose its conflict | `clientUpdatedAt` is clamped to server time before it is used as a field clock, `apps/api/src/field/records.ts`; the raw value is still kept in `sync_conflict` | `qa-phase2.test.ts` "a far-future clientUpdatedAt cannot pin fields" |
| F-3 | Low | Sign out kept the `library` IndexedDB store, which also caches `/assessments` list and detail (client and site names) | `clearClientData` now removes every library entry except framework and control reference data, `apps/web/src/offline/db.ts` | `apps/web/src/offline/db.test.ts` |

## Verified, no action needed

- Uploads: polyglots, SVG, HTML, PDF, fake HEIC, wrong content type, oversize (413), zero byte, truncated JPEG, and a 144 MP PNG decompression bomb are rejected; stored objects are re-encoded with no EXIF, XMP, or GPS; appended payloads are not stored.
- Signed URLs: expiry, key binding, forgery, and JWT-key tokens are rejected; object keys are regex checked and path contained, so traversal is not possible.
- Tenant isolation: forced RLS on all 13 Phase 2 tables; foreign area, asset, and finding ids inside sync payloads are `invalid_reference`; foreign record ids are `forbidden` or `id_conflict`; opId replay is per tenant and per user; pull cursors are filtered by RLS.
- Sync: idempotent by opId; per-op savepoints; batches capped at 200 ops and 2 MB; a suggestion cannot be reviewed twice (409 `not_reviewable`); client-supplied finding `source` and `suggestionId` are ignored.
- AI: notes and area name are escaped and only sent when `aiShareContext` is true (default false); GPS is never sent; unknown control ids are dropped twice; nothing becomes a finding without review; 30 analyses per user per hour.
- Frontend: no tokens in IndexedDB or localStorage; model text rendered as text; no API runtime caching in the service worker.

## Recommendations (non-blocking)

- R2-1: Block field writes on assessments in status `complete` (today an assigned assessor can still change findings).
- R2-2: Shared rate-limit store before running more than one API instance; add a per-tenant analyze quota.
- R2-3: Cap concurrent sharp jobs (for example 2 per instance) to bound CPU under upload bursts.
- R2-4: Refuse re-upload of content once a photo is `stored` and has suggestions, or invalidate those suggestions.
- R2-5: Local PIN or WebAuthn unlock for the D-039 offline profile (already flagged by frontend).
- R2-6: Write the data classification for ASVS 8.3.4 (photos of security weaknesses, site addresses, GPS).
- R2-7: A record id already used in another tenant answers 409 `id_conflict`, which confirms that the UUID exists elsewhere. Low value to an attacker with random UUIDs; accepted, document it.

## Proposed decision rows (Head of Engineering to number)

| ID | Decision | Reason |
|---|---|---|
| D-053 | Sync field clocks use `min(clientUpdatedAt, server time)`; the raw client value stays in `sync_conflict`. | A future-dated device clock must not win every later conflict. |
| D-054 | Area deletion requires admin on every path (REST and sync). | Role parity between online and offline writes. |
| D-055 | Sign out keeps only framework and control reference data in the IndexedDB library cache. | Tenant data must not survive sign out on shared devices. |
