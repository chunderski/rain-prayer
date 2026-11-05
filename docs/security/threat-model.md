# Sentinel Assess threat model

Owner: qa-security-reviewer. Method: STRIDE per component. Last reviewed: 2026-11-05 (Phase 2). Status keys: **mitigated** (control in code with test evidence), **partial**, **open** (no control yet), **future** (component not built; required control listed so the owning phase builds it in).

## System overview

| Component | Phase | Trust boundary |
|---|---|---|
| PWA (`apps/web`): standalone, iframe, `<sentinel-assess>` web component | 1 | Untrusted device and browser; may run inside a third-party host page |
| API (`apps/api`, Fastify) | 1 | Only component that talks to the database, storage, and third parties |
| Database (Postgres 16, RLS) | 1 | API connects as `sentinel_app` (RLS enforced); migrations as `sentinel_owner` |
| Object storage (MinIO / S3, local disk in dev) | 2 | Photos; reachable only through signed URLs issued by the API |
| AI pipeline (Anthropic vision and text) | 2 | Third-party processor; inputs (photos, metadata) are attacker-influenced |
| Google export (Docs, Sheets, Drive) | 3 (future) | Third-party processor using per-user OAuth grants |

Primary assets: tenant assessment data (client names, site addresses, findings, photos of security weaknesses), credentials and sessions, audit trail, framework library integrity.

Primary threat actors: an external attacker on the internet; a user of tenant A trying to reach tenant B; a low-privilege user in a tenant (viewer, assessor) trying to act as admin; a malicious embedding host page; a malicious photo or metadata aimed at the AI pipeline; a compromised third-party dependency.

## PWA

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| S | Stolen access token replayed | Access JWT held only in memory (closure), 15 min TTL; refresh token is httpOnly, Secure, SameSite=Strict, path `/auth` | mitigated | `apps/web/src/api/client.ts`; `apps/api/src/lib/auth.ts` (`setRefreshCookie`); D-014 |
| S | Phishing via crafted sign-in link (`?error=`) | Only allow-listed error codes are displayed, with own-property lookup | mitigated | `apps/web/src/screens/SignIn.tsx`; `apps/web/e2e/security.spec.ts` |
| T | Offline outbox used to replay or forge auth calls | Outbox schema rejects any path that normalizes to `/auth*`, protocol-relative paths, and backslashes | mitigated | `apps/web/src/offline/db.ts` (`OutboxInput`); `apps/web/src/offline/db.test.ts` |
| T | Service worker serves stale or poisoned API data | Precache of the app shell only; no `runtimeCaching`; `/auth` and `/api` excluded from navigation fallback | mitigated | `apps/web/vite.config.ts`; built `dist/sw.js` |
| R | User denies an action taken offline | Outbox items carry an idempotency key; server audit on replay | future | Phase 2 sync worker |
| I | Client data left on a shared device | Drafts cleared on sign out; library cache is reference data only; outbox not yet cleared on sign out | partial | `apps/web/src/auth/AuthContext.tsx` (`clearDrafts`) |
| I | XSS exfiltrates the in-memory token | React escaping, no `dangerouslySetInnerHTML` or `innerHTML`; no CSP on the PWA yet | partial | grep of `apps/web/src`; CSP is a deployment item |
| D | Large or malformed API responses crash the UI | Responses parsed with zod schemas; errors surfaced as banners | mitigated | `apps/web/src/api/schemas.ts` |
| E | Hostile host page drives the embedded app (clickjacking, DOM access to the open shadow root) | Embed has no service worker and a memory router; no allowlist of embedding origins and no `frame-ancestors` yet; open shadow root is readable by the host | open | `apps/web/src/embed.tsx`; Phase 2 allowlist (D-016) |

