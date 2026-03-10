# AGENTS.md

## Project Snapshot
- Repository: `Vicky` (`origin`: `https://github.com/Keksuccino/Vicky`)
- Primary branch: `main`
- App type: Next.js App Router wiki/docs system with admin panel and integrated markdown editor
- Runtime model:
- Docs content is stored in a configured GitHub repository (not in this repo)
- Local app settings/themes are stored in `data/wiki-store.json`

## Core Product Behavior
- `/` redirects to the configured start page (default `/docs/home`).
- Docs pages render markdown with GitHub-flavored features, custom alert boxes, heading anchors, and syntax highlighting.
- Admin can configure:
- GitHub source repository/path/token
- Site title/description/start page
- Docs icon URLs (16/32/180)
- Docs cache TTL
- Themes
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
- GitHub read/write + cache invalidation:
- `src/lib/github.ts`
- Search corpus/ranking:
- `src/lib/docs-search.ts`
- Cache implementation:
- `src/lib/cache.ts`
- Auth + rate limiting:
- `src/lib/auth.ts`
- `src/lib/login-rate-limit.ts`
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
- `GET /api/docs/search`
- Auth:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- Admin-protected:
- `GET|PATCH /api/admin/settings`
- `POST /api/admin/test-connection`
- `GET|POST /api/admin/docs`
- Themes:
- `GET|POST /api/themes`
- `PATCH|DELETE /api/themes/[id]`
- `POST /api/themes/activate`

## Local Development
1. `npm install`
2. `cp .env.example .env.local`
3. Set env values (required in production, fallback values exist in development):
- `AUTH_JWT_SECRET`
- `ADMIN_PASSWORD`
- `ENCRYPTION_SECRET`
4. `npm run dev`

Useful URLs:
- Docs: `http://localhost:3000/docs/<slug>`
- Admin login: `http://localhost:3000/admin/login`
- Editor: `http://localhost:3000/editor`

## Auth/Security Rules
- Admin session cookie: `vicky_admin_session`.
- Protected server paths are guarded both by middleware and route checks.
- Admin/editor pages perform server-side auth checks to avoid unauthorized content flash.
- Login endpoint includes in-memory IP-based rate limiting and temporary block windows.
- Any new write/admin endpoint must require admin auth (`requireAdminRequest` or equivalent).

## Caching + GitHub Data Flow
- Tree/page/search corpus are cached in memory with TTL (`src/lib/cache.ts`).
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

## Commit and Push Workflow (Important)
- User preference for this repo: commit after each finished task.
- Keep commits focused and descriptive.
- Always run `git commit` and `git push` sequentially. Wait for `git commit` to finish successfully before starting `git push`; do not run them in parallel.
- Push to `origin main` after each task-level commit unless the user says otherwise.
- Do not amend/rewrite history unless explicitly requested.
- Do not reset/revert unrelated user changes.

## Validation Checklist Before Commit
- Minimum: `npm run lint`
- Optional as needed: manual smoke checks for touched flows
- `npm run typecheck` is useful but can fail from existing unrelated issues (for example stale `.next` type artifacts or existing test typing issues). If it fails, report clearly instead of silently ignoring.

## Generated/Ignored Files
- `next-env.d.ts` is ignored and generated by Next.js.
- `data/wiki-store.json` is runtime data and ignored.
- `.next/` artifacts are generated and can cause stale type references after route refactors; clean/restart build if needed.

## Deployment Notes
- Use normal Next.js production commands: `npm run build` then `npm run start`.
- Persist `/data/wiki-store.json` (runtime app store) across deployments.
