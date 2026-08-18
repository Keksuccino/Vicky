# ⚠️ VICKY IS STILL VERY WIP AND SHOULD NOT GET USED IN PRODUCTION YET! ⚠️

<br>
<br>
<br>
<br>

# Vicky

Vicky is a modern self-hosted docs/wiki frontend for Markdown content stored in a GitHub repository.

It gives you:
- a public documentation site
- an admin panel for repository, branding, domain, and theme settings
- an optional AI chat assistant for docs pages
- an in-browser markdown editor that saves directly back to GitHub
- visitor and visit analytics, including per-page analytics

<br>
<img width="900" alt="vicky_preview" src="https://github.com/user-attachments/assets/35909429-404e-4ec0-92de-ce7440145eae" />
<br>
<br>

✨ **Vicky Example Page:** https://docs.fancymenu.net/docs/en-US/home

# Highlights

- GitHub-backed docs storage: pages are read from a configured repository and path, not from this repo
- Public docs UI with tree navigation, search, table of contents, heading anchors, mobile layout, and syntax-highlighted code blocks
- Markdown rendering with GFM support and GitHub-style alert boxes
- Built-in Light and Dark modes with simple accent-color customization
- Optional custom CSS overrides on top of the built-in themes
- Optional OpenRouter-powered AI chat assistant with configurable name, avatar, UI copy, and system prompt template
- Custom domain support with automatic Let's Encrypt HTTPS when using the included production server
- Admin-only editor with live preview and immediate GitHub commits on save
- Built-in visitor and visit analytics, including per-page analytics, for All-time, last 24h, last 7 days, last 30 days, and last 365 days

# How Vicky Stores Data

- Docs content lives in your configured GitHub repository.
- App settings live in `data/wiki-store.json` by default.
- SSL certificates and runtime SSL status live in `data/ssl/` by default.
- Rendered Markdown HTML cache files live in `data/markdown-cache/` by default.
- GitHub docs snapshot cache files live in `data/docs-cache/` by default.
- OpenRouter docs translation cache files live in `data/translation-cache/` by default.
- Optional login rate-limit persistence uses `data/login-rate-limit.json`.
- Visitor and visit analytics live in `data/wiki-analytics.sqlite` by default.

This repo contains the app itself, not your docs content.

# Requirements

- Node.js `20.9.0` or newer
- A GitHub repository that contains your markdown docs
- A fine-grained GitHub personal access token with:
  - `Contents: Read and write`
  - `Metadata: Read-only`

# Quick Start

## 1. Install dependencies:

```bash
npm ci
```

## 2. Create a local env file:

**Unix**
```bash
cp .env.example .env.local
```

**Windows Command Prompt**
```bash
copy .env.example .env.local
```

**Windows PowerShell**
```bash
Copy-Item .env.example .env.local
```

## 3. Set the required values in `.env.local`:

- `AUTH_JWT_SECRET`: a unique random value of at least 32 characters
- `ADMIN_PASSWORD`: a unique password or strong passphrase of at least 14 characters
- `ENCRYPTION_SECRET`: a second unique random value of at least 32 characters

Do not reuse a value between these fields, and do not leave example values or common placeholders in place. For each machine-generated secret, `openssl rand -base64 48` produces a suitable value. Vicky validates all three values and exits before opening a listener if any value is missing, predictable, reused, or still a placeholder.

## 4. Start the dev server:

```bash
npm run dev
```

## 5. Open:

- Admin login: `http://localhost:3000/admin/login`
- Docs site: `http://localhost:3000/`
- Editor: `http://localhost:3000/editor`

If you run the repo from `/mnt/<drive>/...` inside WSL, `npm run dev` automatically switches Next.js to a polling-based watcher so hot reload stays reliable.

# First-Time Setup

1. Sign in at `/admin/login` with username `admin` and the password from `ADMIN_PASSWORD`.
2. Open `/admin/settings`.
3. In `Repository Settings`, configure:
   - GitHub owner
   - GitHub repository
   - branch
   - docs path
   - GitHub token
