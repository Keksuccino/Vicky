// Testing harness: preload for running the real server against the in-memory fake GitHub API of
// the test suite instead of api.github.com (`NODE_OPTIONS=--import=<this file>`). The GitHub
// client resolves `globalThis.fetch` per call, so every GitHub request reaches the fake; nothing
// else is intercepted. Needs Node.js with TypeScript type stripping (22.18 or newer).
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
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.github.com") {
    return realFetch(input, init);
  }

  const requestIndex = fake.requests.length;
  const response = await fake.fetch(url, init);
  if (logPath) {
    const request = fake.requests[requestIndex];
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), kind: request?.kind, target: request?.target })}\n`);
  }
  return response;
};

// Control endpoint: `/` reports request counts by kind, `/reset` clears them, and
// `/delete?path=<repo path>` removes a file as a commit on GitHub would.
http
  .createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/reset") {
      fake.resetRequests();
    } else if (url.pathname === "/delete") {
      fake.deleteFile(url.searchParams.get("path") ?? "");
    }

    const counts = {};
    for (const entry of fake.requests) {
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ total: fake.requests.length, counts }));
  })
  .listen(Number(process.env.FAKE_GITHUB_CONTROL_PORT ?? 39190), "127.0.0.1")
  .unref();