## API

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| S | Forged access token (`alg: none`, algorithm confusion, tampered claims) | `jose` `jwtVerify` with `algorithms: ["HS256"]`, issuer, audience, exp; secret at least 32 chars and not a placeholder | mitigated | `apps/api/src/lib/auth.ts`; `apps/api/src/config.ts`; live probe: `alg none` and tampered `tid` both 401 |
| S | Password guessing and credential stuffing | argon2id (64 MiB, t=3); per-IP rate limit on `/auth/*`; lockout after 5 failures for 15 min | mitigated | `apps/api/test/auth.test.ts` (lockout, rate limit) |
| S | User enumeration | Unknown email burns an argon2 verify and returns the same 401. A locked account answers 429 `account_locked` fast, which reveals that the account exists (accepted in D-022) | partial | live probe: locked 4 ms 429 versus unknown 400 ms 401 |
| S | Google OIDC login CSRF, code injection, ID token replay | state, nonce, PKCE S256 sealed in an A256GCM cookie (10 min); RS256 only, issuer and audience checked; `email_verified === true`; no auto-provisioning; `google_sub` pinned on first link | mitigated | `apps/api/src/routes/google.ts`; `apps/api/test/google.test.ts` |
| S | Stolen refresh token | 256-bit opaque token stored as SHA-256; rotation on every use; reuse of a rotated token revokes the family | mitigated | `apps/api/src/routes/auth.ts`; live probe: replay gives 401 and the successor also stops working |
| T | Cross-site request forgery on cookie routes | Refresh cookie SameSite=Strict, path `/auth`; `Origin` check on refresh and logout; data routes use bearer tokens only; JSON content type required | mitigated | `checkOrigin` in `apps/api/src/routes/auth.ts`; live probe: form post 415, foreign origin 403 |
| T | Mass assignment, tenant id smuggled in a body | zod schemas strip unknown keys; `tenant_id` always from the session | mitigated | `apps/api/test/isolation.test.ts` ("ignores a tenant id smuggled in the body") |
| R | Actions without attribution | Audit rows for login success, failure, logout, refresh reuse, and every create, with actor, IP, user agent | mitigated | `apps/api/src/lib/audit.ts`; `apps/api/test/routes.test.ts` |
| R | Authorization failures not recorded | 403 responses are not audited | open | recommendation R-6 |
| I | Stack traces or SQL errors in responses | Central error handler; 500 returns a generic envelope and logs server side | mitigated | `apps/api/src/app.ts`; `apps/api/test/routes.test.ts` |
| I | Tokens or cookies in logs | pino redaction of `authorization`, `cookie`, `set-cookie` | mitigated | `apps/api/src/app.ts` |
| I | API responses cached by intermediaries or the browser | No `Cache-Control: no-store` on authenticated responses | partial | recommendation R-4 |
| D | Request flooding | Body limit 256 KB; rate limits on auth routes only; anyone can lock a known account for 15 min | partial | recommendations R-2, R-3 |
| D | Vulnerable dependency (zod 3 advisory GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections) | Body limit caps input at 256 KB; arrays capped at 20 | partial | `npm audit --omit=dev`; recommendation R-1 |
| E | Viewer or assessor performs admin actions | `requireRole` reads the role from the database membership on every request, not from the token; minimum role per route matches `docs/api-phase1.md` | mitigated | `apps/api/test/routes.test.ts`; live probe: viewer POST /clients 403 |
| E | Removed or disabled user keeps access | Membership and `disabled_at` re-checked on every request and every refresh | mitigated | `apps/api/test/auth.test.ts` ("stops working when the membership is removed") |