4. Click `Test connection`.
5. Save the settings.
6. Optionally configure:
   - site title, description, footer, and icons
   - Light/Dark theme accent colors
   - custom domain and Let's Encrypt email
   - AI chat assistant settings, OpenRouter model, and OpenRouter API key

After setup:
- `/` redirects to your configured start page
- docs pages are served at `/docs/<path>`
- the editor is available at `/editor`

# AI Chat Assistant

The AI chat assistant is optional and appears as the floating `Ask Docs` button on docs pages when enabled.

It supports:
- a configurable assistant name, profile image URL, header subtitle, and welcome message
- a configurable OpenRouter model and encrypted OpenRouter API key
- a system prompt template with `{{assistant_name}}` and `{{docs_txt}}` placeholders
- grounding responses in the live `/docs.txt` export of your documentation
- optional image uploads when you choose a vision-capable model

AI chat is configured from `AI Chat` in the admin panel.

Notes:
- keep `{{docs_txt}}` in the system prompt template so Vicky can inject the live docs export
- use `{{assistant_name}}` in the system prompt, header subtitle, or welcome message if you want those values to update automatically with the configured assistant name
- leave the profile image URL blank to use the default assistant badge icon

# Editor

The editor is admin-only and writes directly to your configured GitHub docs repository.

It supports:
- loading existing pages from the docs tree
- creating new pages
- editing title, description, path, markdown content, and commit message
- auto-generating the path from the title until you override it
- Markdown and Preview modes
- `Ctrl+S` / `Cmd+S` saving

# Markdown Features

Vicky supports:
- GitHub Flavored Markdown
- fenced code blocks with syntax highlighting
- copy buttons on fenced code blocks
- heading anchors
- generated table of contents data
- GitHub-style alerts such as `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`
- additional alert aliases: `INFO`, `SUCCESS`, `ERROR`
- automatic normalization of root-relative docs links to `/docs/...`

# Available Scripts

- `npm run dev` starts the Next.js dev server
- `npm run build` builds the app for production
- `npm run start` runs the included production server (`server.mjs`)
- `npm run start:next` runs plain `next start`
- `npm run lint` runs ESLint
- `npm run typecheck` runs TypeScript checks
- `npm run test` runs the test suite once
- `npm run test:watch` runs tests in watch mode

Use `npm run start` if you want Vicky's built-in custom-domain and automatic HTTPS handling. Use `npm run start:next` only if you explicitly want a plain Next.js server.

# Environment Variables

Required:

| Variable | Purpose |
| --- | --- |
| `AUTH_JWT_SECRET` | Unique 32+ character value that signs admin session tokens |
| `ADMIN_PASSWORD` | Unique 14+ character password or strong passphrase for `/admin/login` |
| `ENCRYPTION_SECRET` | Unique 32+ character value that encrypts stored provider credentials |

Common optional settings:

