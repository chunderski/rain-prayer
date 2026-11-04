# @sentinel/api

Fastify + TypeScript API for Sentinel Assess, Phase 1: auth, tenants, clients, sites, assessments, framework library, audit log. The contract is [docs/api-phase1.md](../../docs/api-phase1.md).

## Layout

| Path | Purpose |
|---|---|
| `db/init/01-roles.sh` | Docker Postgres first-boot script: creates `sentinel_owner` and `sentinel_app` |
| `db/migrations/NNN_*.sql` | Schema, RLS policies, grants, SECURITY DEFINER auth functions |
| `src/db/migrate.ts` | Applies migrations as the owner role; tracks them in `schema_migration` with checksums |
| `src/db/seed.ts` | Loads the framework library into reference tables; seeds dev tenants and users |
| `src/app.ts`, `src/server.ts` | App builder (used by tests) and process entry |
| `src/routes/` | `auth`, `google` (OIDC), `library` (frameworks, controls), `tenant` (clients, sites, assessments, audit) |
| `test/` | Vitest suites against a real Postgres, fixture library in `test/fixtures` |

## Security model in one paragraph

The API connects as `sentinel_app` (not owner, not superuser, `NOBYPASSRLS`) and refuses to start otherwise. Every tenant request runs in a transaction that sets `app.tenant_id` with `set_config(..., true)`; RLS is enabled and forced on every tenant table. `audit_log` is INSERT and SELECT only for the app role. `app_user` is global: the app role can read only `id, email, name` of users who are members of the current tenant, never password hashes; login, lockout counters, and refresh token lookup go through narrow SECURITY DEFINER functions (see D-011 in docs/decisions.md). Passwords use argon2id; access tokens are HS256 JWTs (15 min); refresh tokens are opaque, stored as SHA-256 hashes, rotated on every use, and reuse of a rotated token revokes the whole session family.

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

Validated with zod at startup (`src/config.ts`); the process exits with a list of problems if anything is wrong. Notable rules: `JWT_SECRET` at least 32 characters and not a placeholder; production requires an https `WEB_ORIGIN` and no placeholder database password. Extra variables beyond `.env.example`: `API_HOST` (default 127.0.0.1; Docker sets 0.0.0.0), `TRUST_PROXY`, `AUTH_RATE_LIMIT_MAX` (default 10 per `AUTH_RATE_LIMIT_WINDOW`, 1 minute, for login and Google; refresh, logout, and me get 6 times that), `LOGIN_MAX_FAILURES` (5), `LOGIN_LOCKOUT_SECONDS` (900), `LOG_LEVEL`.

## Google sign-in

Active only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` hold real values; otherwise `/auth/google/*` answers 404 `google_not_configured`. The PWA navigates to `/auth/google/start` (optionally `?tenant=<slug>`). The callback verifies state, nonce, and PKCE, checks the ID token against Google's JWKS, and requires an existing user with that verified email (no auto-provisioning). On success it sets `sa_refresh` and redirects to `WEB_ORIGIN/?signin=google`, where the PWA calls `POST /auth/refresh`; on failure it redirects to `WEB_ORIGIN/login?error=<code>` with one of `invalid_state`, `google_denied`, `google_failed`, `email_not_verified`, `no_account`, `account_mismatch`, `tenant_required`, `no_tenant_access`.

## Error envelope

`{"error":{"code","message","details?"}}`. Codes used: `validation_error` (400, details are `[{path, message}]`), `bad_request`, `unknown_framework_version` (400), `unauthorized`, `invalid_credentials`, `invalid_refresh_token` (401), `forbidden`, `forbidden_origin`, `no_tenant_access` (403), `not_found`, `google_not_configured` (404), `tenant_required` (409), `account_locked`, `rate_limited` (429), `internal_error` (500, never with stack traces).
