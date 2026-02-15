# Vicky Docs

Vicky Docs is a browser-based wiki/documentation system built with Next.js.

It provides:
- GitHub-backed markdown storage (read + write through GitHub API)
- Admin-configurable repository settings
- Rich markdown rendering (GFM + GitHub-style alerts)
- Integrated docs editor with live preview
- Theme system with default light/dark themes + custom themes (CSS variables + custom CSS)
- Responsive docs browsing with tree navigation, search, breadcrumbs, and table of contents

## Tech Stack

- Next.js App Router (TypeScript)
- React 19
- Octokit (GitHub API)
- React Markdown + remark/rehype plugins
- CodeMirror editor
- JSON file store for app settings/themes (`data/wiki-store.json`)

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env.local
```

3. Set required values in `.env.local`:
- `AUTH_JWT_SECRET`
- `ADMIN_PASSWORD`
- `ENCRYPTION_SECRET`

4. Start development server:

```bash
npm run dev
```

5. Open:
- Docs: `http://localhost:3000/docs`
- Admin login: `http://localhost:3000/admin/login`
- Editor: `http://localhost:3000/editor`

## Admin Setup Flow

1. Sign in at `/admin/login` with `ADMIN_PASSWORD`.
2. Open `/admin/settings`.
3. Configure:
- GitHub owner
- GitHub repository
- Branch
- Docs path (for example `docs`)
- GitHub token (PAT with repo read/write permissions)
4. Click **Test connection**.
5. Save settings.

## Markdown Support

Renderer supports:
- GFM: tables, task lists, autolinks, strikethrough, footnotes
- Syntax highlighting for fenced code blocks
- Heading anchors + table of contents
- GitHub-style alert blocks:
  - `> [!NOTE]`
  - `> [!TIP]`
  - `> [!IMPORTANT]`
  - `> [!WARNING]`
  - `> [!CAUTION]`
- Additional aliases:
  - `INFO`, `SUCCESS`, `ERROR`

## Theme System

- Default built-in themes: `Classic Light`, `Classic Dark`
- Runtime switching: light/dark/custom
- Theme API:
  - `GET /api/themes`
  - `POST /api/themes`
  - `PATCH /api/themes/:id`
  - `DELETE /api/themes/:id`
  - `POST /api/themes/activate`
- Custom themes can define CSS variables and custom CSS blocks.

## Quality Checks

Run locally:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Docker Deployment

### Build + run (Docker)

```bash
docker build -t vicky-docs .
docker run -p 3000:3000 \
  -e AUTH_JWT_SECRET="replace-me" \
  -e ADMIN_PASSWORD="change-me" \
  -e ENCRYPTION_SECRET="replace-me" \
  -v vicky_data:/app/data \
  vicky-docs
```

### Run with Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

The persistent store is mounted at `/app/data`.

## Production Notes

- In production, `AUTH_JWT_SECRET`, `ADMIN_PASSWORD`, and `ENCRYPTION_SECRET` must be set.
- Keep GitHub token scoped minimally (repo access only as needed).
- Back up `data/wiki-store.json` regularly.
