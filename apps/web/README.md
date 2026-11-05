# @sentinel/web: Sentinel Assess PWA

React 19, TypeScript, Vite 7, Tailwind 4, react-router 7, idb, exifr, vite-plugin-pwa. Phase 1: sign in, clients and sites, the new assessment wizard with the multi-framework picker, assessment detail, and the shared control library browser. Phase 2: offline-first field capture (guided walkthrough, photos and tagging, findings, AI suggestion review, sync), built against `docs/api-phase2.md`.

## Run

```sh
npm run dev -w @sentinel/web          # http://localhost:5173, API at VITE_API_URL (default http://localhost:3000)
npm run build -w @sentinel/web        # typecheck plus production build into apps/web/dist
npm test -w @sentinel/web             # Vitest (jsdom, fake-indexeddb)
cd apps/web && npx playwright test    # E2E on Desktop Chrome, Pixel 7, iPhone 14 (Chromium emulation)
node apps/web/scripts/make-icons.mjs  # regenerate PNG icons from the SVG geometry
```

Docker (dev server): `docker build -f apps/web/Dockerfile -t sentinel-web .` from the repository root.

## Layout

| Path | Purpose |
|---|---|
| `src/api/client.ts` | Typed fetch client: in-memory access token, one refresh on 401, `tenant_required` handling |
| `src/api/schemas.ts` | zod schemas for API responses; request payloads come from `@sentinel/shared` |
| `src/api/library.ts` | `/frameworks` and `/controls` reads with IndexedDB fallback when offline |
| `src/offline/db.ts` | IndexedDB, version 2: `library`, `drafts`, `outbox` (Phase 1) plus `walkthroughs`, `areas`, `assets`, `answers`, `findings`, `photos`, `photoBlobs`, `suggestions`, `syncOps`, `conflicts`, `meta` |
| `src/field/repo.ts` | Local-first writes: validate, store, queue a SyncOp (client UUID, baseVersion, clientUpdatedAt) bound to user and tenant |
| `src/field/walkthrough.ts`, `FieldContext.tsx` | Walkthrough, assessment, and tenant settings: network first, cached for offline; records served from IndexedDB |
| `src/sync/engine.ts` | Sync engine: push in batches, applied, duplicate, conflict, rejected handling, photo bytes after their metadata op, pull with cursor, backoff with jitter |
| `src/sync/SyncContext.tsx` | Triggers (start, `online`, visible, 30 s timer, after writes, Background Sync relay) and the status text |
| `src/auth/profile.ts` | Cached, non-secret session profile for offline start (D-039) |
| `src/photos/` | Capture (`<input capture>`), downscale and EXIF time, signed URL or local blob previews |
| `src/screens/Walkthrough.tsx`, `Photos.tsx`, `Findings.tsx`, `Admin.tsx`, `SyncReview.tsx` | Phase 2 screens |
| `public/sw-sync.js` | Imported into the generated service worker; relays Background Sync to open windows |
| `src/components/ui.tsx` | Design system: Button, Field, TextArea, SelectField, Card, Chip, Toggle, PageHeader, EmptyState, Banner |
| `src/components/FrameworkPicker.tsx` | Framework toggle cards, presets, live shared and overlap counts |
| `src/components/coverage.ts` | Pure deduplication math used by the picker and the review step |
| `src/screens/` | Sign in, assessments, clients, new assessment wizard, library, control detail |
| `src/embed.tsx` | `<sentinel-assess>` custom element |
| `e2e/` | Playwright specs with the API mocked through `page.route()` (`e2e/mock-api.ts`) |

## Field-ready design rules

Light theme by default for sunlight; dark theme follows `prefers-color-scheme`. Primary text is at least 7:1 against its surface in both themes. Tap targets are at least 48px, primary actions 56px; body text 18px; a 3px focus ring on every focusable element; no hover-only affordances; status always has a text label, never color alone; `prefers-reduced-motion` is respected. Wizard actions sit in a sticky bar at the bottom of the screen for one-handed use.

## Security notes

