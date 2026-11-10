# Project Guidelines & Context
- This project is "Vicky", which is a web-based docs system that renders Markdown docs pages.
- The system uses GitHub as persistent storage for docs pages and syncs pages in both directions to/from it.

## Project Snapshot
- Repository: `Vicky` (`origin`: `https://github.com/Keksuccino/Vicky`)
- Primary branch: `main`
- App type: Next.js App Router wiki/docs system with admin panel and integrated markdown editor
- Docs content is stored in a configured GitHub repository (not in this repo)
- Local runtime state is stored under `data/` by default: app settings in `wiki-store.json`, analytics in `wiki-analytics.sqlite`, SSL material in `ssl/`, the local copy of the docs repository in `docs-cache/`, and other persistent cache/state files in their respective subdirectories.

## Core Product Behavior
- `/` redirects to the configured start page (default `/docs/home`).
- Docs pages render markdown with GitHub-flavored features, custom alert boxes, heading anchors, and syntax highlighting.
- Admin can configure:
  - GitHub source repository/path/token
  - Site title/description/footer/start page
  - Docs icon URLs (16/32/180)
  - Docs cache TTL
  - Light/Dark accents and custom CSS
  - Custom domain and automatic Let's Encrypt HTTPS
  - AI chat, OpenRouter, and automatic translation
- Admin can also manage moderators, caches, translations, performance data, and visitor analytics.
- Editor saves directly to the configured remote GitHub repo via API (commit is created immediately on save).

## Tech Stack
- Next.js 16 (App Router), React 19, TypeScript
- Markdown pipeline:
  - `react-markdown`
  - `remark-gfm`, `remark-breaks`
  - custom `remarkGitHubAlerts` plugin
  - `rehype-highlight`, `rehype-slug`, `rehype-autolink-headings`, `rehype-sanitize`
- GitHub API: `@octokit/rest`
- Validation: `zod`
- Persistent analytics: `better-sqlite3`
- Production HTTP/HTTPS and certificate handling: custom `server.mjs` + `acme-client`

## High-Value File Map
- App shell/layout:
  - `src/app/layout.tsx`
  - `src/components/app-header.tsx`
- Docs UI and navigation/search/hash scrolling:
  - `src/components/docs-client.tsx`
  - `src/components/docs-tree.tsx`
- Markdown rendering:
  - `src/components/markdown-renderer.tsx`
  - `src/lib/markdown.ts`
  - `src/lib/remark-github-alerts.ts`
- Editor:
  - `src/components/editor-workbench.tsx`
- Settings/store:
  - `src/lib/store.ts`
  - `src/lib/defaults.ts`
  - `src/lib/encryption.ts`
- GitHub layer (see "Caching + GitHub Data Flow"):
  - `src/lib/github.ts`: public API for routes: config resolution, public/editor page reads, refresh, plaintext export, editor saves
  - `src/lib/github-docs-source.ts`: the source docs view (index + pages), stale-while-revalidate refresh, atomic publication, applying committed pages
  - `src/lib/github-client.ts`: the one shared Octokit client (concurrency cap, timeouts, retries, rate limits)
  - `src/lib/github-repo-index.ts`: recursive tree index of every Markdown file with its blob SHA, persistence, lookup helpers
  - `src/lib/github-content-store.ts`: content-addressed blob store (parsed once), downloads, unreferenced-blob sweep, reads by path
  - `src/lib/github-commit-metadata.ts`: "last updated" data per file version (batched GraphQL), persisted
  - `src/lib/github-docs-cache-files.ts`: on-disk layout of the docs cache directory
  - `src/lib/github-derived-caches.ts`: pruning of rendered, translated, search, and plaintext caches for changed pages
  - `src/lib/github-localization.ts`: localization readers (translated pages, sidebar titles, search pages, job status, cache-card variants) and lazy per-language loads
  - `src/lib/github-localization-saves.ts`: localized saves (single file and batched Git data API commits)
  - `src/lib/github-paths.ts`: repository path rules
  - `src/lib/github-cache-identity.ts`, `src/lib/github-cache-invalidation.ts`: source/authorization isolation, cache generations, invalidation
- Search corpus/ranking:
  - `src/lib/docs-search.ts`
- Cache implementations:
  - `src/lib/cache.ts`
  - `src/lib/markdown-render-cache-store.ts`
  - `src/lib/translation-cache-store.ts`
