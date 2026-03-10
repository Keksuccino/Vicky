# Vicky

Vicky is a modern self-hosted docs/wiki frontend for Markdown content stored in a GitHub repository.

It gives you:
- a public documentation site
- an admin panel for repository, branding, domain, and theme settings
- an optional AI chat assistant for docs pages
- an in-browser markdown editor that saves directly back to GitHub

![Screenshot_4_5](https://github.com/user-attachments/assets/1b2e9754-5402-48e5-808c-5f79c254318d)

<img width="665" height="566" alt="Screenshot_4" src="https://github.com/user-attachments/assets/6f65dbec-0367-48a0-8449-166c64e31a27" />

## Highlights

- GitHub-backed docs storage: pages are read from a configured repository and path, not from this repo
- Public docs UI with tree navigation, search, table of contents, heading anchors, mobile layout, and syntax-highlighted code blocks
- Markdown rendering with GFM support and GitHub-style alert boxes
- Built-in Light and Dark modes with simple accent-color customization
- Optional custom CSS overrides on top of the built-in themes
- Optional OpenRouter-powered AI chat assistant with configurable name, avatar, UI copy, and system prompt template
- Custom domain support with automatic Let's Encrypt HTTPS when using the included production server
- Admin-only editor with live preview and immediate GitHub commits on save

## How Vicky Stores Data

- Docs content lives in your configured GitHub repository.
- App settings live in `data/wiki-store.json` by default.
- SSL certificates and runtime SSL status live in `data/ssl/` by default.
- Optional login rate-limit persistence uses `data/login-rate-limit.json`.

This repo contains the app itself, not your docs content.

## Requirements

- Node.js `20.9.0` or newer
- A GitHub repository that contains your markdown docs
- A fine-grained GitHub personal access token with:
  - `Contents: Read and write`
  - `Metadata: Read-only`

## Quick Start

### 1. Install dependencies:

```bash
npm install
```

### 2. Create a local env file:

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

### 3. Set the required values in `.env.local`:

- `AUTH_JWT_SECRET`
- `ADMIN_PASSWORD`
- `ENCRYPTION_SECRET`

### 4. Start the dev server:

```bash
npm run dev
```

### 5. Open:

- Admin login: `http://localhost:3000/admin/login`
- Docs site: `http://localhost:3000/`
- Editor: `http://localhost:3000/editor`

If you run the repo from `/mnt/<drive>/...` inside WSL, `npm run dev` automatically switches Next.js to a polling-based watcher so hot reload stays reliable.

## First-Time Setup

1. Sign in at `/admin/login` with the password from `ADMIN_PASSWORD`.
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

## Admin Panel

The settings UI is split into five areas:

- `Repository Settings`: GitHub owner/repo/branch/docs path, token handling, docs cache TTL, and connection testing
- `Site Settings`: title, description, footer template, start page, title gradient, and docs icon URLs
- `Domain Settings`: custom domain, Let's Encrypt email, and live SSL runtime status
- `Theme Management`: built-in Light/Dark accent colors plus custom CSS
- `AI Chat`: assistant enable/disable toggle, assistant name/avatar, chat header copy, welcome message, OpenRouter model/API key, and system prompt template

Footer text supports these placeholders:
- `{{year}}`
- `{{owner}}`
- `{{vicky}}`

`{{vicky}}` is rendered as a clickable link to the Vicky repository.

## AI Chat Assistant

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

## Theme Customization

Theme customization is intentionally simple:
- built-in `Light` and `Dark` modes
- one main accent color per mode
- one surface/background accent color per mode
- optional site title gradient colors
- optional custom CSS overrides

Theme changes are managed from `Theme Management` in the admin panel.

## Editor

The editor is admin-only and writes directly to your configured GitHub docs repository.

It supports:
- loading existing pages from the docs tree
- creating new pages
- editing title, description, path, markdown content, and commit message
- auto-generating the path from the title until you override it
- Markdown and Preview modes
- `Ctrl+S` / `Cmd+S` saving

## Markdown Features

Vicky supports:
- GitHub Flavored Markdown
- fenced code blocks with syntax highlighting
- copy buttons on fenced code blocks
- heading anchors
- generated table of contents data
- GitHub-style alerts such as `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`
- additional alert aliases: `INFO`, `SUCCESS`, `ERROR`
- automatic normalization of root-relative docs links to `/docs/...`

## Available Scripts

- `npm run dev` starts the Next.js dev server
- `npm run build` builds the app for production
- `npm run start` runs the included production server (`server.mjs`)
- `npm run start:next` runs plain `next start`
- `npm run lint` runs ESLint
- `npm run typecheck` runs TypeScript checks
- `npm run test` runs the test suite once
- `npm run test:watch` runs tests in watch mode

Use `npm run start` if you want Vicky's built-in custom-domain and automatic HTTPS handling. Use `npm run start:next` only if you explicitly want a plain Next.js server.

## Environment Variables

Required:

| Variable | Purpose |
| --- | --- |
| `AUTH_JWT_SECRET` | Signs admin session tokens |
| `ADMIN_PASSWORD` | Password for `/admin/login` |
| `ENCRYPTION_SECRET` | Encrypts the stored GitHub token |

Common optional settings:

| Variable | Purpose | Default |
| --- | --- | --- |
| `WIKI_STORE_FILE_PATH` | Location of the app settings store | `./data/wiki-store.json` |
| `WIKI_SSL_STORAGE_DIR` | Certificate storage directory | `./data/ssl` |
| `HOST` | Listen host | `0.0.0.0` |
| `HTTP_PORT` | HTTP listen port | `3000` |
| `HTTPS_PORT` | HTTPS listen port | `443` |
| `LETS_ENCRYPT_STAGING` | Use Let's Encrypt staging CA for test runs | `false` |
| `AUTH_TRUST_PROXY_HEADERS` | Trust forwarded client IP headers | `false` |

`HTTP_PORT` falls back to `PORT` if `HTTP_PORT` is not set.

For the full list of optional runtime settings, check [.env.example](.env.example).

## Production Notes

Standard production flow:

```bash
npm run build
npm run start
```

`npm run start` uses the included `server.mjs` server, which:
- starts the Next.js app
- serves HTTP
- enables HTTPS automatically when a custom domain and Let's Encrypt email are configured
- exposes a runtime SSL status endpoint
- watches the settings store so domain/SSL changes apply quickly
- persists runtime SSL status to disk

`HTTP_PORT` and `HTTPS_PORT` must be different values.

If you run Vicky behind a reverse proxy:
- forward `/.well-known/acme-challenge/*` to Vicky unchanged
- preserve the original `Host` header
- keep DNS pointed at the proxy/public ingress

For direct HTTP-01 validation without a reverse proxy, you usually want:
- `HTTP_PORT=80`
- `HTTPS_PORT=443`

Persist these paths across deployments:
- `data/wiki-store.json`
- `data/ssl/`

## API Overview

Public endpoints:
- `GET /api/public/settings`
- `GET /api/public/icon/16`
- `GET /api/public/icon/32`
- `GET /api/public/icon/180`
- `POST /api/ai/chat`
- `GET /api/docs/tree`
- `GET /api/docs/page`
- `GET /api/docs/search`

Auth endpoints:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Admin endpoints:
- `GET|PATCH /api/admin/settings`
- `POST /api/admin/test-connection`
- `GET|POST /api/admin/docs`
- `GET /api/admin/domain-status`

## Third-Party Assets

Vicky uses Google's Material Symbols Outlined icon font for UI icons via `@fontsource/material-symbols-outlined`.

- Source: <https://github.com/google/material-design-icons>
- License: Apache-2.0

## Copyright & License

Vicky Copyright © 2026 Keksuccino.<br>
Vicky is licensed under MIT. See [LICENSE.md](LICENSE.md).
