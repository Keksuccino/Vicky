# Project Guidelines & Context
- This project is "Vicky", which is a web-based docs system that renders Markdown docs pages.
- The system uses GitHub as persistent storage for docs pages and syncs pages in both directions to/from it.

## Project Snapshot
- Repository: `Vicky` (`origin`: `https://github.com/Keksuccino/Vicky`)
- Primary branch: `main`
- App type: Next.js App Router wiki/docs system with admin panel and integrated markdown editor
- Docs content is stored in a configured GitHub repository (not in this repo)
- Local runtime state is stored under `data/` by default: app settings in `wiki-store.json`, analytics in `wiki-analytics.sqlite`, SSL material in `ssl/`, and persistent cache/state files in their respective subdirectories.

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
- GitHub read/write + cache invalidation:
  - `src/lib/github.ts`
  - `src/lib/docs-snapshot-store.ts`
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
- Tree/page/search corpus are cached in memory with TTL (`src/lib/cache.ts`).
- GitHub docs snapshots, rendered Markdown HTML, and translated docs are also cached persistently on disk.
- TTL is admin-configurable in site settings and applied dynamically.
- Cache is cleared when:
  - settings that affect source change
  - docs are saved
  - explicit clear functions are called
- Search builds corpus by loading all docs through the same API-backed GitHub path and cache stack.

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
- Runtime state under `data/` is ignored, including `wiki-store.json`, `wiki-analytics.sqlite*`, `login-rate-limit.json`, SSL files, rendered Markdown, docs snapshots, and translations.
- `.next/` artifacts are generated and can cause stale type references after route refactors; clean/restart build if needed.

## Deployment Notes
- Use `npm run build` then `npm run start` for the included production server with custom-domain and automatic HTTPS support.
- Use `npm run start:next` only when intentionally running plain Next.js without the included HTTPS/ACME server.
- Persist `data/wiki-store.json`, `data/wiki-analytics.sqlite*`, `data/login-rate-limit.json`, and `data/ssl/` across deployments. Persist the Markdown, docs snapshot, and translation caches when preserving warm caches or generated translations matters.
- Direct Let's Encrypt HTTP-01 usually requires ports 80/443 or a correctly configured reverse proxy; local development uses port 3000 and does not require privileged ports.