- The access token is held in memory only. The refresh token is an httpOnly cookie set by the API; the client sends it only to `/auth/*` with `credentials: "include"`.
- The service worker precaches the app shell only. It has no runtime caching, so no API response (and nothing carrying a token) is stored by it. Library reference data is cached in IndexedDB by the app.
- Sign out clears drafts, both outboxes, cached field records, photos, and the cached profile (after a warning when anything is unsent). The library reference cache is kept. A different user signing in on the same device also clears field data.
- Sync ops carry the user and tenant that made them; only the signed-in user's ops are pushed (QA R-11).
- AI output is rendered as React text only, labelled "AI suggestion, not final", and applied only through an explicit review.

## Offline and sync

- Open an assessment once while online and its walkthrough, records, and tenant settings are cached. After that, the walkthrough, photo capture, tagging, and findings work with no signal, including after a reload (the cached profile signs the user in locally; see D-039).
- Every field write goes to IndexedDB first, then to the `syncOps` outbox. The engine pushes to `POST /sync/push` in batches of up to 50 (one op per record per batch, `baseVersion` read at send time), uploads photo bytes with `PUT /photos/:id/content` only after the photo's metadata op is applied (falling back to `POST /assessments/:id/photos` on 404), then pulls `GET /sync/pull` per cached assessment.
- Retries: exponential backoff from 2 s, doubling to a 5 minute cap, with the delay drawn from [d/2, d]. Rejected ops are kept for review and never retried. Conflicts show the server's winning copy and keep both copies on the Sync screen.
- Runs on app start, on `online`, when the page becomes visible, every 30 s while visible and online, shortly after local writes, and when Background Sync fires (the worker only wakes open pages, because tokens never leave page memory).
- The app asks for persistent storage (`navigator.storage.persist()`) with an explanation on the walkthrough screen, and warns before capture when free quota drops below 100 MB.
- Photos are downscaled to a 4096 px long edge and re-encoded as JPEG on the device, which drops all EXIF (including any camera GPS). Location is added only when the workspace allows GPS and the assessor taps "Include location" for that photo.

## Content Security Policy (QA R-10)

Production builds put a CSP meta tag in `index.html` (`vite.config.ts`, `buildCsp`):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: <photo origins>;
connect-src 'self' <API origin>; font-src 'self'; worker-src 'self'; manifest-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'
```

`<API origin>` comes from `VITE_API_URL` at build time. `<photo origins>` comes from `VITE_PHOTO_URL_ORIGINS` (space or comma separated, for example the S3 endpoint that signs photo URLs) and defaults to the API origin (local storage driver). No inline scripts or styles are allowed; React style props are applied through the CSSOM, which CSP permits. `e2e/security.spec.ts` checks the policy and that no violation is logged.

`frame-ancestors` is ignored in a meta tag, so the host that serves the app must send it as a response header on the HTML. Use the same origins as the API's `EMBED_ORIGINS` allowlist:

```
Content-Security-Policy: frame-ancestors 'self' https://portal.integrator.example
```

For example in nginx: `add_header Content-Security-Policy "frame-ancestors 'self' https://portal.integrator.example" always;` on the `location /` that serves `index.html`. Without an embed allowlist, send `frame-ancestors 'self'`. Do not send `X-Frame-Options`; it cannot express an allowlist and would block approved embeds. The web component (`sentinel-assess.js`) runs under the host page's own CSP, which must allow the app origin in `script-src` and the API in `connect-src`.

## Embedding

Two options, both shown in `embed-demo.html` (served at `/embed-demo.html`):

1. **iframe**: `<iframe src="https://app.example/" title="Sentinel Assess" allow="camera; geolocation">`. The app makes no `X-Frame-Options` or `window.top` assumptions. Which origins may frame the app (`Content-Security-Policy: frame-ancestors`) is a server-side allowlist decision for Phase 2. Note that the refresh cookie is `SameSite=Strict`, so inside a cross-site iframe the user must sign in each session until the API team decides on cookie policy for embeds.
2. **Web component**: load `https://app.example/sentinel-assess.js` as a module, then `<sentinel-assess initial-path="/library"></sentinel-assess>`. It renders into an open shadow root (styles isolated in both directions), uses an in-memory router (the host URL is never changed), and does not register a service worker. Browsers ignore `@property` rules inside shadow roots, so those rules are copied to `document.head`; they only register custom property types. The API must allow the host origin through CORS with credentials.
