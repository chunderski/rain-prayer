# Phase 1 API contract

Base URL from `VITE_API_URL` (default `http://localhost:3000`). JSON only. Errors: `{"error":{"code":"string","message":"string","details":any?}}` with a matching HTTP status. Auth: `Authorization: Bearer <accessToken>` on everything except `/health`, `/auth/login`, `/auth/refresh`, `/auth/google/*`. Payload schemas live in `packages/shared/src/domain.ts`.

| Method and path | Min role | Body / query | Response |
|---|---|---|---|
| GET /health | none | | `{status:"ok"}` |
| POST /auth/login | none | `LoginRequest` | `{accessToken, session: SessionInfo}`; sets httpOnly `sa_refresh` cookie. 409 `{error:{code:"tenant_required", details:{tenants:[{slug,name}]}}}` when the user belongs to several tenants and none was given |
| POST /auth/refresh | cookie | | `{accessToken, session}` (rotates the refresh token) |
| POST /auth/logout | cookie | | 204, revokes refresh token |
| GET /auth/me | viewer | | `SessionInfo` |
| GET /auth/google/start, /auth/google/callback | none | | 404 `google_not_configured` unless Google env vars are set |
| GET /frameworks | viewer | | `[{id,name,shortName,kind,category,description,publisher,sourceEdition,version,requirementCount,controlCount,needsReviewCount}]` (latest version per framework) |
| GET /frameworks/:id/versions/:version | viewer | | `FrameworkVersion` plus `requirements[].controlIds: string[]` |
| GET /controls | viewer | `?framework=<id>&domain=<code>&q=<text>` | `[{id,domain,title,objective,defaultSeverity,assetTypes,status,questionCount,mappings:[{frameworkId,requirementCode,relationship}]}]` |
| GET /controls/:id | viewer | | `SharedControl` plus `mappings:[{frameworkId,frameworkShortName,requirementCode,requirementTitle,relationship,rationale}]` |
| GET /clients | viewer | | `[{id,name,industry,siteCount,createdAt}]` |
| POST /clients | admin | `CreateClient` | client, 201 |
| GET /clients/:id | viewer | | client plus `sites[]` |
| GET /sites | viewer | `?clientId=` | `[{id,clientId,name,address,siteType}]` |
| POST /sites | admin | `CreateSite` | site, 201 |
| GET /assessments | viewer | | `[{id,title,status,siteId,siteName,clientName,frameworks:[{frameworkId,version,shortName}],createdAt}]` |
| POST /assessments | assessor | `CreateAssessment` | assessment, 201 (pins framework versions) |
| GET /assessments/:id | viewer | | assessment plus `frameworks` and `controlCount`, `questionCount` (deduplicated across frameworks) |
| GET /audit | admin | `?limit=` | `[{id,at,actorEmail,action,entityType,entityId,ip}]` |

Seeded dev data (`npm run db:seed`): tenants `acme-integrators` and `bluefield-security`; users `owner@acme.test`, `assessor@acme.test`, `viewer@acme.test`, `owner@bluefield.test`, all with password `Sentinel-dev-2026!` (dev only, never in production).
