# Sentinel Assess

AI-native physical and cyber security assessment platform for systems integrators and security contractors: guided field walkthroughs with photos, a shared control library across CARVER, CPTED, general physical security, NIST CSF 2.0, and PQC readiness, explainable risk scoring, and Google Docs, Sheets, and Drive export.

Status: Phase 1 (Foundation). See [PLAN.md](PLAN.md).

## Quick start (Docker)

```bash
cp .env.example .env          # replace placeholders
docker compose up --build     # db, minio, api (:3000), web (:5173)
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed
```

## Quick start (no Docker)

Requires Node 22 and PostgreSQL 16. See [apps/api/README.md](apps/api/README.md) for creating the database roles, then:

```bash
npm install
npm run db:migrate && npm run db:seed
npm run dev:api     # http://localhost:3000
npm run dev:web     # http://localhost:5173
```

## Demo from one address (remote preview or tunnel)

`scripts/demo-server.mjs` serves the built app and proxies `/api` to the API on one port, so the product works from a single URL (a cloud preview, a tunnel, or another device on your network). Demo use only.

```bash
npm --prefix apps/web exec -- env VITE_API_URL=http://localhost:8080/api vite build   # or: cd apps/web && VITE_API_URL=http://localhost:8080/api npx vite build
WEB_ORIGIN=http://localhost:8080 API_PUBLIC_URL=http://localhost:8080/api npm run start -w @sentinel/api   # plus your usual DB and JWT env
node scripts/demo-server.mjs   # http://localhost:8080
```

## Checks

```bash
npm run typecheck
npm test
npm run validate:frameworks
```

## Repository map

| Path | What |
|---|---|
| `apps/api` | Fastify API, migrations, row-level security |
| `apps/web` | Progressive web app |
| `packages/shared` | Shared schemas and types |
| `packages/frameworks` | Versioned framework library and crosswalk |
| `docs/` | Decisions, user stories, API contract, security |
| `.claude/agents/` | The agent team definitions |

## Legacy

`rain_prayer.py` is the original contents of this repository and is unrelated to Sentinel Assess (`python rain_prayer.py`).