| Variable | Purpose | Default |
| --- | --- | --- |
| `WIKI_STORE_FILE_PATH` | Location of the app settings store | `./data/wiki-store.json` |
| `WIKI_SSL_STORAGE_DIR` | Certificate storage directory | `./data/ssl` |
| `WIKI_MARKDOWN_CACHE_DIR` | Persistent rendered Markdown HTML cache directory | `./data/markdown-cache` |
| `WIKI_DOCS_SNAPSHOT_DIR` | Persistent GitHub docs snapshot cache directory | `./data/docs-cache/snapshots` |
| `WIKI_TRANSLATION_CACHE_DIR` | Persistent docs translation cache directory | `./data/translation-cache` |
| `WIKI_ANALYTICS_DB_PATH` | Persistent visitor analytics SQLite database | `./data/wiki-analytics.sqlite` |
| `PUBLIC_DOCS_CLIENT_MAX_REQUESTS` | Public page, raw, metadata, and tree reads accepted per client during the docs rate window | `180` |
| `PUBLIC_DOCS_GLOBAL_MAX_REQUESTS` | Public document reads accepted globally during the docs rate window | `5000` |
| `PUBLIC_DOCS_RATE_WINDOW_SECONDS` | Public document read rate-limit window | `60` |
| `PUBLIC_DOCS_CLIENT_MAX_CONCURRENCY` | Concurrent public document reads allowed per client | `12` |
| `PUBLIC_DOCS_GLOBAL_MAX_CONCURRENCY` | Concurrent public document reads allowed per app process | `128` |
| `VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS` | Page-view requests accepted per client during the analytics rate window | `60` |
| `VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS` | Page-view requests accepted globally during the analytics rate window | `1200` |
| `VISITOR_ANALYTICS_RATE_WINDOW_SECONDS` | Analytics page-view rate-limit window | `60` |
| `VISITOR_ANALYTICS_CLIENT_MAX_CONCURRENCY` | Concurrent page-view requests allowed per client | `4` |
| `VISITOR_ANALYTICS_GLOBAL_MAX_CONCURRENCY` | Concurrent page-view requests allowed per app process | `32` |
| `VISITOR_ANALYTICS_QUEUE_CAPACITY` | Maximum queued or actively written page-view events | `1000` |
| `VISITOR_ANALYTICS_RETRY_BASE_MS` | Initial delay before retrying a failed analytics write | `1000` |
| `VISITOR_ANALYTICS_RETRY_MAX_MS` | Maximum delay between failed analytics write attempts | `30000` |
| `HOST` | Listen host | `0.0.0.0` |
| `HTTP_PORT` | HTTP listen port | `3000` |
| `HTTPS_PORT` | HTTPS listen port | `443` |
| `LETS_ENCRYPT_STAGING` | Use Let's Encrypt staging CA for test runs | `false` |
| `AUTH_TRUST_PROXY_HEADERS` | Trust forwarded client IP headers | `false` |
| `VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER` | Trust an ingress-overwritten `x-vicky-client-ip` header for public docs, visitor stats, and login rate limiting | `false` |

Runtime file and directory overrides must point into a dedicated storage directory. On POSIX hosts Vicky enforces and verifies `0700` directories and `0600` sensitive files; it refuses to change permissions on the filesystem root, OS temp root, user home, or project root. Windows deployments must apply equivalent access restrictions through the storage volume's ACLs because Windows does not implement POSIX mode bits.

`HTTP_PORT` falls back to `PORT` if `HTTP_PORT` is not set.
`npm run start` sets `x-vicky-client-ip` from the socket address internally; only set `VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER=true` yourself when another trusted ingress overwrites that header.

Public page-view analytics accepts only small UTF-8 JSON bodies, rejects conflicting browser `Origin`/`Sec-Fetch-Site` signals, and records only pages present in the configured docs tree. Page paths and titles are resolved from server-side docs caches, client titles are ignored, and event IDs are deduplicated with bounded in-memory state before SQLite's durable per-visitor deduplication. Per-client controls use the same trusted client-IP settings described below; when no trustworthy address is available, the global limits remain active without collapsing all visitors into one client quota. The analytics rate, concurrency, queue, and retry limits above are per app process; use ingress rate limiting as well when deploying multiple instances.

Public document reads accept only bounded canonical paths that already exist in the cached GitHub docs tree. Unknown slugs are negatively cached and never become speculative `.md` or `.mdx` GitHub file requests. The public docs rate and concurrency limits above are per app process; when no trustworthy client address is available, only the global limits apply. Use ingress rate limiting as well for multi-instance deployments.

For the full list of optional runtime settings, check [.env.example](.env.example).

# Production Notes

Standard production flow:

```bash
npm run build
npm run start
```

Both `npm run start` and `npm run start:next` validate the required secrets before accepting requests. Use the npm command instead of invoking `next start` directly so the plain Next.js server is validated before its process is created. Automated tests receive deterministic fallback credentials only through the test runner; setting `NODE_ENV=test` in a normal process does not bypass startup validation.

