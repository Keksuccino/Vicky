# Testing Guidelines

## Automated tests

- `npm test` runs Vitest. Tests that touch GitHub use the fake API in `src/lib/__tests__/fixtures/fake-github-api.ts` (`vi.stubGlobal("fetch", fake.fetch)`), which runs the real GitHub client, and point `WIKI_DOCS_CACHE_DIR`, `WIKI_MARKDOWN_CACHE_DIR`, and `WIKI_TRANSLATION_CACHE_DIR` at a temporary directory.
- Assert GitHub traffic with `fake.count(kind)` / `fake.requests` after `fake.resetRequests()`. A test must never reach the real GitHub API: when a module mock stops covering a loader, the loader falls through to `fetch`, so stub `fetch` in every test that can reach GitHub code.

## Real server without GitHub

`scripts/fake-github-preload.mjs` runs the production server against the same fake GitHub API (needs Node.js 22.18 or newer for TypeScript type stripping):

1. `npm run build`.
2. Create a temporary directory inside the project (never commit it) and export, for the server process only:
   - `NODE_ENV=production`, `VICKY_RUNTIME_TOPOLOGY=single-process-local`, a non-default `HTTP_PORT`/`HTTPS_PORT`, `HOST=127.0.0.1`.
   - Fresh `AUTH_JWT_SECRET`, `ADMIN_PASSWORD`, `ENCRYPTION_SECRET` (`openssl rand -base64 48`), not the values of `.env.local`.
   - Every runtime path, pointed into the temporary directory: `WIKI_STORE_FILE_PATH`, `WIKI_SSL_STORAGE_DIR`, `WIKI_MARKDOWN_CACHE_DIR`, `WIKI_DOCS_CACHE_DIR`, `WIKI_DOCS_SNAPSHOT_DIR`, `WIKI_TRANSLATION_CACHE_DIR`, `WIKI_ANALYTICS_DB_PATH`, `AUTH_LOGIN_DB_PATH`, `AUTH_LOGIN_STORE_FILE_PATH`, `SSL_STATUS_FILE_PATH`. `.env.local` sets some of these to `data/`; exported values take precedence.
   - `NODE_OPTIONS=--import=<absolute path>/scripts/fake-github-preload.mjs`.
   - Optional: `FAKE_GITHUB_SEED` (JSON array of `{ "path": "docs/x.md", "content": "..." }` or `{ "path": ..., "size": <bytes> }` for synthetic pages, committed in order, so a later entry for a source page makes its earlier translations outdated), `FAKE_GITHUB_LATENCY_MS` (per-request delay), `FAKE_GITHUB_LOG` (one JSON line per GitHub request), `FAKE_GITHUB_CONTROL_PORT` (default `39190`).
3. `node server.mjs`, then sign in with `POST /api/auth/login` (`{"username":"admin","password":...}`, `Origin` header set to the server) and configure the source with `PATCH /api/admin/settings` (`github.owner`/`repo`/`branch` = `owner`/`repo`/`main` unless `FAKE_GITHUB_OWNER`/`FAKE_GITHUB_REPO`/`FAKE_GITHUB_BRANCH` are set; any token value).
4. The control endpoint on `127.0.0.1:<FAKE_GITHUB_CONTROL_PORT>`: `/` returns request counts by kind, `/reset` clears them, `/delete?path=<repo path>` deletes a file like a commit on GitHub.
5. Stop the server with `SIGTERM` and move the temporary directory to the trash.

## UI checks offscreen

`node scripts/offscreen-browser.mjs <steps.json>` drives a headless Chrome over the DevTools protocol: no window opens and focus never changes. Set `CHROME_PATH` if Chrome is not in its default location. The browser profile lives in `node_modules/.cache/offscreen-browser-profile` (override with `OFFSCREEN_BROWSER_PROFILE_DIR`); runs must not overlap.

```json
{
  "viewport": { "width": 1440, "height": 1000, "deviceScaleFactor": 1 },
  "mobile": false,
  "colorScheme": "dark",
  "cookies": [{ "name": "vicky_admin_session", "value": "...", "url": "http://127.0.0.1:39180", "httpOnly": true }],
  "steps": [
    { "goto": "http://127.0.0.1:39180/admin/settings" },
    { "waitFor": ".panel-card-markdown-cache" },
    { "click": ".markdown-cache-idle button" },
    { "type": "text typed into the focused element" },
    { "key": "Enter" },
    { "wait": 300 },
    { "eval": "document.title" },
    { "screenshot": "shots/card.png", "selector": ".panel-card-markdown-cache" }
  ]
}
```

Clicks are real mouse events at the element's centre after scrolling it into view; `eval` prints its JSON result; screenshot paths are relative to the steps file, and `selector` clips to one element. The admin session cookie comes from the login response (for example `curl -c cookies.txt`).
