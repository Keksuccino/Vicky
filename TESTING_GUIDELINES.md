# Testing Guidelines

## Automated tests

- `npm test` runs Vitest. Tests that touch GitHub use the fake API in `src/lib/__tests__/fixtures/fake-github-api.ts` (`vi.stubGlobal("fetch", fake.fetch)`), which runs the real GitHub client, and point `WIKI_DOCS_CACHE_DIR` and `WIKI_MARKDOWN_CACHE_DIR` at a temporary directory.
- Assert GitHub traffic with `fake.count(kind)` / `fake.requests` after `fake.resetRequests()`. A test must never reach the real GitHub API: when a module mock stops covering a loader, the loader falls through to `fetch`, so stub `fetch` in every test that can reach GitHub code.
- `src/test/vitest-setup.ts` runs before every test file:
  - Every runtime path variable (`WIKI_*`, `AUTH_LOGIN_*`, `SSL_STATUS_FILE_PATH`) points into a directory of that test file inside `node_modules/.cache/vitest-runtime/run-<time>-<pid>`, which `src/test/vitest-global-setup.ts` moves to the trash when the run ends. A test that changes one must restore the previous value, never delete it: a test that leaves a path resolving into the real `data/` fails.
  - Network access fails the test: `fetch` to a host other than loopback is rejected, and any other TCP connection to such a host fails as refused, even when the code under test swallows the error. Local test servers on `127.0.0.1` work.
  - Components rendered with Testing Library are unmounted after each test (Vitest globals are off, so Testing Library cannot do it itself).
- Never assert or select by human-readable text (messages, labels, log wording). Assert error `code`s (`RuntimeTopologyError`, runtime secret `issues`, file-security refusals), HTTP `status` and headers, structured log fields (`level`, `languageCode`, `slug`), and select elements by id or class.

## Real server without GitHub

`scripts/fake-github-preload.mjs` runs the production server against the same fake GitHub API, and answers every request to `openrouter.ai` with a fake OpenRouter endpoint, so translation jobs run offline and never reach the real API (needs Node.js 22.18 or newer for TypeScript type stripping):

1. `npm run build`.
2. Create a temporary directory inside the project (never commit it) and export, for the server process only:
   - `VICKY_RUNTIME_TOPOLOGY=single-process-local`, a non-default `HTTP_PORT`/`HTTPS_PORT`, `HOST=127.0.0.1`.
   - Fresh `AUTH_JWT_SECRET`, `ADMIN_PASSWORD`, `ENCRYPTION_SECRET` (`openssl rand -base64 48`), not the values of `.env.local`.
   - Every runtime path, pointed into the temporary directory: `WIKI_STORE_FILE_PATH`, `WIKI_SSL_STORAGE_DIR`, `WIKI_MARKDOWN_CACHE_DIR`, `WIKI_DOCS_CACHE_DIR`, `WIKI_DOCS_SNAPSHOT_DIR`, `WIKI_TRANSLATION_CACHE_DIR` (startup deletes the old translation cache files there), `WIKI_ANALYTICS_DB_PATH`, `AUTH_LOGIN_DB_PATH`, `AUTH_LOGIN_STORE_FILE_PATH`, `SSL_STATUS_FILE_PATH`. `.env.local` sets some of these to `data/`; exported values take precedence. The preload loads the env files as the server does and refuses to start (exit code 1, listing the offending paths) while any runtime path, set or defaulted, is inside the project's `data/`.
   - `NODE_OPTIONS=--import=<absolute path>/scripts/fake-github-preload.mjs`. Worker threads (the visitor analytics worker) inherit it; the preload installs its fakes and the control endpoint in the main thread only.
   - Optional: `FAKE_GITHUB_SEED` (path to a JSON file holding an array of `{ "path": "docs/x.md", "content": "..." }` or `{ "path": ..., "size": <bytes> }` for synthetic pages, committed in order, so a later entry for a source page makes its earlier translations outdated), `FAKE_GITHUB_LATENCY_MS` (per-request delay), `FAKE_GITHUB_LOG` (one JSON line per GitHub or OpenRouter request), `FAKE_GITHUB_CONTROL_PORT` (default `39190`).
   - Optional for translation jobs: `FAKE_OPENROUTER_LATENCY_MS` (delay per translation), `FAKE_OPENROUTER_RATE_LIMITS=<n>` (the first n requests get a 429 with `retry-after: FAKE_OPENROUTER_RETRY_AFTER_S`, default 2, to watch the backoff). A fake translation appends the language name to the title and puts a note above the unchanged content.
3. `node server.mjs`, then sign in with `POST /api/auth/login` (`{"username":"admin","password":...}`, `Origin` header set to the server) and configure the source with `PATCH /api/admin/settings` (`github.owner`/`repo`/`branch` = `owner`/`repo`/`main` unless `FAKE_GITHUB_OWNER`/`FAKE_GITHUB_REPO`/`FAKE_GITHUB_BRANCH` are set; any token value). For translation jobs also set `openRouter.apiKey` (any value), `autoTranslate.openRouterModel`, and `autoTranslate.languages`. Queued translation uploads are committed at the next upload window, 5 minutes after the first one was queued.
   The same environment also runs `node scripts/dev.mjs -H 127.0.0.1 -p <port>` (`npm run dev`) and `node scripts/start-next.mjs -H 127.0.0.1 -p <port>` (`npm run start:next`) against the fakes. Every process of those launchers loads the preload and gets its own fakes; the control endpoint then lives in the launcher process and sees none of the traffic, so use it with `node server.mjs` only.
4. The control endpoint on `127.0.0.1:<FAKE_GITHUB_CONTROL_PORT>`: `/` returns GitHub request counts by kind (`total` counts GitHub requests; OpenRouter requests appear as `openrouter`), `/reset` clears them, `/delete?path=<repo path>` deletes a file like a commit on GitHub, `/file?path=<repo path>` returns a file's current content.
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

Clicks are real mouse events at the element's centre after scrolling it into view; `eval` prints its JSON result; screenshot paths are relative to the steps file, and `selector` clips to one element. JavaScript dialogs (`window.confirm` before an admin action) are printed with their text and accepted; set `"dialogs": "dismiss"` in the plan to cancel them instead. The admin session cookie comes from the login response (for example `curl -c cookies.txt`).
