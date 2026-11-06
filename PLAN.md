# Sentinel Assess: Delivery Plan

Owner: CW (product owner). Engineering lead: Head of Engineering (Claude). Status: Phase 1 complete (QA PASS, CW go-ahead 2026-11-04); Phase 2 complete (QA PASS 2026-11-05); Phase 3 complete (QA PASS 2026-11-05); Phase 4 in progress (CW go-ahead 2026-11-06).

Sentinel Assess is an AI-native physical and cyber security assessment platform sold through systems integrators. It combines guided field walkthroughs with photos (EasySet style) and quantified inherent, control, and residual risk (Circadian Risk style), and adds AI photo analysis, physical and cyber in one assessment, and integrator-first quoting.

Related documents:
- User stories and acceptance criteria: [docs/user-stories.md](docs/user-stories.md)
- Engineering decisions: [docs/decisions.md](docs/decisions.md)
- Framework library guide: [packages/frameworks/README.md](packages/frameworks/README.md)
- Security: [docs/security/](docs/security/)
- Team definitions: [.claude/agents/](.claude/agents/)

## 1. Team

| Agent | Owns |
|---|---|
| security-frameworks-architect | Shared control library, framework data, crosswalk, citations |
| risk-scoring-analyst | Threat scenarios, inherent, control, and residual risk engine, explanations |
| frontend-engineer | PWA, framework picker, walkthrough, capture, offline, dashboards, embed |
| vision-ai-engineer | Claude vision pipeline, prompt templates, fixtures, draft findings |
| backend-integrations-engineer | API, schema, RLS, auth, storage, sync, Google exports, report templates |
| channel-product-manager | User stories, integrator workspace, branding, findings-to-quote, field UX review |
| qa-security-reviewer | Tests, threat model, ASVS review; can block merges |

Definition of done for any task: tests pass, typecheck passes, qa-security-reviewer signs off, decision log updated, Head of Engineering summary written.

## 2. Architecture

```
 Field device (phone/tablet)                       Cloud / Docker Compose
 +-----------------------------+                   +-----------------------------------+
 | PWA (React, Vite, Tailwind) |   HTTPS + JWT     | API (Fastify, TypeScript)         |
 |  - service worker (shell)   | <---------------> |  - auth, RBAC, tenant context     |
 |  - IndexedDB (assessments,  |   sync queue      |  - REST + sync endpoints          |
 |    answers, photos, queue)  |                   |  - audit log                      |
 |  - web component / iframe   |                   |  - AI service (Claude)  ------------> Anthropic API
 +-----------------------------+                   |  - export service      ------------> Google Docs/Sheets/Drive
                                                   +------+-------------------+--------+
                                                          |                   |
                                              PostgreSQL 16 (RLS)     S3-compatible storage
                                              reference + tenant data  (MinIO locally; photos,
                                                                        signed URLs, SSE)
```

Monorepo (npm workspaces):

| Path | Purpose |
|---|---|
| `packages/shared` | zod schemas and TypeScript types shared by API and web (library contract, API payloads, roles) |
| `packages/frameworks` | Versioned framework library data (JSON), validator, loader, crosswalk queries |
| `apps/api` | Fastify API, SQL migrations, RLS policies, seed loader |
| `apps/web` | PWA |
| `docs/` | Decisions, user stories, risk method, security docs |

Key design points:
- **Tenant isolation** is enforced in the database. Each request runs in a transaction that sets `app.tenant_id`; RLS policies on every tenant table compare against it. The API connects as `sentinel_app`, which is neither the table owner nor a superuser, so policies cannot be bypassed by a coding mistake.
- **Shared control library**: shared controls own the questions; frameworks own requirements and citations; the crosswalk joins them. Answering one question produces evidence for every mapped framework requirement.
- **Human in the loop**: every AI output is stored as a suggestion with status `suggested`; only an explicit human accept makes it a finding.
- **Offline**: client-generated UUIDs, an append-only operation queue, idempotent sync endpoints, last-writer-wins per field with server-side conflict log (details in Phase 2).

## 3. Data model

Reference data (global, read-only to tenants, versioned):

| Table | Key columns |
|---|---|
| `framework` | id, name, short_name, kind, category |
| `framework_version` | framework_id, version, source_edition, sources (jsonb), published_at |
| `requirement` | framework_id, version, code, parent_code, level, title, text, citation (jsonb), status |
| `shared_control` | id, library_version, domain, title, objective, asset_types, default_severity, evidence, references, status |
| `question` | id, shared_control_id, text, answer_type, options/scale (jsonb), guidance |
| `crosswalk` | shared_control_id, framework_id, version, requirement_code, relationship, rationale |

