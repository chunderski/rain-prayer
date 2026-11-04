# Phase 1 security and QA review

Reviewer: qa-security-reviewer. Date: 2026-11-04. Scope: `apps/api`, `apps/web`, `packages/shared`, `packages/frameworks`, migrations 001 to 003, Docker and env files, git history.

## Verdict: PASS

No blocking issues. Two small defects were fixed during the review (below). The recommendations are tracked for Phase 2 and should not be dropped.

## Test results

| Command | Result |
|---|---|
| `npm run typecheck` | pass (api, web) |
| `npm test` | pass: frameworks 13, api 57, web 25 (95 tests) |
| `npm run validate:frameworks` | pass: library 1.0.0, 5 framework versions, 101 controls, 176 questions, 272 crosswalk entries; all 228 requirements `needs_review` (D-013) |
| `npm run build -w @sentinel/web` | pass; service worker precaches the app shell only |
| `cd apps/web && npx playwright test` | pass: 39 (27 existing plus 12 new security cases across desktop, Pixel 7, iPhone 14) |
| `npm audit --omit=dev` | 1 high: zod 3.25.76, GHSA-mrhx-c7xc-m3w5 (see R-1) |

## What was verified

1. **Secrets.** Grep of the working tree and `git log -p` (15 commits): only documented placeholders (`replace-me`, `change-me-*`), the dev seed password `Sentinel-dev-2026!`, local test role passwords, and test-only JWT secrets. No real keys, tokens, or private keys. `.env` is git-ignored.
2. **Tenant isolation.** RLS is ENABLED and FORCED on all 10 tenant tables (checked live in `pg_class`). Every write policy has `WITH CHECK`; `audit_log` has SELECT and INSERT policies only. Composite FKs keep site, area, assessment, assessment_framework, and refresh_token in their parent's tenant. SECURITY DEFINER functions pin `search_path`, are revoked from PUBLIC, and return only what the auth flow needs. `sentinel_app` is NOSUPERUSER, NOBYPASSRLS, NOINHERIT, not a member of `sentinel_owner`, and has no CREATE on `public`. Live probes as tenant A owner against tenant B ids: GET client 404, sites by B client id empty, POST site under B client 404, POST assessment on B site 404, audit log shows no B rows.
3. **Auth.** HS256 pinned with issuer, audience, and expiry; `alg: none` and a tampered `tid` both return 401 live. Access TTL 15 min, refresh 14 days with rotation; replaying a rotated refresh token returns 401 and revokes its successor (live). Cookie `sa_refresh`: HttpOnly, Secure, SameSite=Strict, Path=/auth (live). Lockout after 5 failures, per-IP rate limit on `/auth/*`. Google OIDC: state, nonce, PKCE S256 in an encrypted cookie, RS256 only, `email_verified === true`, no auto-provisioning. Logout revokes the refresh family.
4. **Routes.** Every non-public route requires a bearer token; minimum roles match `docs/api-phase1.md`; every body, param, and query is parsed with zod; the error envelope never carries stack traces; Helmet headers including CSP on the API; CORS exact-match on `WEB_ORIGIN`; non-JSON bodies get 415.
5. **Frontend.** No token in localStorage, sessionStorage, or IndexedDB; no `dangerouslySetInnerHTML`; service worker has no runtime caching and is not registered by the embed; outbox refuses auth paths (hardened, below).

## Changes made during review

1. `apps/web/src/offline/db.ts`: the outbox check `!p.startsWith("/auth")` could be bypassed with `/./auth/login`, `/%2e/auth/refresh`, or `/clients/../auth/logout`, which fetch normalizes to `/auth/...`. The path is now normalized with `URL` before the check, and protocol-relative paths and backslashes are rejected. Tests added in `apps/web/src/offline/db.test.ts`.
2. `apps/web/src/screens/SignIn.tsx`: `GOOGLE_ERRORS[urlError]` used a plain object lookup, so `/?error=__proto__` rendered an object and crashed the sign-in page (anyone could send a link that breaks sign in). Now uses `Object.hasOwn`. Regression tests in `apps/web/e2e/security.spec.ts`; confirmed failing before the fix.

## Non-blocking recommendations

| # | Severity | Item | Owner |
|---|---|---|---|
| R-1 | medium | zod 3 advisory GHSA-mrhx-c7xc-m3w5. Exposure is limited by the 256 KB body limit and `.max()` caps; plan the zod 4 upgrade (revisit D-003) | Head of Eng |
| R-2 | medium | Lockout reveals account existence: a locked account answers 429 `account_locked` in about 4 ms, an unknown email answers 401 in about 400 ms (live). D-022 accepts the message; at minimum run the dummy argon2 verify on the locked path. Consider a generic 401 plus an email to the account owner | backend |
| R-3 | low | Anyone can lock a known account for 15 minutes. Add per-account plus per-IP throttling, or exponential backoff, before public launch | backend |
| R-4 | low | Add `Cache-Control: no-store` to authenticated API responses | backend |
| R-5 | low | Refresh rotation slides the 14-day lifetime forever; add an absolute session cap (for example 30 days) stored on the family | backend |
| R-6 | low | Audit 403 responses and refresh failures (ASVS 7.2.2) | backend |
| R-7 | low | SECURITY DEFINER auth functions accept any user id; acceptable while the API uses only parameterized SQL. Keep that invariant under review | backend |
| R-8 | low | Google callback does not honour `locked_until`, and a successful Google login clears a password lockout. Decide and document | backend |
| R-9 | low | No rate limits on data routes; add a generous global limit per user | backend |
| R-10 | low | PWA has no CSP and no `frame-ancestors` allowlist; define both with the production hosting and the embed allowlist (Phase 2) | frontend |
| R-11 | low | Outbox items are not cleared at sign out; the Phase 2 sync design must bind items to user and tenant | frontend |
| R-12 | low | The API container gets `MIGRATION_DATABASE_URL` (owner credentials) at runtime; run migrations as a separate one-shot job in production | Head of Eng |
| R-13 | low | Require `sslmode=require` (or verify-full) on database URLs in production config | backend |
| R-14 | info | Google error codes `invalid_request` and `tenant_required` have no message in the sign-in page; multi-workspace Google users get no prompt | frontend |
| R-15 | info | MFA (TOTP or WebAuthn) for owner and admin roles before Phase 4 | Head of Eng |

## Notes

- The live probe created one client and one site in tenant `bluefield-security` in the dev database `sentinel` (names "B corp" and "B site"); re-seed to remove them.
- The threat model is in `docs/security/threat-model.md`; ASVS status is in `docs/security/asvs-checklist.md`.
