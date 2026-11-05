# @sentinel/api

Fastify + TypeScript API for Sentinel Assess. Phase 1: auth, tenants, clients, sites, assessments, framework library, audit log ([docs/api-phase1.md](../../docs/api-phase1.md)). Phase 2: field capture, photos, AI suggestions, offline sync ([docs/api-phase2.md](../../docs/api-phase2.md)).

## Layout

| Path | Purpose |
|---|---|
| `db/init/01-roles.sh` | Docker Postgres first-boot script: creates `sentinel_owner` and `sentinel_app` |
| `db/migrations/NNN_*.sql` | Schema, RLS policies, grants, SECURITY DEFINER auth functions |
| `src/db/migrate.ts` | Applies migrations as the owner role; tracks them in `schema_migration` with checksums |
| `src/db/seed.ts` | Loads the framework library into reference tables; seeds dev tenants and users |
| `src/app.ts`, `src/server.ts` | App builder (used by tests) and process entry |
| `src/routes/` | `auth`, `google` (OIDC), `library` (frameworks, controls), `tenant` (clients, sites, assessments, audit), `field` (areas, members, assignment, walkthrough, answers, assets, findings, settings), `photos`, `ai`, `sync` |
| `src/field/` | Shared write path for REST and sync: access checks, pinned library scope, validation, versioning, conflict resolution |
| `src/photos/process.ts` | Upload sanitizer: magic bytes, decode, re-encode without metadata, thumbnail |
| `src/storage/` | Object storage interface with `local` (HMAC-signed URLs) and `s3` (presigned GET) drivers |
| `test/` | Vitest suites against a real Postgres, fixture library in `test/fixtures` |

## Security model in one paragraph

The API connects as `sentinel_app` (not owner, not superuser, `NOBYPASSRLS`) and refuses to start otherwise. Every tenant request runs in a transaction that sets `app.tenant_id` with `set_config(..., true)`; RLS is enabled and forced on every tenant table. `audit_log` is INSERT and SELECT only for the app role. `app_user` is global: the app role can read only `id, email, name` of users who are members of the current tenant, never password hashes; login, lockout counters, and refresh token lookup go through narrow SECURITY DEFINER functions (see D-011 in docs/decisions.md). Passwords use argon2id; access tokens are HS256 JWTs (15 min); refresh tokens are opaque, stored as SHA-256 hashes, rotated on every use, and reuse of a rotated token revokes the whole session family.

## Phase 2 in brief

- **Field records.** Areas, assets, answers, findings, and photo metadata go through one engine (`src/field/records.ts`) from both REST and `POST /sync/push`, so validation and the `version` counter are shared. Answers are checked against the question type of the assessment's pinned library release; control ids must belong to the assessment's frameworks. Assessors write only to assessments they are assigned to (the creator is assigned automatically); admins and owners write anywhere; viewers read.
- **Versions and change log.** Triggers bump `version` on every update and append a `change_log` row in the same transaction, numbered by a per-tenant counter so cursors never skip a change (D-030). Deletes are soft (`deleted_at`) and appear in pulls as tombstones.
- **Sync.** Each op runs in its own savepoint; `sync_operation` makes `opId` idempotent (rejections are stored too and replay as `duplicate`). Conflicts use field-level last writer wins by `clientUpdatedAt` with per-field clocks; the losing copy is written to `sync_conflict` and audited (D-031). Authorization failures and other tenants' records return `rejected` `forbidden` and are audited. Other rejection codes: `validation_error`, `unknown_control`, `unknown_question`, `invalid_reference`, `answer_exists` (with `server`), `id_conflict`, `version_ahead`, `not_found_on_server`, `area_in_use`, `internal_error` (not stored, retry). Pull cursors are opaque; pass back `cursor` as `since`.
- **Photos.** `PUT /photos/:id/content` takes a raw body (parser scoped to that route, 15 MB). Content is identified by magic bytes, decoded by sharp with a pixel limit, re-encoded to JPEG q85 with no EXIF, XMP, IPTC, or ICC, long edge at most 4096, plus a 512 px thumbnail. HEIC is refused with 415 because this sharp build has no HEVC decoder (D-033). GPS is dropped unless the tenant setting `allowGps` is on (`X-Sentinel-Gps: dropped`).
- **Signed URLs.** `local`: `GET /files/<token>`, an HMAC-SHA256 grant for one object key with an expiry (D-034). `s3`: presigned GET, optionally signed for `S3_PUBLIC_ENDPOINT`. Both valid for `SIGNED_URL_TTL_SECONDS` (300).
- **AI.** `POST /photos/:id/analyze` sends a 1568 px copy of the stored JPEG to `@sentinel/ai` with the assessment's candidate controls (walkthrough asset-type hints first), the configured `ANTHROPIC_VISION_MODEL`, and notes and area name only when `aiShareContext` is on. Output is stored as a suggestion (`suggested`, or `failed` with the VisionError code); unknown control ids are dropped again server-side. Only `POST /suggestions/:id/review` with accept or edit creates findings (`ai_accepted` or `ai_edited`) and applies photo tags, in one audited transaction. Tests inject a fake `VisionClient` through `buildApp(cfg, { vision })`.
- **Walkthrough.** Sections come from `packages/frameworks/data/walkthrough.json`; without it, one section per domain in enum order. Controls appear once, in the first section that claims their domain.

## Embedding (QA R-10)

`EMBED_ORIGINS` is a comma-separated list of bare origins (https in production) that may host the web component or the iframe. The API adds them to CORS (exact match, credentials) and accepts them on the refresh and logout Origin check. The web host must send `Content-Security-Policy: frame-ancestors 'self' <EMBED_ORIGINS separated by spaces>` on the PWA document, for example `frame-ancestors 'self' https://portal.integrator.example`.