`npm run start` uses the included `server.mjs` server, which:
- starts the Next.js app
- serves HTTP
- enables HTTPS automatically when a custom domain and Let's Encrypt email are configured
- reserves plaintext `/.well-known/acme-challenge/*` requests for HTTP-01 validation
- redirects configured custom-domain HTTP traffic only while a matching, currently valid certificate is active
- returns a cache-disabled `503` maintenance response for configured custom-domain HTTP traffic while initial issuance, expired-certificate replacement, or outage recovery is pending
- keeps localhost and other non-custom HTTP hosts available for local/default-host access
- retries failed issuance and renewal with capped exponential backoff while the process is running
- supplies authenticated admins with SSL runtime status from a private on-disk snapshot
- watches the settings store so domain/SSL changes apply quickly
- persists runtime SSL status to disk

The optional external SSL health endpoint defaults to `/.well-known/vicky/ssl-status`, but it is disabled and returns `404` unless `SSL_STATUS_BEARER_TOKEN` is set. When enabled, it requires `Authorization: Bearer <token>` using constant-time credential comparison and returns only sanitized health fields. It never returns filesystem paths, the configured domain, host/port settings, refresh reasons, or raw certificate/ACME errors. Use a long randomly generated token, access the endpoint only through HTTPS or a trusted private network, and change `SSL_STATUS_ENDPOINT_PATH` if your ingress requires a custom route. The authenticated `/api/admin/domain-status` route does not depend on this external endpoint.

`HTTP_PORT` and `HTTPS_PORT` must be different values.

If you run Vicky behind a reverse proxy:
- forward `/.well-known/acme-challenge/*` to Vicky unchanged
- do not replace Vicky's fail-closed custom-domain `503` response with a plaintext application fallback
- preserve the original `Host` header
- keep DNS pointed at the proxy/public ingress
- set `AUTH_TRUST_PROXY_HEADERS=true` only when the proxy overwrites `x-forwarded-for` or `x-real-ip`

For direct HTTP-01 validation without a reverse proxy, you usually want:
- `HTTP_PORT=80`
- `HTTPS_PORT=443`

Persist these paths across deployments:
- `data/wiki-store.json`
- `data/ssl/`
- `data/markdown-cache/`
- `data/docs-cache/`
- `data/translation-cache/`
- `data/wiki-analytics.sqlite`, including its `-wal` and `-shm` companions when present
- `data/login-rate-limit.json`

# API Overview

Public endpoints:
- `GET /api/public/settings`
- `GET /api/public/icon/16`
- `GET /api/public/icon/32`
- `GET /api/public/icon/180`
- `POST /api/ai/chat`
- `GET /api/docs/tree`
- `GET /api/docs/page`
- `GET /api/docs/page-metadata`
- `GET /api/docs/raw`
- `GET /api/docs/raw/<path>`
- `GET /api/docs/search`
- `POST /api/docs/visit`
- `GET /docs.txt`

Auth endpoints:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Admin endpoints:
- `GET|PATCH /api/admin/settings`
- `POST /api/admin/test-connection`
- `GET|POST /api/admin/docs`
- `POST /api/admin/docs/refresh`
- `GET /api/admin/domain-status`
- `GET|POST|DELETE /api/admin/markdown-cache`
- `GET|POST /api/admin/moderators`
- `PATCH|DELETE /api/admin/moderators/<id>`
- `GET /api/admin/performance`
- `POST /api/admin/translations/request`
- `POST /api/admin/translations/status`
- `GET /api/admin/visitors`

# Third-Party Assets

Vicky uses Google's Material Symbols Outlined icon font for UI icons via `@fontsource/material-symbols-outlined`.

- Source: <https://github.com/google/material-design-icons>
- License: Apache-2.0

Vicky uses Circle Flags for language flag icons via `@iconify-json/circle-flags`.

- Source: <https://github.com/HatScripts/circle-flags>
- License: MIT

# Copyright & License

Vicky Copyright © 2026 Keksuccino.<br>
Vicky is licensed under MIT. See [LICENSE.md](LICENSE.md).
