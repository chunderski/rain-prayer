# OWASP ASVS 4.0.3 checklist (Level 2 target)

Owner: qa-security-reviewer. Last reviewed: 2026-11-04 (Phase 1). Status: **met**, **partial**, **not yet**, **N/A**. Evidence paths are relative to the repository root. Requirements are summarized, not quoted; see the ASVS 4.0.3 text for exact wording. Items marked "not yet" are not Phase 1 blockers unless `docs/security/phase1-review.md` says so.

## V2 Authentication

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 2.1.1 | Passwords at least 12 characters | not yet | No password set or change flow in Phase 1 (users are seeded). Enforce at least 12 when it is added |
| 2.1.2 | Passwords of 64 or more characters permitted | met | `LoginRequest.password` max 256, `packages/shared/src/domain.ts` |
| 2.1.3 | No truncation of passwords | met | argon2 hashes the full input, `apps/api/src/lib/auth.ts` |
| 2.1.7 | Check new passwords against breached lists | not yet | Needed with the password set flow |
| 2.1.9 | No composition rules | met | None imposed |
| 2.2.1 | Anti-automation against credential attacks | met | Rate limit `AUTH_RATE_LIMIT_MAX` per IP, lockout after `LOGIN_MAX_FAILURES`, `apps/api/src/routes/auth.ts`, `apps/api/test/auth.test.ts` |
| 2.2.3 | Notify users after changes to authentication details | not yet | No change flows yet |
| 2.3.1 | System-generated initial passwords are random and expire | N/A | No invitations yet (Phase 2 or 4) |
| 2.4.1 | Passwords stored with an approved adaptive hash | met | argon2id, 64 MiB, t=3, p=1, `apps/api/src/lib/auth.ts` |
| 2.4.2 | Salt at least 32 bits, unique per credential | met | argon2 library generates a per-hash salt |
| 2.5.1 to 2.5.7 | Credential recovery | not yet | No reset flow in Phase 1 |
| 2.5.4 | No shared or default accounts | met | Dev users refused when `NODE_ENV=production`, `apps/api/src/db/seed.ts` |
| 2.7.x, 2.8.x | Out-of-band and OTP authenticators | not yet | No MFA. Google sign-in can carry the customer's Google MFA. Recommend TOTP or WebAuthn for owner and admin before Phase 4 |
| 2.10.1 | No hard-coded service credentials | met | Env only; placeholders refused at startup, `apps/api/src/config.ts`; grep of tree and git history found no real secrets |
| 2.10.4 | Secrets not in source code | met | `.env.example`, `apps/api/.env.local.example` hold placeholders only; `.env` ignored |
| (OIDC) | Google sign-in validates state, nonce, PKCE, issuer, audience, `email_verified` | met | `apps/api/src/routes/google.ts`, `apps/api/test/google.test.ts` |

## V3 Session management

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 3.1.1 | No session tokens in URLs | met | Bearer header and httpOnly cookie only; Google callback redirects with `?signin=google`, no token |
| 3.2.1 | New session token on authentication | met | New refresh family per login, `startSession` in `apps/api/src/routes/auth.ts` |
| 3.2.2 | At least 64 bits of entropy | met | 256-bit refresh token, `newRefreshToken` |
| 3.2.3 | Tokens stored securely in the browser | met | Access token in memory only; refresh in httpOnly cookie; no Web Storage use, `apps/web/src/api/client.ts` |
| 3.2.4 | Approved cryptographic algorithms | met | HS256 via `jose`, SHA-256 hash at rest |
| 3.3.1 | Logout invalidates the session | partial | Refresh family revoked; the access JWT remains valid until expiry (at most 15 min) |
| 3.3.2 | Periodic re-authentication (L2: 12 h or 30 min idle) | partial | Refresh rotation slides a 14-day lifetime with no absolute cap; recommendation R-5 |
| 3.3.3 | Option to end other sessions after credential change | not yet | No credential change flow |
| 3.3.4 | Users can view and log out active sessions | not yet | Data exists in `refresh_token`; no endpoint |
| 3.4.1 | Cookie `Secure` | met | Set unless `NODE_ENV=development`; live probe shows `Secure` |
| 3.4.2 | Cookie `HttpOnly` | met | `setRefreshCookie` |
| 3.4.3 | Cookie `SameSite` | met | `Strict` for `sa_refresh`, `Lax` for the 10-minute `sa_oidc` state cookie (needed for the Google redirect) |
| 3.4.4 | `__Host-` prefix | partial | Not used; cookie is scoped to path `/auth` instead. Consider `__Secure-` |
| 3.4.5 | Cookie path set narrowly | met | `/auth` and `/auth/google` |
| 3.5.2 | Session tokens, not static API keys | met | |
| 3.5.3 | Stateless tokens protected by signature and checked | met | Algorithm pinned, `iss`, `aud`, `exp`, `sub`, `tid`, `role` checked, `verifyAccessToken`; role then re-read from the database |
| 3.7.1 | Re-authentication for sensitive actions | not yet | No sensitive account actions in Phase 1 |