## Database

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| S | API connects as a privileged role | Startup refuses superuser, BYPASSRLS, or table-owner roles; `sentinel_app` is NOSUPERUSER NOBYPASSRLS NOINHERIT and not a member of `sentinel_owner` | mitigated | `assertAppRoleSafe` in `apps/api/src/app.ts`; `apps/api/db/init/01-roles.sh`; live `pg_roles` check |
| T | Tenant A writes into tenant B | RLS ENABLED and FORCED on all 10 tenant tables; `WITH CHECK` on every write policy; composite FKs `(tenant_id, parent_id)` on site, area, assessment, assessment_framework, refresh_token | mitigated | `apps/api/db/migrations/002_tenant.sql`; `apps/api/test/isolation.test.ts`; live probe: site under B client and assessment on B site both 404 |
| T | Audit log tampering | App role has SELECT and INSERT only on `audit_log`; no UPDATE or DELETE grant or policy | mitigated | `002_tenant.sql`; `isolation.test.ts` ("cannot UPDATE or DELETE audit_log") |
| T | Reference library altered at runtime | App role has SELECT only on library tables | mitigated | `001_reference.sql`; `isolation.test.ts` |
| R | Owner-role changes untracked | Migrations tracked in `schema_migration`; no DB-level audit of owner sessions | partial | ops item |
| I | Tenant A reads tenant B | RLS on `app_current_tenant()`, transaction-local setting; unset setting yields NULL and zero rows | mitigated | `isolation.test.ts`; live probe: B client id 404, B site list empty, audit shows no B rows |
| I | Password hashes read by the app role | Column grant excludes `password_hash`, `google_sub`, counters; hashes reachable only through `auth_find_user` (SECURITY DEFINER, pinned `search_path`) | mitigated | `003_auth_functions.sql`; `isolation.test.ts` |
| I | SECURITY DEFINER functions as an oracle | Functions are EXECUTE-revoked from PUBLIC and granted to `sentinel_app` only. They accept any user id: SQL injection in the API would let an attacker read a hash by email, lock any account, or link a Google subject. Accepted because the API uses parameterized queries only | partial | recommendation R-7 |
| D | Lockout counter abuse | See API, D | partial | |
| E | `search_path` hijack in definer functions | `SET search_path = public, pg_temp`; app role has no CREATE on `public` | mitigated | live check: `has_schema_privilege('sentinel_app','public','CREATE') = f` |

## Object storage and photo pipeline (Phase 2)

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| S | Guessable or long-lived photo URLs | S3 presigned GET or local HMAC token bound to one key with expiry; TTL `SIGNED_URL_TTL_SECONDS` (300); issued only after an RLS-checked lookup; storage key separate from JWT key (D-050) | mitigated | `apps/api/src/storage/local.ts`; `apps/api/test/photos.test.ts` (expiry, key swap, forgery, JWT-key token) |
| T | Upload overwrites another tenant's object | Bytes go through the API (no presigned PUT); keys are server generated `tenants/<tid>/photos/<id>.jpg`, regex checked, path containment check | mitigated | `apps/api/src/storage/index.ts` `OBJECT_KEY`; `apps/api/test/isolation-phase2.test.ts` |
| T | Re-upload replaces the image of a photo that already has an accepted AI suggestion | Audit row with sha256 per upload | partial | No lock after `stored`; recommendation R2-4 |
| R | Unattributed uploads and deletes | `photo.upload`, `photo.delete` audit rows with sha256 and detected type | mitigated | `apps/api/src/routes/photos.ts` |
| I | EXIF, XMP, GPS leak | Re-encode from decoded pixels, no metadata written; GPS stored only when `allowGps` | mitigated | `apps/api/src/photos/process.ts`; `photos.test.ts` (EXIF GPS removed, GPS dropped header) |
| I | Bucket made public | Deployment control: block public access, SSE at rest | open (deploy) | No production bucket yet; Phase 5 hardening item |
| I | Local files readable by other OS users | Files 0600, directories 0700 | mitigated | `apps/api/src/storage/local.ts` |
| D | Oversized or decompression-bomb images | 15 MB body limit; `limitInputPixels` 100 MP; `failOn: error` | mitigated | `photos.test.ts` (413); `apps/api/test/qa-phase2.test.ts` (144 MP PNG gets 415; truncated JPEG 415) |
| D | CPU exhaustion through many uploads | Per-user data limit 600/min | partial | One sharp job per upload, no concurrency cap; in-memory limiter only (D-051) |
| E | Polyglot, SVG, or HTML executing in the app | Magic bytes allowlist (JPEG, PNG, WebP, HEIC); only re-encoded pixels stored; served as `image/jpeg` with `nosniff` | mitigated | `photos.test.ts` (svg, html, pdf, gif polyglot, appended script) |

