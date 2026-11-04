# @sentinel/web: Sentinel Assess PWA

React 19, TypeScript, Vite 7, Tailwind 4, react-router 7, idb, vite-plugin-pwa. Phase 1 scope: sign in, clients and sites, the new assessment wizard with the multi-framework picker, assessment detail, and the shared control library browser with cross-framework mappings.

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
| `src/offline/db.ts` | IndexedDB stores: `library`, `drafts`, `outbox` (typed `enqueue`; the sync worker is Phase 2) |
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
- Drafts are cleared on sign out. The outbox refuses `/auth` paths.

## Offline

Once frameworks and controls have been loaded, the library browser, control detail, and framework picker work offline. When an exact query was never cached, the full cached control list is filtered locally. Creating records still needs a connection in Phase 1; the outbox store and `enqueue()` are ready for the Phase 2 sync worker.

## Embedding

Two options, both shown in `embed-demo.html` (served at `/embed-demo.html`):

1. **iframe**: `<iframe src="https://app.example/" title="Sentinel Assess" allow="camera; geolocation">`. The app makes no `X-Frame-Options` or `window.top` assumptions. Which origins may frame the app (`Content-Security-Policy: frame-ancestors`) is a server-side allowlist decision for Phase 2. Note that the refresh cookie is `SameSite=Strict`, so inside a cross-site iframe the user must sign in each session until the API team decides on cookie policy for embeds.
2. **Web component**: load `https://app.example/sentinel-assess.js` as a module, then `<sentinel-assess initial-path="/library"></sentinel-assess>`. It renders into an open shadow root (styles isolated in both directions), uses an in-memory router (the host URL is never changed), and does not register a service worker. Browsers ignore `@property` rules inside shadow roots, so those rules are copied to `document.head`; they only register custom property types. The API must allow the host origin through CORS with credentials.
