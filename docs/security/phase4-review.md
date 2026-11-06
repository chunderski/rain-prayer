# Phase 4 security review (channel)

Reviewer: qa-security-reviewer. Date: 2026-11-06. Verdict: **PASS**, after two fixes made in this review; recommendations below.

## Scope

Migration `006_channel.sql`; routes `branding`, `members`, `pricebook`, `quotes`, `portal`, `auth` (setup); `apps/api/src/quotes/`; `apps/api/src/lib/branding.ts`; `packages/shared/src/channel.ts`; web Portal, Quotes, Members, Branding screens.

## Results

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | pass (API 201 tests, all workspaces green); one earlier run had 2 failures plus 1 suite error that did not reproduce (shared test DB contention, R4-6) |
| `npm run build -w @sentinel/web` | pass |
| `npx playwright test` (apps/web) | 118 passed, 2 skipped |

## Fixed in review

- QA P4-1 (high): `/auth/setup` for an existing account verified the password without checking the lockout, so any workspace admin who invited a known email held an unlimited (rate limited only per IP) password oracle for that account. Fix: lockout checked first (`routes/auth.ts`); test "setup link honors the sign-in lockout".
- QA P4-2 (low, defense in depth): branding website accepted `javascript:` and `data:` URLs. Today it is printed as text only, but it is now limited to http(s) (`packages/shared/src/channel.ts`); assertion in the branding test.
- Test gap: the client_viewer route walk used random ids, so a 404 could hide a missing role check. Added a walk with the viewer's own real assessment, client, and site ids plus query variants that requires 401 or 403.

## Verified (Head of Engineering fixes)

Client logins get the prices-only view from `GET /portal/quotes/:id` and from accept or decline; quote preview HTML prints prices only; suggestions pick one item per tier and drop wrong asset types.

## Recommendations (non-blocking)

- R4-1 (medium): pre-claiming. `claimable` ignores invited memberships elsewhere, so an admin of tenant B can invite an email that is pending in tenant A and set its global password first; the victim then cannot finish A's setup. Make an account claimable only when it has no other membership at all, or require email verification. Fix before general availability.
- R4-2 (low): `POST /members` echoes the existing account's stored name to another tenant's admin. Return the name the inviter typed until the person joins. Enumeration of existing accounts through invites is accepted by design.
- R4-3: Rate limit `POST /members` per user; invites create global identities.
- R4-4: Consider a separation-of-duties setting so a below-margin quote needs an owner other than its submitter.
- R4-5: The portal report includes photo notes as written by assessors; remind integrators in `docs/channel-guide.md` that the report is client facing.
- R4-6: The seed idempotency test counts `app_user` while other files create users; run it in isolation or count only seeded rows.
