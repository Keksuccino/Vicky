# Vicky Docs

Vicky Docs is a browser-based wiki/documentation system built with Next.js.

It provides:
- GitHub-backed markdown storage (read + write through GitHub API)
- Admin-configurable repository settings
- Rich markdown rendering (GFM + GitHub-style alerts)
- Integrated docs editor with live preview
- Theme system with default light/dark themes + custom themes (CSS variables + custom CSS)
- Responsive docs browsing with tree navigation, search, and table of contents

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

3. Set required values in `.env.local` (required for local development and production):
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
- GitHub token (fine-grained PAT)
4. Click **Test connection**.
5. Save settings.

### Fine-Grained GitHub Token Setup (Recommended)

When creating the token, configure it like this:

1. Token type: **Fine-grained personal access token**
2. Repository access: **Only select repositories**
3. Select exactly the docs source repository used by Vicky
4. Repository permissions:
   - **Contents**: **Read and write**
   - **Metadata**: **Read-only**
5. Leave all other permissions as **No access**

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

## Production Run

Build and start with npm:

```bash
npm run build
npm run start
```

## Production Notes

- `AUTH_JWT_SECRET`, `ADMIN_PASSWORD`, and `ENCRYPTION_SECRET` must be set in every non-test environment.
- Keep GitHub token scoped minimally (repo access only as needed).
- Back up `data/wiki-store.json` regularly.
- Admin login brute-force protection can be tuned with:
  - `AUTH_LOGIN_MAX_FAILURES` (default `8`)
  - `AUTH_LOGIN_WINDOW_SECONDS` (default `600`)
  - `AUTH_LOGIN_BLOCK_SECONDS` (default `10800`)
  - `AUTH_TRUST_PROXY_HEADERS` (default `false`; only enable behind trusted proxies)
  - `AUTH_LOGIN_STORE_FILE_PATH` (default `./data/login-rate-limit.json`)
