# Phase 2 API contract: field capture

Extends [api-phase1.md](api-phase1.md); same auth, error envelope, and `Cache-Control: no-store`. Schemas are in `packages/shared/src/field.ts`. Field record IDs are UUIDs generated on the device.

## Areas and assignment

| Method and path | Min role | Body / query | Response |
|---|---|---|---|
| GET /sites/:id/areas | viewer | | `Area[]` ordered by sortOrder |
| POST /sites/:id/areas | assessor | `CreateArea` | `Area`, 201 |
| PATCH /areas/:id | assessor | partial `CreateArea` | `Area` |
| DELETE /areas/:id | admin | | 204 (409 `area_in_use` if answers, findings, or photos reference it) |
| GET /members | admin | | `[{userId,email,name,role}]` of the current tenant |
| PUT /assessments/:id/assessors | admin | `AssignAssessors` | `{userIds}` |
| PATCH /assessments/:id | assessor | `{status?, title?}` | assessment (status transitions: draft to in_progress to in_review to complete) |

Assessors may write field data only on assessments they are assigned to; admins and owners on any. Viewers read only.

## Walkthrough

`GET /assessments/:id/walkthrough` (viewer) returns the guided walkthrough for this assessment's pinned frameworks:

```
{ assessmentId, libraryVersion,
  sections: [{ id, title, description, order, domains: ["PER", ...],
               controls: [{ id, title, objective, defaultSeverity, assetTypes,
                            frameworks: [{frameworkId, shortName, requirementCode, relationship}],
                            questions: [Question] }] }],
  areas: Area[], answers: Answer[], findings: Finding[], photos: Photo[], assets: Asset[],
  assessors: [{userId, name}] }
```
Controls are deduplicated across frameworks; a control appears once in the first section that claims its domain. Section definitions come from `packages/frameworks/data/walkthrough.json`.

## Field records (online path)

The device may also write these through sync; both paths share validation and the same version counter.

| Method and path | Min role | Body | Response |
|---|---|---|---|
| PUT /assessments/:id/answers/:answerId | assessor | `Answer` | `Answer & {version}` (upsert) |
| PUT /assessments/:id/assets/:assetId | assessor | `Asset` | `Asset & {version}` |
| PUT /assessments/:id/findings/:findingId | assessor | `Finding` | `Finding & {version}` |
| DELETE /assessments/:id/findings/:findingId | assessor | | 204 |
| GET /assessments/:id/findings | viewer | | `(Finding & {version, frameworks:[{frameworkId, requirementCode, relationship}]})[]` |

## Photos

1. `POST /assessments/:id/photos` (assessor) body `PhotoMeta`: creates the record with status `pending_upload`, returns `Photo`, 201. Idempotent on id.
2. `PUT /photos/:id/content` (assessor) raw body (`Content-Type` one of `PhotoContentType`, max 15 MB): the API checks magic bytes (not the extension or header alone), rejects anything that is not a decodable image, re-encodes to JPEG with all metadata removed (EXIF, XMP, IPTC, ICC except sRGB), caps the long edge at 4096 px, computes sha256, stores the object under `tenants/<tenantId>/photos/<photoId>.jpg`, and sets status `stored`. Returns `Photo`.
3. `GET /photos/:id/url?variant=full|thumb` (viewer): `SignedUrl`, valid `SIGNED_URL_TTL_SECONDS` (default 300). S3 driver: presigned GET. Local driver: `GET /files/<token>` where the token is an HMAC-signed, expiring, single-object grant.
4. `PATCH /photos/:id` (assessor) partial tags (areaId, assetId, findingId, controlIds, assetType, severity, notes). `DELETE /photos/:id` (assessor): removes the object and record.

GPS is stored only when the tenant setting `allowGps` is true; otherwise the API drops it (and says so in the response header `X-Sentinel-Gps: dropped`). Original files are never stored.

## AI suggestions

| Method and path | Min role | Body | Response |
|---|---|---|---|
| POST /photos/:id/analyze | assessor | `{}` | `AiSuggestion` (201, status `suggested` or `failed`). 409 `ai_disabled` when tenant setting `aiPhotoAnalysis` is false; 503 `ai_not_configured` without an API key |
| GET /photos/:id/suggestions | viewer | | `AiSuggestion[]` newest first |
| POST /suggestions/:id/review | assessor | `ReviewSuggestion` | `{suggestion, findings: Finding[], photo: Photo}` |

Rules: nothing from the model is written to findings or photo tags except through review accept or edit. Unknown control IDs in model output are dropped before storing. The image sent to the model is the stored, metadata-stripped JPEG; GPS and notes are only included when the tenant allows it (`aiShareContext`). Rate limit: 30 analyses per user per hour.

## Tenant settings

`GET /tenant/settings` (viewer), `PATCH /tenant/settings` (admin): `{ allowGps: boolean (default false), aiPhotoAnalysis: boolean (default true), aiShareContext: boolean (default false) }`.

## Sync

- `POST /sync/push` (assessor) `SyncPushRequest` returns `{results: SyncOpResult[]}` in op order. Each op runs in its own savepoint, so one bad op does not fail the batch.
  - Duplicate `opId` returns the stored result with status `duplicate`.
  - Every synced record carries an integer `version` that increments on each write. If `baseVersion` is null and the record exists, or `baseVersion` is lower than the server version: **conflict**. Policy: field-level last writer wins by `clientUpdatedAt`; the server applies the op if its `clientUpdatedAt` is newer, otherwise keeps the server copy; either way it records the losing copy in `sync_conflict` and returns status `conflict` with the winning `server` record and `version`.
  - Validation failures return `rejected` with an error code; authorization failures (not assigned, wrong tenant) return `rejected` `forbidden`.
- `GET /sync/pull?assessmentId=<id>&since=<cursor>&limit=500` (viewer): changes after the cursor, including deletions (tombstones), ordered by a monotonic change sequence.

## Security additions in Phase 2

- Absolute session lifetime: refresh tokens stop rotating 30 days after the original sign-in (QA R-5).
- Rate limits on all data routes, per user (QA R-9); 403s are audited (QA R-6).
- `EMBED_ORIGINS` allowlist: CORS for embedding hosts and the `frame-ancestors` value documented for the web host (QA R-10).