- Auth + rate limiting:
  - `src/lib/auth.ts`
  - `src/lib/login-rate-limit.ts`
- AI and translation:
  - `src/lib/ai-chat.ts`
  - `src/lib/auto-translate-server.ts`
  - `src/lib/openrouter.ts`
- Analytics:
  - `src/lib/visitor-storage.ts`
  - `src/lib/visitors.ts`
- Domain/HTTPS runtime:
  - `server.mjs`
  - `src/lib/domain-settings.ts`
- API routes:
  - `src/app/api/**/route.ts`
- Middleware guards:
  - `middleware.ts`

## API Surface (Current)
- Public:
  - `GET /api/public/settings`
  - `GET /api/public/icon/16`
  - `GET /api/public/icon/32`
  - `GET /api/public/icon/180`
- Docs read/search:
  - `GET /api/docs/tree`
  - `GET /api/docs/page`
  - `GET /api/docs/page-metadata`
  - `GET /api/docs/raw`
  - `GET /api/docs/raw/[...slug]`
  - `GET /api/docs/search`
  - `POST /api/docs/visit`
  - `GET /docs.txt`
- AI:
  - `POST /api/ai/chat`
- Auth:
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
- Admin-protected:
  - `GET|PATCH /api/admin/settings`
  - `POST /api/admin/test-connection`
  - `GET|POST /api/admin/docs`
  - `POST /api/admin/docs/refresh`
  - `GET /api/admin/domain-status`
  - `GET|POST|DELETE /api/admin/markdown-cache`
  - `GET|POST /api/admin/moderators`
  - `PATCH|DELETE /api/admin/moderators/[id]`
  - `GET /api/admin/performance`
  - `POST /api/admin/translations/request`
  - `POST /api/admin/translations/status`
  - `POST /api/admin/translations/source-versions`
  - `GET /api/admin/visitors`

## Local Development
1. `npm ci`
2. `cp .env.example .env.local`
3. Set these values (required everywhere except automated tests):
  - `AUTH_JWT_SECRET`
  - `ADMIN_PASSWORD`
  - `ENCRYPTION_SECRET`
4. `npm run dev`

Never reuse `node_modules` after moving the workspace between operating systems or CPU architectures. Reinstall from the lockfile so packages such as `better-sqlite3` and Next's SWC compiler use native macOS/Apple Silicon binaries.

`package.json` pins reviewed dependency install scripts in `allowScripts`. Review new install scripts individually and add exact package-version approvals; do not blanket-approve pending scripts.

Useful URLs:
- Docs: `http://localhost:3000/docs/<slug>`
- Admin login: `http://localhost:3000/admin/login`
- Editor: `http://localhost:3000/editor`

## Auth/Security Rules
- Admin session cookie: `vicky_admin_session`.
- Protected server paths are guarded both by middleware and route checks.
- Admin/editor pages perform server-side auth checks to avoid unauthorized content flash.
- Login endpoint includes IP-based rate limiting, temporary block windows, durable JSON persistence, and an in-memory fallback when persistence is unavailable.
- `AUTH_JWT_SECRET`, `ADMIN_PASSWORD`, and `ENCRYPTION_SECRET` have test-only fallbacks; local development and production must configure real values.
- Any new write/admin endpoint must require admin auth (`requireAdminRequest` or equivalent).