## AI pipeline (Phase 2)

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| S | Prompt injection via text in photos or metadata | Frozen system prompt says image text and tagged notes are data; notes and area name escaped (`&`, `<`, `>`, control chars) and length capped; structured output with zod; no tools | mitigated (residual) | `packages/ai/src/prompts/photo-analysis.v1.ts`; `packages/ai` tests. Residual: a model can still be steered within the schema, which is why review is mandatory |
| T | AI output silently becomes a finding | Suggestions stored as `suggested`; findings only through `POST /suggestions/:id/review`; second review 409 (row locked `FOR UPDATE`); client cannot set `source` or `suggestionId` | mitigated | `apps/api/src/routes/ai.ts`; `ai.test.ts`; `qa-phase2.test.ts` (provenance spoofing ignored) |
| T | Model invents control IDs | Dropped in `packages/ai` and again server side against the assessment scope | mitigated | `ai.test.ts` "drops controls outside the scope" |
| R | Unknown provenance of a finding | `ai_suggestion` keeps model, prompt version, output, reviewer, reason; audit rows | mitigated | migration 004 |
| I | Tenant data to the model | Stored stripped JPEG only; notes and area only when `aiShareContext` (default false); GPS never sent | mitigated | `ai.test.ts` "passes notes only when the tenant allows" |
| D | Cost exhaustion | 30 analyses per user per hour | partial | Per user, not per tenant; in-memory (D-051) |
| E | Model output rendered as HTML | React text nodes only; no `dangerouslySetInnerHTML` in `apps/web/src` | mitigated | grep of `apps/web/src`; D-041 |

## Sync and field records (Phase 2)

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| S | Replay of another user's opId | `sync_operation` keyed by (tenant, opId); another user's opId is `rejected forbidden` | mitigated | `apps/api/src/routes/sync.ts` |
| T | Cross-tenant ids inside op payloads (areaId, assetId, findingId) | Reference checks run under RLS; composite FKs | mitigated | `qa-phase2.test.ts` |
| T | Future-dated `clientUpdatedAt` pins fields so later edits always lose | Clamped to server time (QA fix) | mitigated | `apps/api/src/field/records.ts`; `qa-phase2.test.ts` |
| E | Assessor deletes areas through sync though REST is admin only | Admin check in the engine delete path (QA fix) | mitigated | `qa-phase2.test.ts` |
| E | Unassigned assessor writes | `requireAssessmentWrite` in every write path | mitigated | `sync.test.ts`, `field.test.ts` |
| I | change_log leaks other tenants through cursors | change_log under forced RLS; cursor is only a sequence number | mitigated | `sync.test.ts` "only returns the requested tenant's changes" |
| D | Oversized batches | 200 ops, 2 MB body, 120 pushes/min per user | mitigated | `packages/shared/src/field.ts` |

## PWA offline store (Phase 2)

| STRIDE | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| I | Cached tenant data left on a shared device after sign out | Sign out wipes field stores, profile, and (QA fix) tenant entries in the library cache | mitigated | `apps/web/src/offline/db.ts`; `db.test.ts` |
| S | Offline start from cached profile (D-039) | Accepted risk: up to 30 days of offline read and write without a password; no API access without the refresh cookie | accepted | D-039; device lock is the control; local PIN recommended (R2-5) |

## Google export (future, Phase 3)

| STRIDE | Threat | Required control |
|---|---|---|
| S | Export to the wrong Google account | Per-user OAuth consent with `drive.file` scope (least privilege); show target account before export |
| T | Tampered export content | Generated server side from the database, not from client-supplied documents |
| R | Exports untracked | Audit row per export with destination file id |
| I | OAuth refresh tokens leaked | Encrypt at rest with a key outside the database; scope per user and tenant; revoke on unlink |
| I | Over-broad sharing of exported files | Create files private to the exporting user; no domain-wide sharing by default |
| D | Google API quota exhaustion | Queue with backoff; per-tenant limits |
| E | Export job runs with another tenant's grant | Job carries tenant id and runs inside `withTenant`; grant lookup through RLS |
