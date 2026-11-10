// Testing harness: preload for running the real server against the in-memory fake GitHub API of
// the test suite instead of api.github.com (`NODE_OPTIONS=--import=<this file>`), and against a
// fake OpenRouter endpoint instead of openrouter.ai. The GitHub client and the OpenRouter client
// resolve `globalThis.fetch` per call, so every request to those two hosts reaches a fake;
// nothing else is intercepted. Needs Node.js with TypeScript type stripping (22.18 or newer).
// See TESTING_GUIDELINES.md.
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { createFakeGitHub } from "../src/lib/__tests__/fixtures/fake-github-api.ts";

const SAMPLE_SEED = [
  { path: "docs/home.md", content: "---\ntitle: Home\n---\n\nWelcome to the docs.\n" },
  { path: "docs/guide/setup.md", content: "---\ntitle: Setup\n---\n\n## Install\n\nInstall the package.\n" },
  { path: "localizations/de/home.md", content: "---\ntitle: Startseite\n---\n\nWillkommen in der Doku.\n" },
  { path: "localizations/de/guide/setup.md", content: "---\ntitle: Einrichtung\n---\n\n## Installieren\n\nInstalliere das Paket.\n" },
];

const titleFromPath = (repoPath) =>
  path.posix.basename(repoPath).replace(/\.mdx?$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

/** Synthetic page of about `size` bytes; translations get their language code in the title. */
const syntheticContent = (repoPath, size) => {
  const language = /^localizations\/([^/]+)\//.exec(repoPath)?.[1];
  let markdown = `---\ntitle: ${titleFromPath(repoPath)}${language ? ` (${language})` : ""}\n---\n\n## ${language ?? "en"} overview\n\n`;
  while (markdown.length < size) {
    markdown += `Paragraph of ${repoPath} in ${language ?? "en"}: lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\n`;
  }
  return markdown;
};

// Entries are committed in order, one commit each, so a later entry for a source page makes
// earlier translations of it outdated.
const seed = process.env.FAKE_GITHUB_SEED ? JSON.parse(readFileSync(process.env.FAKE_GITHUB_SEED, "utf8")) : SAMPLE_SEED;
const fake = createFakeGitHub({ owner: process.env.FAKE_GITHUB_OWNER, repo: process.env.FAKE_GITHUB_REPO, branch: process.env.FAKE_GITHUB_BRANCH });
for (const entry of seed) {
  fake.setFile(entry.path, entry.content ?? syntheticContent(entry.path, entry.size ?? 2_000));
}
fake.setLatency(Number(process.env.FAKE_GITHUB_LATENCY_MS ?? 0));

const logPath = process.env.FAKE_GITHUB_LOG;
const appendLog = (entry) => {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }
};

// Fake OpenRouter: a "translation" appends the target language to the title and puts a note
// above the unchanged content. `FAKE_OPENROUTER_LATENCY_MS` delays every answer;
// `FAKE_OPENROUTER_RATE_LIMITS=<n>` answers the first n requests with a 429 and
// `retry-after: FAKE_OPENROUTER_RETRY_AFTER_S` (default 2), to watch the job's backoff.
const openRouter = {
  latencyMs: Number(process.env.FAKE_OPENROUTER_LATENCY_MS ?? 0),
  rateLimitsLeft: Number(process.env.FAKE_OPENROUTER_RATE_LIMITS ?? 0),
  requests: 0,
  retryAfterSeconds: process.env.FAKE_OPENROUTER_RETRY_AFTER_S ?? "2",
};

const answerOpenRouter = async (init) => {
  openRouter.requests += 1;
  if (openRouter.latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, openRouter.latencyMs));
  }
  if (openRouter.rateLimitsLeft > 0) {
    openRouter.rateLimitsLeft -= 1;
    appendLog({ kind: "openrouter", status: 429 });
    return new Response(JSON.stringify({ error: { message: "Rate limit exceeded (fake OpenRouter)" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": openRouter.retryAfterSeconds },
    });
  }

  const prompt = JSON.parse(String(init?.body ?? "{}")).messages?.at(-1)?.content ?? "";
  const language = /^Translate the following page to (.+?)\. /.exec(prompt)?.[1] ?? "the target language";
  const pages = JSON.parse(prompt.slice(prompt.indexOf("\n\n[") + 2));
  const translated = pages.map((page) => ({
    page_display_name: `${page.page_display_name} (${language})`,
    page_description: page.page_description,
    page_content: `> Translated to ${language} by the fake OpenRouter endpoint.\n\n${page.page_content}`,
  }));
  appendLog({ kind: "openrouter", status: 200, target: language });
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(translated) } }] }), { status: 200, headers: { "content-type": "application/json" } });
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "openrouter.ai") {
    return answerOpenRouter(init);
  }
  if (url.hostname !== "api.github.com") {
    return realFetch(input, init);
  }

  const requestIndex = fake.requests.length;
  const response = await fake.fetch(url, init);
  const request = fake.requests[requestIndex];
  appendLog({ kind: request?.kind, target: request?.target });
  return response;
};

// Control endpoint: `/` reports request counts by kind (OpenRouter requests as `openrouter`),
// `/reset` clears them, `/delete?path=<repo path>` removes a file as a commit on GitHub would,
// and `/file?path=<repo path>` returns a file's current content.
http
  .createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/file") {
      const bytes = fake.files.get(url.searchParams.get("path") ?? "");
      response.statusCode = bytes ? 200 : 404;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(bytes ?? "");
      return;
    }
    if (url.pathname === "/reset") {
      fake.resetRequests();
      openRouter.requests = 0;
    } else if (url.pathname === "/delete") {
      fake.deleteFile(url.searchParams.get("path") ?? "");
    }

    const counts = { ...(openRouter.requests > 0 ? { openrouter: openRouter.requests } : {}) };
    for (const entry of fake.requests) {
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ total: fake.requests.length, counts }));
  })
  .listen(Number(process.env.FAKE_GITHUB_CONTROL_PORT ?? 39190), "127.0.0.1")
  .unref();