## Caching + GitHub Data Flow
- Every GitHub call goes through `getGitHubClient` (`src/lib/github-client.ts`): never construct `Octokit` elsewhere. The client enforces one process-wide concurrency cap, a per-attempt timeout covering the whole body, bounded retries with backoff (GET/HEAD and requests marked `request: { idempotent: true }`; rate-limited requests always), honours `retry-after`/`x-ratelimit-reset`, and fails fast with a 503 `ApiError` (with `Retry-After`) while the quota is exhausted. Mark background bulk work with `request: { priority: "bulk" }` so interactive requests go first and the work is paced within GitHub's secondary rate limits (`PACING`: 600 REST points per minute after a 100-point burst, writes cost 5 points and go one second apart after a burst of 5, at most 400 bulk writes per hour); interactive requests are never delayed but count against the same budgets. Tests that make many bulk requests use a fresh token per test, because budgets are kept per credential.
- Repository index (`github-repo-index.ts`): one recursive tree request lists every Markdown file of the branch (source docs and localizations) with its blob SHA. Requests are conditional on the stored ETag; an unchanged tree SHA means the refresh is that single request. A truncated tree is listed level by level, never published incomplete.
- Content store (`github-content-store.ts`): blobs are content-addressed by Git blob SHA, downloaded through the Git blobs API (works above 1 MB), verified against their SHA, and parsed once (title, description, headings, plaintext flag, recorded `sourceBlobSha`, `contentHash` of the body, which is the rendered-HTML cache key). Small per-blob summaries (title, content hash, recorded source version) stay in memory for every blob read or stored, so lists and translation status never need page bodies; `storedOnly` reads never contact GitHub. A blob is only served through an index that lists it, which keeps cross-source sharing safe. Bump `MARKDOWN_PARSE_VERSION` whenever `parseMarkdownDocument` changes its output.
- Commit metadata (`github-commit-metadata.ts`): looked up once per path + blob SHA in batched GraphQL queries and persisted; failures are retried after a pause, not per request.
- Source docs view (`github-docs-source.ts`): index + pages, held in `docsSourceCache` without expiry. After the admin-configurable TTL, readers keep the current view while one coalesced background refresh runs (stale-while-revalidate). An explicit refresh (`bypassCache`, admin "Refresh docs") waits for a refresh that starts after the call. A new view is published atomically after its blobs and index are stored; derived caches are pruned only for pages that changed.
- Editor saves apply the commit response to the index, store, commit metadata, and view directly; the saved page is served without refetching. The index's tree SHA and ETag are dropped so the next refresh compares the full listing.
- Public reads are index-authorized: an unknown locator or language is answered from the view and never becomes a GitHub request. Editor reads fall back to reading an unindexed page directly.
- Public admission: each public request takes exactly one permit at its boundary (route handler or the docs route render) via `withPublicDocsAdmission`; the loaders in `docs-server-data.ts` take none. `generateMetadata`, the docs layout, and the docs page share one `loadDocsRouteData` call per request.
- Localizations (`github-localization.ts`): translations at `<localizationPath>/<language>/<source path>` are read from the same index, the content store, and the commit metadata store; no reader makes its own tree request, and only translations of pages in the view are served. A translated page view costs nothing once its blob is stored, otherwise one interactive blob download. Sidebar titles come from blob summaries, search from stored blobs; what a language lacks is downloaded lazily by one background load per language (bulk priority, 4 at a time) the first time its sidebar or search needs it, while the answer uses what is stored (`titlesPending`; `waitForTitles=1` waits at most 5 s; incomplete search corpora are not cached). The job's status scan (`loadGitHubLocalizationStatuses`) needs only the index, blob summaries, and commit metadata; the admin Markdown-cache status uses summaries and stored metadata only and makes no GitHub request. "Outdated" is decided in one place, `localizationState`: a translation recording `sourceBlobSha` is current exactly when it equals the source page's blob SHA; one without it falls back to commit dates (source committed after the translation), and is `undetermined` when a date is unknown (served as current). Commit metadata is only looked up for translations that need the date rule. Localized saves apply the commit response to index, store, metadata, and view through `applyCommittedGitHubFiles`, like editor saves.
- Translation job (`page-localization.ts`, `page-localization-jobs.ts`): starting one costs one index refresh (a single tree request on a warm index); status comes from `loadGitHubLocalizationStatuses`. Up to 16 OpenRouter requests run in parallel (fewer under memory pressure). `classifyTranslationFailure` decides retries: transient failures retry up to 6 attempts with exponential backoff and jitter, `retry-after` pauses every worker, page-level 4xx fail only that page, and 401/404/402-without-`retry-after` (or a closed upload queue) stop starting further translations. The memory wait is bounded (2 minutes), a batch upload is bounded (10 minutes, `GITHUB_LOCALIZATION_UPLOAD_TIMEOUT_MS`), and a watchdog fails a job that reports no progress for 15 minutes past its next expected activity, so a job always reaches a final state and never blocks later jobs.
- Recording source versions (`recordGitHubLocalizationSourceVersions`, admin action "Record Source Versions", `POST /api/admin/translations/source-versions` with the confirmed `expectedFiles`): writes `sourceBlobSha` into every translation that lacks it and is current by commit dates; outdated, undetermined, and unreadable ones are never touched. It refreshes the index until it matches the branch head, commits everything in one commit (one tree request per 100 files, content inline, non-forced ref update), applies the files to index, store, and metadata, and prunes no rendered HTML (bodies are unchanged). It runs as a job of the shared job/log (`mode: "source-versions"`); both job kinds share one slot, so they never overlap. The UI offers it only while the latest job reports `unrecordedPages`.
- Front matter (`markdown.ts`): the app manages `title`, `description`, `excludeFromAiPlaintext`, and `sourceBlobSha`. Saves edit those keys line by line in the existing YAML (`serializeMarkdownDocument(fields, base)`), so other keys, comments, and formatting survive every read–modify–write; pass the replaced file (or the Markdown sent) as `base`. `withSourceBlobSha` changes only the front matter and keeps every body byte, so rendered HTML stays valid.
- Persistent layout under `WIKI_DOCS_CACHE_DIR` (`data/docs-cache/`): `sources/<sha256 of the runtime cache key>/repo-index.json` and `commit-metadata.json`, plus `blobs/<2 hex>/<sha>.json`. Whole-docs snapshot files of the earlier format are removed on first use. Rendered Markdown and translations are cached in their own directories.
- Source isolation: cache keys include the credential fingerprint and the security epoch (`github-cache-identity.ts`). Changing the source repo/branch/path/token revokes the old key, deletes its source directory and the blobs no remaining index references; in-flight work of an older cache generation can never publish (`github-cache-invalidation.ts`).
- Search builds its corpus from the source view, and per language from the stored translations.
- Tests use the fake GitHub API in `src/lib/__tests__/fixtures/fake-github-api.ts` (`vi.stubGlobal("fetch", fake.fetch)`), which exercises the real client, and must point `WIKI_DOCS_CACHE_DIR` (and the other cache directories) at a temporary directory. `TESTING_GUIDELINES.md` describes running the production server against the same fake (`scripts/fake-github-preload.mjs`) and checking UI offscreen (`scripts/offscreen-browser.mjs`).