## Run locally without Docker

Prerequisites: Node 22, PostgreSQL 16 on localhost:5432, `npm install` done at the repo root.

1. Create the roles and the database (as a Postgres superuser):

   ```sh
   psql -U postgres <<'SQL'
   CREATE ROLE sentinel_owner LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'sentinel-owner-local';
   CREATE ROLE sentinel_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD 'sentinel-app-local';
   CREATE DATABASE sentinel OWNER sentinel_owner;
   REVOKE ALL ON DATABASE sentinel FROM PUBLIC;
   GRANT CONNECT, TEMPORARY ON DATABASE sentinel TO sentinel_app;
   SQL
   ```

2. Set the environment (see `.env.local.example`; generate a real `JWT_SECRET` with `openssl rand -base64 48`).

3. Migrate, seed, and start:

   ```sh
   npm run db:migrate -w @sentinel/api   # uses MIGRATION_DATABASE_URL
   npm run db:seed -w @sentinel/api      # library + dev users (skipped when NODE_ENV=production)
   npm run dev -w @sentinel/api          # http://localhost:3000
   ```

4. Check it:

   ```sh
   curl localhost:3000/health
   curl -H 'content-type: application/json' -d '{"email":"owner@acme.test","password":"Sentinel-dev-2026!"}' localhost:3000/auth/login
   ```

Seed options: `--strict` fails on any library validation error (always on in production); without it, a library that is still being authored is loaded leniently (invalid files and dangling crosswalk entries are skipped and listed). `--library-only` skips dev users. `--data-dir <dir>` loads another library directory.

## Docker

`docker compose up --build` starts Postgres (running `db/init/01-roles.sh` on first boot), MinIO, and the API. The API container applies migrations on start. Seed once with `docker compose exec api node --import tsx apps/api/src/db/seed.ts`.

## Tests

```sh
npm test -w @sentinel/api
npx tsc --noEmit -p apps/api
```

`test/setup-db.ts` recreates the `sentinel_test` database and the two roles before every run, so the suite is self-contained. It needs superuser access: `su postgres -c psql` when running as root, or set `TEST_PG_ADMIN_URL`. Roles are cluster-wide, so the run sets their passwords to `TEST_OWNER_PASSWORD` and `TEST_APP_PASSWORD` (defaults `sentinel-owner-local`, `sentinel-app-local`).

## Configuration

Validated with zod at startup (`src/config.ts`); the process exits with a list of problems if anything is wrong. Notable rules: `JWT_SECRET` at least 32 characters and not a placeholder; production requires an https `WEB_ORIGIN` and no placeholder database password. Phase 2 variables (all in `.env.example`): `STORAGE_DRIVER` (`local` default, or `s3`), `LOCAL_STORAGE_DIR`, `STORAGE_SIGNING_SECRET` (optional), `S3_*` (required when `s3`), `S3_PUBLIC_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_SSE`, `SIGNED_URL_TTL_SECONDS`, `API_PUBLIC_URL`, `EMBED_ORIGINS`, `SESSION_ABSOLUTE_TTL_SECONDS` (30 days), `DATA_RATE_LIMIT_MAX` and `DATA_RATE_LIMIT_WINDOW_SECONDS` (600 per 60 s per user), `SYNC_RATE_LIMIT_MAX` (120), `AI_ANALYZE_RATE_LIMIT_PER_HOUR` (30), `ANTHROPIC_API_KEY` (a placeholder means AI is off: 503 `ai_not_configured`), `ANTHROPIC_VISION_MODEL`. Rate limits are in memory per process; put a shared store behind them before running several API instances. Extra variables beyond `.env.example`: `API_HOST` (default 127.0.0.1; Docker sets 0.0.0.0), `TRUST_PROXY`, `AUTH_RATE_LIMIT_MAX` (default 10 per `AUTH_RATE_LIMIT_WINDOW`, 1 minute, for login and Google; refresh, logout, and me get 6 times that), `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCKOUT_SECONDS` (900), `LOG_LEVEL`.

## Google sign-in

Active only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` hold real values; otherwise `/auth/google/*` answers 404 `google_not_configured`. The PWA navigates to `/auth/google/start` (optionally `?tenant=<slug>`). The callback verifies state, nonce, and PKCE, checks the ID token against Google's JWKS, and requires an existing user with that verified email (no auto-provisioning). On success it sets `sa_refresh` and redirects to `WEB_ORIGIN/?signin=google`, where the PWA calls `POST /auth/refresh`; on failure it redirects to `WEB_ORIGIN/login?error=<code>` with one of `invalid_state`, `google_denied`, `google_failed`, `email_not_verified`, `no_account`, `account_mismatch`, `tenant_required`, `no_tenant_access`.

## Error envelope

`{"error":{"code","message","details?"}}`. Codes used: `validation_error` (400, details are `[{path, message}]`), `bad_request`, `unknown_framework_version` (400), `unauthorized`, `invalid_credentials`, `invalid_refresh_token` (401), `forbidden`, `forbidden_origin`, `no_tenant_access` (403), `not_found`, `google_not_configured` (404), `tenant_required` (409), `account_locked`, `rate_limited` (429), `internal_error` (500, never with stack traces). Phase 2 adds `unknown_control`, `unknown_question`, `invalid_reference`, `invalid_assessor`, `invalid_cursor` (400), `payload_too_large` (413), `unsupported_media` (415), `area_in_use`, `answer_exists`, `id_conflict`, `invalid_transition`, `photo_not_uploaded`, `ai_disabled`, `not_reviewable`, `photo_deleted`, `version_ahead` (409), `ai_not_configured` (503). Every 403 is written to the audit log (`access.denied`).