## V4 Access control

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 4.1.1 | Enforced on a trusted service layer | met | `requireRole` preHandler plus Postgres RLS |
| 4.1.2 | User and data attributes cannot be manipulated by users | met | Role and tenant read from membership per request; body `tenant_id` ignored, `apps/api/test/isolation.test.ts` |
| 4.1.3 | Least privilege | met | Route minimum roles match `docs/api-phase1.md`; `sentinel_app` has only needed grants |
| 4.1.5 | Fail securely | met | Missing tenant setting yields zero rows; errors become 401, 403, 404 |
| 4.2.1 | Protection against IDOR | met | RLS plus 404 for foreign ids; composite FKs; live probe as tenant A against tenant B client, site, assessment ids |
| 4.2.2 | Anti-CSRF | met | Bearer tokens for data routes; SameSite=Strict and `Origin` check on cookie routes; JSON content type required |
| 4.3.1 | MFA for administrative interfaces | not yet | See 2.7.x |
| 4.3.2 | No directory browsing or metadata exposure | met | API has no static serving |

## V5 Validation, sanitization, and encoding

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 5.1.1 | HTTP parameter pollution defenses | met | zod parses each query and param; arrays rejected where scalars are expected |
| 5.1.3 | All input validated (allow list) | met | `parse()` with shared zod schemas on every body, param, query, `apps/api/src/lib/errors.ts`; `apps/api/test/routes.test.ts` |
| 5.1.4 | Structured data strongly typed | met | UUID, semver, framework id, control id patterns |
| 5.1.5 | Redirects only to allow-listed destinations | met | Redirects go only to `WEB_ORIGIN` or the fixed Google URL |
| 5.2.1 | Untrusted HTML sanitized | N/A | No HTML input |
| 5.2.6 | SSRF protection | met | Outbound calls only to fixed Google endpoints |
| 5.3.3 | Context-aware output encoding (XSS) | met | React escaping; no `dangerouslySetInnerHTML` in `apps/web/src` |
| 5.3.4 | Parameterized queries | met | All SQL uses `$n` parameters; `LIKE` wildcards escaped in `/controls?q=` |
| 5.5.2 | XML parsers restrict XXE | N/A | JSON only |
| 5.5.3 | Safe deserialization | met | `JSON.parse` then zod; Fastify prototype-poisoning protection on by default |

## V7 Error handling and logging

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 7.1.1 | No credentials or session tokens logged | met | pino redaction, `apps/api/src/app.ts` |
| 7.1.2 | No other sensitive data logged | partial | IP and user agent kept in `audit_log`; define retention (privacy notice) |
| 7.1.3 | Security events logged | met | Login success, failure, lock, logout, refresh reuse, creates, `apps/api/src/lib/audit.ts` |
| 7.1.4 | Events carry enough context | met | Actor, tenant, entity, IP, user agent, timestamp |
| 7.2.1 | Authentication decisions logged | met | `apps/api/test/auth.test.ts` ("writes audit entries") |
| 7.2.2 | Access control decisions logged | not yet | 403 responses are not audited; recommendation R-6 |
| 7.3.1 | Log injection prevented | met | Structured JSON logs (pino) |
| 7.3.3 | Logs protected from modification | partial | App role cannot UPDATE or DELETE `audit_log`; the owner role can; no off-box shipping yet |
| 7.4.1 | Generic error message with no internals | met | 500 envelope `internal_error`; `apps/api/test/routes.test.ts` |

