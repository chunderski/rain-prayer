# Sentinel Assess threat model

Owner: qa-security-reviewer. Method: STRIDE per component. Last reviewed: 2026-11-04 (Phase 1). Status keys: **mitigated** (control in code with test evidence), **partial**, **open** (no control yet), **future** (component not built; required control listed so the owning phase builds it in).

## System overview

| Component | Phase | Trust boundary |
|---|---|---|
| PWA (`apps/web`): standalone, iframe, `<sentinel-assess>` web component | 1 | Untrusted device and browser; may run inside a third-party host page |
| API (`apps/api`, Fastify) | 1 | Only component that talks to the database, storage, and third parties |
| Database (Postgres 16, RLS) | 1 | API connects as `sentinel_app` (RLS enforced); migrations as `sentinel_owner` |
| Object storage (MinIO / S3) | 2 (future) | Photos; reachable only through signed URLs issued by the API |
| AI pipeline (Anthropic vision and text) | 2 (future) | Third-party processor; inputs (photos, metadata) are attacker-influenced |
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

## Object storage (future, Phase 2)

| STRIDE | Threat | Required control |
|---|---|---|
| S | Guessable or long-lived photo URLs | Signed GET URLs, TTL at most 300 s (`SIGNED_URL_TTL_SECONDS`), issued only after an RLS-checked lookup |
| T | Upload overwrites another tenant's object | Server-generated keys `tenant/<tenant_id>/<uuid>`; presigned PUT bound to key, content type, and max length |
| R | Unattributed uploads | Audit row per upload and delete |
| I | EXIF GPS and device data leak in exports | Strip EXIF on ingest, keep GPS in the database only when allowed |
| I | Bucket made public | Block public access; bucket policy denies anonymous reads; encryption at rest |
| D | Oversized or decompression-bomb images | Size limit before upload, pixel-count limit, re-encode server side |
| E | Polyglot or SVG files executing in the app | Allow JPEG, PNG, HEIC only; verify magic bytes; serve with `Content-Disposition: attachment` and `nosniff` |

## AI pipeline (future, Phase 2)

| STRIDE | Threat | Required control |
|---|---|---|
| S | Prompt injection via text in photos (signs, notes, QR codes) or metadata fields | Treat model output as untrusted suggestions; system prompt states image text is data; structured output validated by zod; no tool use with side effects |
| T | AI output silently becomes a finding | Every AI suggestion stored as `suggested`; human accept required (mission rule 3); audit the accepting user |
| R | Unknown provenance of a finding | Store model id, prompt version, and input hashes with each suggestion |
| I | Tenant data sent to the model across tenants | One request per tenant context; no shared caches keyed without tenant; zero-retention terms with the processor |
| I | Secrets in prompts | API key only in server env; never sent to the browser |
| D | Cost exhaustion | Per-tenant quotas and rate limits on analysis requests |
| E | Model output rendered as HTML (stored XSS) | Render as text only; no `dangerouslySetInnerHTML` |

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
