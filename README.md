# Vicky Docs

Vicky Docs is a browser-based wiki/documentation system built with Next.js.

It provides:
- GitHub-backed markdown storage (read + write through GitHub API)
- Admin-configurable repository settings
- Admin-configurable domain settings (custom domain + automatic Let's Encrypt HTTPS)
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
- Optional domain settings:
  - Custom domain (for example `fancymenu.net`)
  - Let's Encrypt email
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

`npm run start` runs `server.mjs`, which:
- serves HTTP on `HTTP_PORT` (or `PORT` fallback)
- serves HTTPS on `HTTPS_PORT` when domain + email are configured
- automatically requests/renews certificates from Let's Encrypt
- performs renewal checks on startup and periodically during runtime
- watches `wiki-store.json` and applies domain/SSL setting changes quickly (debounced)
- uses retry backoff after issuance failures to reduce Let's Encrypt rate-limit risk
- persists runtime SSL status and exposes it via a small runtime endpoint

For direct Let's Encrypt HTTP-01 validation, set:
- `HTTP_PORT=80`
- `HTTPS_PORT=443`

Binding ports `<1024` (for example `80`/`443`) usually requires elevated privileges.
Use one of:
- Linux capability (`CAP_NET_BIND_SERVICE`) for the Node binary/service user
- a reverse proxy (recommended) that listens on `80/443` and forwards to Vicky

If you run behind a reverse proxy:
- forward `/.well-known/acme-challenge/*` unchanged to Vicky's HTTP port
- preserve the original `Host` header
- keep DNS for the custom domain pointing at the proxy/public ingress

## Production Notes

- `AUTH_JWT_SECRET`, `ADMIN_PASSWORD`, and `ENCRYPTION_SECRET` must be set in every non-test environment.
- Keep GitHub token scoped minimally (repo access only as needed).
- Back up `data/wiki-store.json` regularly.
- Persist `data/ssl` (or your configured `WIKI_SSL_STORAGE_DIR`) across deployments.
- SSL storage directories are locked down at runtime (`0700` where supported by the OS).
- Automatic SSL only runs when both Domain Settings fields are configured.
- DNS for the configured custom domain must point to this server.
- Runtime SSL status:
  - endpoint path: `SSL_STATUS_ENDPOINT_PATH` (default `/.well-known/vicky/ssl-status`)
  - optional auth: `SSL_STATUS_BEARER_TOKEN` (Bearer token)
  - persisted file: `SSL_STATUS_FILE_PATH` (default `./data/ssl/runtime-ssl-status.json`)
- SSL retry/backoff tuning:
  - `SSL_ISSUE_RETRY_BASE_MS` (default `900000`)
  - `SSL_ISSUE_RETRY_MAX_MS` (default `86400000`)
- Store watcher debounce:
  - `SSL_STORE_WATCH_DEBOUNCE_MS` (default `1500`)
- Admin login brute-force protection can be tuned with:
  - `AUTH_LOGIN_MAX_FAILURES` (default `8`)
  - `AUTH_LOGIN_WINDOW_SECONDS` (default `600`)
  - `AUTH_LOGIN_BLOCK_SECONDS` (default `10800`)
  - `AUTH_TRUST_PROXY_HEADERS` (default `false`; only enable behind trusted proxies)
  - `AUTH_LOGIN_STORE_FILE_PATH` (default `./data/login-rate-limit.json`)

## SSL Runbook / Troubleshooting

1. Check runtime SSL state:
   - `curl -s http://127.0.0.1:${HTTP_PORT:-3000}/.well-known/vicky/ssl-status`
   - if token is configured: `curl -H "Authorization: Bearer <token>" ...`
2. If `phase` is `backoff`, inspect `retry.nextAttemptAt` and `certificate.lastIssueErrorMessage` before retrying.
3. For dry runs, set `LETS_ENCRYPT_STAGING=true` to avoid production CA rate limits.
4. If certificates are lost after redeploy/restart, verify persistent volume mapping for `WIKI_SSL_STORAGE_DIR`.
5. If domain changes do not apply quickly, verify writes reach `WIKI_STORE_FILE_PATH` on disk and inspect server logs for watcher events/errors.