## Markdown + UI Expectations
- Markdown should remain GitHub-friendly (GFM behavior expected by users).
- Single-segment root-relative links like `[/home]` are normalized to `/docs/home`.
- Alert blockquotes (`[!INFO]`, `[!WARNING]`, etc.) must not mutate user text formatting.
- Hash anchor navigation is expected to work reliably on initial load and in-page navigation.

## Icon/Favicon Notes
- Icon URLs come from admin settings.
- Public icon endpoints redirect to configured URLs:
  - `/api/public/icon/16`
  - `/api/public/icon/32`
  - `/api/public/icon/180`
- Important Next.js rule: route segment config must be static literals in each `route.ts`.
- Do not re-export `dynamic`/`runtime` from helper modules.

## Validation Checklist Before Commit
- Run checks only when they are actually useful for the change.
- Skip lint/tests for small simple changes that do not materially affect system behavior, such as adjusting a color, spacing, or size value, or updating docs/instructions like `AGENTS.md`.
- Use `npm run lint` for larger code changes, behavior changes, refactors, or when the touched area has a meaningful risk of regressions.
- Optional as needed: manual checks for touched flows
- `npm run typecheck` is useful but can fail from existing unrelated issues (for example stale `.next` type artifacts or existing test typing issues). If it fails, report clearly instead of silently ignoring.

## Generated/Ignored Files
- `next-env.d.ts` is ignored and generated by Next.js.
- Runtime state under `data/` is ignored, including `wiki-store.json`, `wiki-analytics.sqlite*`, `login-rate-limit.json`, SSL files, rendered Markdown, the docs cache, and translations.
- `.next/` artifacts are generated and can cause stale type references after route refactors; clean/restart build if needed.

## Deployment Notes
- Use `npm run build` then `npm run start` for the included production server with custom-domain and automatic HTTPS support.
- Use `npm run start:next` only when intentionally running plain Next.js without the included HTTPS/ACME server.
- Persist `data/wiki-store.json`, `data/wiki-analytics.sqlite*`, `data/login-rate-limit.json`, and `data/ssl/` across deployments. Persist the Markdown cache, the docs cache (`data/docs-cache/`), and the translation cache when preserving warm caches or generated translations matters; without the docs cache, the first start downloads every page again.
- Direct Let's Encrypt HTTP-01 usually requires ports 80/443 or a correctly configured reverse proxy; local development uses port 3000 and does not require privileged ports.
