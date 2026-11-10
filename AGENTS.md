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
  - `src/components/docs-shell.tsx`
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
  - `src/lib/github-derived-caches.ts`: pruning of rendered, search, and plaintext caches for changed pages
  - `src/lib/github-localization.ts`: localization readers (translated pages, sidebar titles, search pages, job status, cache-card variants) and lazy per-language loads
  - `src/lib/github-localization-saves.ts`: localized saves (batched Git data API commits)
  - `src/lib/github-paths.ts`: repository path rules
  - `src/lib/github-cache-identity.ts`, `src/lib/github-cache-invalidation.ts`: source/authorization isolation, cache generations, invalidation
- Search corpus/ranking:
  - `src/lib/docs-search.ts`
- Cache implementations:
  - `src/lib/cache.ts`
  - `src/lib/markdown-render-cache-store.ts`: rendered HTML on disk with its index
  - `src/lib/markdown-render-cache-admin.ts`, `src/lib/markdown-render-cache-warm-job.ts`: the admin card's status, clears, and warm job
- Background jobs:
  - `src/lib/background-jobs.ts`: lifecycle shared by the translation and warm jobs
  - `src/lib/page-localization-jobs.ts`
- Auth + rate limiting:
  - `src/lib/auth.ts`
  - `src/lib/login-rate-limit.ts`
- AI and translation:
  - `src/lib/ai-chat.ts`
  - `src/lib/openrouter.ts`