Tenant data (every table has `tenant_id` and an RLS policy):

| Table | Phase | Notes |
|---|---|---|
| `tenant` | 1 | Workspace (integrator or in-house team); branding added in Phase 4 |
| `app_user`, `membership` | 1 | User may belong to several tenants; role per membership |
| `client`, `site`, `area` | 1 | Client hierarchy inside a tenant |
| `assessment`, `assessment_framework` | 1 | Pinned framework versions per assessment |
| `audit_log` | 1 | Append-only; app role has INSERT and SELECT only |
| `asset`, `answer`, `finding`, `finding_control` | 2 | Finding maps to many shared controls, hence many frameworks |
| `photo`, `photo_tag`, `ai_suggestion` | 2 | Object key only; bytes in S3; suggestion status: suggested, accepted, edited, rejected |
| `sync_operation` | 2 | Idempotency keys and conflict log |
| `threat_scenario`, `risk_score` | 3 | Scores stored with their explanation |
| `export_job` | 3 | Google Docs/Sheets/Drive jobs and links |
| `quote`, `quote_line`, `price_book_item` | 4 | Findings-to-quote |

## 4. Phases

### Phase 1: Foundation (complete)
Scope: repo scaffold, Docker Compose, authentication, multi-tenant schema with RLS, shared control library with all five frameworks seeded, framework picker.
Stories: US-1.01 to US-1.14 (see user stories; Google sign-in US-1.01 is built behind configuration and needs real OAuth credentials to demo).

| Agent | Tasks |
|---|---|
| Head of Engineering | Monorepo scaffold, shared contracts, Docker Compose, `.env.example`, PLAN.md, decisions |
| security-frameworks-architect | Shared controls for all physical and cyber domains with objective questions; framework files for NIST CSF 2.0, PQC readiness, CPTED, CARVER, general physical; crosswalk; validator and tests; flag unverified citations |
| backend-integrations-engineer | Migrations, RLS, roles, password and Google OIDC auth, tenant/client/site/assessment CRUD, framework library endpoints, seed loader, audit log, RLS tests |
| frontend-engineer | PWA shell, login, clients and sites, new assessment wizard with framework picker, library browser with cross-framework mappings, field-ready design system |
| channel-product-manager | User stories (done); UX review of Phase 1 screens |
| qa-security-reviewer | Threat model, ASVS checklist, tenant isolation and auth review, verdict |

### Phase 2: Field capture (complete)
Scope: guided walkthrough by area and control, photo capture and tagging, Claude vision suggestions with accept, edit, reject, offline mode and background sync. Also areas within sites and assessor assignment (moved in from Phase 1 field review), and Phase 1 QA items R-5, R-6, R-9, R-10. Contract: [docs/api-phase2.md](docs/api-phase2.md).
- frontend: walkthrough screens, camera capture, tagging sheet, IndexedDB store, sync queue, conflict UI
- vision-ai: prompt templates, structured output schema, injection defenses, fixtures, draft findings
- backend: photo upload with signed URLs and content validation, EXIF handling, sync endpoints, answers and findings API
- frameworks: question ordering for walkthroughs, asset type to control hints for the vision model
- qa: upload safety, prompt injection tests, offline E2E on mobile viewports

### Phase 3: Scoring and reports (complete)
Contract: [docs/api-phase3.md](docs/api-phase3.md). Also: completed-assessment lock with admin reopen, offline PIN (CW decisions, D-057).
Scope: risk engine, dashboards, Google Docs, Sheets, and Drive export with photos.
- risk-scoring: scenario library, scales, engine, explanations, `docs/risk-method.md`
- backend: Google OAuth (drive.file scope), export jobs, report template engine
- frontend: dashboards, explanation views, site comparison
- vision-ai: narrative drafting for reports (human review before export)

### Phase 4: Channel (in progress)
Contract: [docs/api-phase4.md](docs/api-phase4.md).
Scope: integrator workspaces and branding, clients within, findings-to-quote, portfolio comparison.
- channel-pm: price book and quote design, branding rules
- backend: branding, price book, quotes, client viewer role
- frontend: branding settings, quote builder, portfolio view
- risk-scoring: portfolio normalization

## 5. Risks and open items
- Framework content accuracy: NIST publications are public domain, but CPTED (ISO 22341), ASIS, and some physical standards are paywalled, so we paraphrase and mark citations unverified until a human checks them.
- The build container cannot reach nist.gov or run Docker, so NIST text is entered from the published documents' known structure and flagged for verification, and Docker Compose is validated by config review only until run on a workstation.
- Open product questions for CW are listed at the end of docs/user-stories.md.