## V8 Data protection

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 8.1.1 | Sensitive data not cached server side unsafely | met | No server cache |
| 8.2.1 | Anti-caching headers on sensitive responses | partial | No `Cache-Control: no-store` on authenticated API responses; recommendation R-4 |
| 8.2.2 | Sensitive data in browser storage minimized | partial | IndexedDB holds the reference library, drafts (cleared at sign out) and the outbox (not cleared at sign out) |
| 8.2.3 | Client storage cleared after session ends | partial | Drafts cleared; outbox to be handled by the Phase 2 sync design |
| 8.3.1 | Sensitive data in body or headers, not URL | met | Credentials and tokens never in query strings |
| 8.3.4 | Sensitive data identified and policy defined | not yet | Data classification (photos of security weaknesses, site addresses) to be written with Phase 2 |
| 8.3.x | Encryption at rest | not yet | Deployment item: encrypted volumes and bucket encryption |

## V9 Communications

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 9.1.1 | TLS for all client connectivity | partial | Production config requires `https` `WEB_ORIGIN`; API sends HSTS; TLS termination is a deployment item |
| 9.1.2, 9.1.3 | Strong TLS versions and ciphers | not yet | Deployment item |
| 9.2.1 | TLS for server-to-server connections | partial | Google over HTTPS; `DATABASE_URL` does not require `sslmode`; require it in production |

## V12 Files and resources (future, Phase 2 photo upload)

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 12.1.1 | Reject oversized files | partial | JSON body limit 256 KB today; photo limits are Phase 2 |
| 12.1.2 | Check compressed files (zip bombs, pixel floods) | not yet | Phase 2 |
| 12.2.1 | Validate file type by content | not yet | Phase 2: magic bytes, allow JPEG, PNG, HEIC |
| 12.3.1 | User-supplied file names not used for paths | not yet | Phase 2: server-generated keys |
| 12.4.1 | Files stored outside the web root, isolated | not yet | Phase 2: private bucket |
| 12.5.1, 12.5.2 | Serve only allowed types; attachments not executed | not yet | Phase 2: `Content-Disposition: attachment`, `nosniff` |
| 12.6.1 | SSRF allow list for fetched resources | met | No user-supplied URLs fetched |

## V13 API and web service

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 13.1.1 | Same encoding and parsers across components | met | JSON everywhere; shared zod schemas |
| 13.1.3 | URLs carry no sensitive data | met | |
| 13.1.4 | Authorization at URI and resource level | met | Role preHandler plus RLS per row |
| 13.1.5 | Unexpected content types rejected | met | 415 for non-JSON, live probe with a form post |
| 13.2.1 | Only intended HTTP methods enabled | met | Unknown routes and methods return the 404 envelope |
| 13.2.2 | Schema validation of JSON input | met | zod |
| 13.2.3 | CSRF protection on cookie-based routes | met | See 4.2.2 |
| 13.2.5 | Content type checked | met | Custom JSON parser |
| 13.2.6 | Headers and payload trusted only after validation | met | |

## V14 Configuration

| ID | Requirement (summary) | Status | Evidence or gap |
|---|---|---|---|
| 14.1.1 | Secure, repeatable build | partial | `npm ci` in Dockerfiles; no CI pipeline yet |
| 14.2.1 | Components up to date, no known vulnerabilities | partial | `npm audit --omit=dev`: 1 high, zod 3.25.76 (GHSA-mrhx-c7xc-m3w5); recommendation R-1 |
| 14.2.3 | Third-party assets with integrity | met | No CDN assets |
| 14.3.2 | Debug modes off in production | met | Pretty logging only in development; generic errors |
| 14.3.3 | Headers do not expose versions | met | No `X-Powered-By` |
| 14.4.1 | Content-Type with charset | met | `application/json; charset=utf-8` |
| 14.4.3 | Content Security Policy | partial | Helmet CSP on the API (live probe); none on the PWA yet (deployment headers) |
| 14.4.4 | `X-Content-Type-Options: nosniff` | met | API |
| 14.4.5 | HSTS | met | API, `max-age=31536000; includeSubDomains` |
| 14.4.6 | Referrer-Policy | met | `no-referrer` on the API |
| 14.4.7 | Framing controlled | partial | API: `frame-ancestors 'self'`; PWA framing is intentional (embed) but has no origin allowlist yet |
| 14.5.1 | Only allowed HTTP methods | met | |
| 14.5.3 | CORS origin allow list | met | Exact `WEB_ORIGIN` match, `apps/api/test/routes.test.ts`, live preflight from a foreign origin gets no `Access-Control-Allow-Origin` |
| (config) | API refuses a role that can bypass RLS; placeholder secrets refused | met | `assertAppRoleSafe`, `apps/api/src/config.ts` |