- Analytics (see "Visitor Analytics"):
  - `src/lib/visitors.ts`: visit queue (dedup, capacity, retries, batches) and the admin summary shape
  - `src/lib/visitor-storage.ts`: main-thread client of the analytics worker (requests, watchdog, restart backoff, cached numbers)
  - `src/lib/visitor-analytics-worker.mjs`: worker thread that owns the SQLite database
  - `src/lib/visitor-analytics-store.mjs`: schema, batched writes, folding visits into aggregates, summary queries
  - `src/lib/visitor-analytics-maintenance.mjs`: migration of the earlier schema, retention, compaction
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
  - `GET|DELETE /api/admin/markdown-cache`
  - `GET|POST /api/admin/markdown-cache/warm`
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
- Background jobs (`background-jobs.ts`): the translation jobs and the Markdown-cache warm job share one lifecycle: one running job per slot (a second start returns it), a final state set exactly once, and a watchdog that fails a job reporting no progress past its stall limit. Jobs live in process memory; the admin card polls the latest one (`startJobStatusPolling`, only while it runs and the tab is visible) and picks a running job up again when the panel opens.
- Markdown-cache warm job (`markdown-render-cache-warm-job.ts`, `POST /api/admin/markdown-cache/warm` answers 202 at once, `GET` returns the job): plans from the cache index (no entry opened), loads up to 4 variants at a time (translation blobs the store lacks are downloaded at bulk priority) but renders one at a time, each after a turn of the event loop (`yieldToEventLoop`), so public requests are answered between two renders. It reports processed/missing variants and an estimate of the time left, stops at once with `failed` when the docs source changes (409), and fails after 5 minutes without progress.
- Translation job (`page-localization.ts`, `page-localization-jobs.ts`): starting one costs one index refresh (a single tree request on a warm index); status comes from `loadGitHubLocalizationStatuses`. Up to 16 OpenRouter requests run in parallel (fewer under memory pressure). `classifyTranslationFailure` decides retries: transient failures retry up to 6 attempts with exponential backoff and jitter, `retry-after` pauses every worker, page-level 4xx fail only that page, and 401/404/402-without-`retry-after` (or a closed upload queue) stop starting further translations. The memory wait is bounded (2 minutes), a batch upload is bounded (10 minutes, `GITHUB_LOCALIZATION_UPLOAD_TIMEOUT_MS`), and a watchdog fails a job that reports no progress for 15 minutes past its next expected activity, so a job always reaches a final state and never blocks later jobs.
- Recording source versions (`recordGitHubLocalizationSourceVersions`, admin action "Record Source Versions", `POST /api/admin/translations/source-versions` with the confirmed `expectedFiles`): writes `sourceBlobSha` into every translation that lacks it and is current by commit dates; outdated, undetermined, and unreadable ones are never touched. It refreshes the index until it matches the branch head, commits everything in one commit (one tree request per 100 files, content inline, non-forced ref update), applies the files to index, store, and metadata, and prunes no rendered HTML (bodies are unchanged). It runs as a job of the shared job/log (`mode: "source-versions"`); both job kinds share one slot, so they never overlap. The UI offers it only while the latest job reports `unrecordedPages`.
- Front matter (`markdown.ts`): the app manages `title`, `description`, `excludeFromAiPlaintext`, and `sourceBlobSha`. Saves edit those keys line by line in the existing YAML (`serializeMarkdownDocument(fields, base)`), so other keys, comments, and formatting survive every read–modify–write; pass the replaced file (or the Markdown sent) as `base`. `withSourceBlobSha` changes only the front matter and keeps every body byte, so rendered HTML stays valid.
- Persistent layout under `WIKI_DOCS_CACHE_DIR` (`data/docs-cache/`): `sources/<sha256 of the runtime cache key>/repo-index.json` and `commit-metadata.json`, plus `blobs/<2 hex>/<sha>.json`. Whole-docs snapshot files of the earlier format are removed on first use. Rendered Markdown is cached in its own directory. Startup (`acquireRuntimeOwnerLease`) deletes the files of the translation cache Vicky no longer keeps from `WIKI_TRANSLATION_CACHE_DIR` (`data/translation-cache/` by default) and nothing else; translations live only in the repository and the docs cache.
- Rendered-HTML cache (`markdown-render-cache-store.ts`, `WIKI_MARKDOWN_CACHE_DIR`): one `pages/<sha256 of the key>.json` per page variant plus `index.json` with the key, HTML size, heading count, and save time of every entry. Listing, existence checks, and deletion use only the index; writes and deletes update it in memory and persist it at most every 5 s (`flushRenderedMarkdownCacheIndex` writes at once). The first use per process reconciles it with a listing of `pages/`: entries whose file is gone are dropped, only files the index does not know are read (4 at a time, yielding between files), files that are no valid entry and temp files of other processes are deleted. A missing, stale, or corrupt index therefore rebuilds itself, and a directory without one is indexed on first use. Public reads open only the entry they serve and never wait for the index. Refreshes prune the entries of source pages whose body changed and of translations whose file changed or disappeared (`translationPruneTargets` in `github-derived-caches.ts`; the new version's content hash is kept when its blob is stored, so front-matter-only commits keep their HTML).
- Source isolation: cache keys include the credential fingerprint and the security epoch (`github-cache-identity.ts`). Changing the source repo/branch/path/token revokes the old key, deletes its source directory and the blobs no remaining index references; in-flight work of an older cache generation can never publish (`github-cache-invalidation.ts`).
- Search builds its corpus from the source view, and per language from the stored translations.
- Tests use the fake GitHub API in `src/lib/__tests__/fixtures/fake-github-api.ts` (`vi.stubGlobal("fetch", fake.fetch)`), which exercises the real client, and must point `WIKI_DOCS_CACHE_DIR` (and the other cache directories) at a temporary directory. `TESTING_GUIDELINES.md` describes running the production server against the same fake (`scripts/fake-github-preload.mjs`) and checking UI offscreen (`scripts/offscreen-browser.mjs`).

## Visitor Analytics
- Only the analytics worker thread opens `wiki-analytics.sqlite`; no request handler runs SQLite. `visitor-storage.ts` starts the worker from `<cwd>/src/lib/visitor-analytics-worker.mjs` (unbundled, like the `.mjs` modules `server.mjs` loads), so the app must run from the project directory. A worker that fails to open the database, exits, or leaves a request unanswered for 60 s without any message is stopped; pending requests reject, the admin card shows the error, and the next request restarts it with a backoff (5 s doubling up to 5 min). Steps that hold the worker for long (index drops, the drop of the old table, compaction) announce themselves first.
- Writes: the queue in `visitors.ts` hashes the client address with the salt (read once, kept in memory) and sends up to 500 visits per batch; each batch is one transaction. File permissions are verified when the worker opens the database, not per call. Duplicates by visitor and event ID are skipped: `analytics_recent_events` keeps the first 64 bits of the event ID's SHA-256 for today and yesterday (clients repeat an event within seconds), so raw rows carry no event index.
- Numbers never come from scanning raw rows. Each visit is folded into aggregates as it is written (`visitor-analytics-store.mjs` documents every table): visits per day/page and hour/page, unique visitors per day/hour via presence rows, and the last hour each visitor was seen overall and per page. Every window ends now, so a window's unique visitors are an index range count over `last_hour`; every number is exact for every window up to 365 days and independent of arrival order. All-time totals and the daily chart are kept forever; all-time unique visitors count a visitor again only after more than a year without visits (their recency rows are pruned with the raw rows).
- The admin endpoint answers from numbers cached in memory (60 s, 10 s while catching up; `?refresh=1` re-reads once they are 2 s old) and waits at most 2.5 s for new ones, then answers with `refreshing: true`. The response is `{ stats, status: { catchingUp, refreshing, error } }`; the card polls while `catchingUp` or `refreshing` is set and ignores responses older than its latest request.
- Retention, once per UTC day in small steps: raw rows (`analytics_visits`) and visitor recency rows older than 365 days, event IDs older than yesterday, hourly rows and presence rows outside their horizon; `incremental_vacuum` then returns freed pages to the file system.
- Migration of the earlier schema (`visitor_events` with nine indexes) runs in the worker in steps of at most 8,192 rows or about 200 ms (large commits write far less than many small ones, because the visitor tables are updated at random keys; WAL checkpoints run every 8,000 pages meanwhile): drop the indexes no query needs, fold old rows oldest first, copy those inside the retention window into `analytics_visits` with their old row IDs, and store the position of the last folded row in the same transaction, so it resumes anywhere and never counts twice. Old rows are not deleted one by one (the old random-key indexes would make each deletion rewrite pages all over the file); the whole old table is dropped at the end in one announced step (about 0.15 s per million rows with a warm page cache). Visits recorded meanwhile are stored and folded afterwards; the card shows progress until then. A database without incremental auto-vacuum is then compacted once by `VACUUM INTO <db>.compact` and an atomic rename; it needs free space for the live data only and is retried after 6 hours when that is missing.

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
- Runtime state under `data/` is ignored, including `wiki-store.json`, `wiki-analytics.sqlite*` (a `wiki-analytics.sqlite.compact` copy exists only during the one-time compaction and is removed at the next start), `login-rate-limit.json`, SSL files, rendered Markdown, and the docs cache.
- `.next/` artifacts are generated and can cause stale type references after route refactors; clean/restart build if needed.

## Deployment Notes
- Use `npm run build` then `npm run start` for the included production server with custom-domain and automatic HTTPS support.
- Use `npm run start:next` only when intentionally running plain Next.js without the included HTTPS/ACME server.
- Persist `data/wiki-store.json`, `data/wiki-analytics.sqlite*`, `data/login-rate-limit.json`, and `data/ssl/` across deployments. Persist the Markdown cache and the docs cache (`data/docs-cache/`) when preserving warm caches matters; without the docs cache, the first start downloads every page again.
- Direct Let's Encrypt HTTP-01 usually requires ports 80/443 or a correctly configured reverse proxy; local development uses port 3000 and does not require privileged ports.
