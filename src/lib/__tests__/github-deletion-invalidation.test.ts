import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docsSourceCache, renderedMarkdownCache } from "@/lib/cache";
import { clearGitHubBlobMemory } from "@/lib/github-content-store";
import { loadGitHubDoc, loadPublicGitHubDoc, refreshGitHubDocsCache, saveGitHubDoc, toRuntimeConfigCacheKey } from "@/lib/github";
import { transitionGitHubRuntimeCaches } from "@/lib/github-cache-invalidation";
import { loadGitHubLocalizedDoc } from "@/lib/github-localization";
import { readPersistentGitHubRepoIndex } from "@/lib/github-repo-index";
import { searchDocsCorpus } from "@/lib/docs-search";
import { listPersistentRenderedMarkdownCacheEntries } from "@/lib/markdown-render-cache-store";
import { renderGitHubDocPageMarkdown } from "@/lib/markdown-server-renderer";
import type { GitHubRuntimeConfig } from "@/lib/types";

import { createFakeGitHub, type FakeGitHub } from "./fixtures/fake-github-api";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
  cacheEpoch: "deletion-test",
};

const RUNTIME_DIRECTORY_VARIABLES = ["WIKI_DOCS_CACHE_DIR", "WIKI_MARKDOWN_CACHE_DIR"] as const;

describe("GitHub deletion invalidation", () => {
  const previousEnvironment = new Map(RUNTIME_DIRECTORY_VARIABLES.map((name) => [name, process.env[name]]));
  let fake: FakeGitHub;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-deletion-cache-"));
    process.env.WIKI_DOCS_CACHE_DIR = path.join(tempDir, "docs-cache");
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(tempDir, "markdown");
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    renderedMarkdownCache.clear();
    fake = createFakeGitHub();
    fake.setFile("docs/home.md", "---\ntitle: Home\n---\nPublic home");
    fake.setFile("docs/private.md", "---\ntitle: Private\n---\nSecret deleted text");
    fake.setFile("localizations/de/private.md", "---\ntitle: Privat\n---\n\nGeheimer gelöschter Text");
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    renderedMarkdownCache.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes deleted pages from page, index, render, and search caches on refresh", async () => {
    await refreshGitHubDocsCache(config);
    const deletedPage = await loadGitHubDoc(config, { slug: "private" });
    await renderGitHubDocPageMarkdown({ config, languageCode: "en-US", page: deletedPage });
    const localized = await loadGitHubLocalizedDoc({ config, language: { code: "de" }, localizationPath: "localizations", sourcePage: deletedPage });
    expect(localized.status).toBe("current");
    if (!localized.page) {
      throw new Error("Expected the stored translation.");
    }
    await renderGitHubDocPageMarkdown({ config, languageCode: "de", page: localized.page });
    expect(await searchDocsCorpus(config, "secret")).toHaveLength(1);

    fake.deleteFile("docs/private.md");
    fake.deleteFile("localizations/de/private.md");
    await refreshGitHubDocsCache(config);

    await expect(loadGitHubDoc(config, { slug: "private" })).rejects.toThrow("Document not found");
    await expect(loadPublicGitHubDoc(config, { slug: "private" })).rejects.toMatchObject({ status: 404 });
    await expect(searchDocsCorpus(config, "secret")).resolves.toEqual([]);
    await expect(listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(config)}|`)).resolves.toEqual([]);
    const persistedIndex = await readPersistentGitHubRepoIndex(config, path.join(tempDir, "docs-cache"));
    expect(Array.from(persistedIndex?.files.keys() ?? [])).toEqual(["docs/home.md"]);
  });

  it("rejects an in-flight read under the old token and prevents it from repopulating caches", async () => {
    const previousConfig = { ...config, token: "old-token", cacheEpoch: "concurrent-old" };
    const nextConfig = { ...config, token: "new-token", cacheEpoch: "concurrent-new" };
    const releaseBlobs = fake.hold("blob");

    const oldRead = loadGitHubDoc(previousConfig, { slug: "private" }, { bypassCache: true });
    await vi.waitFor(() => expect(fake.count("blob")).toBeGreaterThan(0));
    await transitionGitHubRuntimeCaches(previousConfig, nextConfig);
    fake.setFile("docs/private.md", "---\ntitle: New\n---\n\nNewly authorized content");
    releaseBlobs();

    await expect(oldRead).rejects.toThrow(/authorization changed/i);
    await expect(readPersistentGitHubRepoIndex(previousConfig, path.join(tempDir, "docs-cache"))).resolves.toBeNull();
    const newlyAuthorizedPage = await loadGitHubDoc(nextConfig, { slug: "private" }, { bypassCache: true });
    expect(newlyAuthorizedPage.content).toContain("Newly authorized content");
  });

  it("evicts derived page caches only after a successful save", async () => {
    await refreshGitHubDocsCache(config);
    const homePage = await loadGitHubDoc(config, { slug: "home" });
    await renderGitHubDocPageMarkdown({ config, languageCode: "en-US", page: homePage });
    expect(await searchDocsCorpus(config, "public")).toHaveLength(1);

    await saveGitHubDoc(config, { path: "home.md", content: "Updated saved content" });

    await expect(listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(config)}|`)).resolves.toEqual([]);
    await expect(searchDocsCorpus(config, "public")).resolves.toEqual([]);
    await expect(searchDocsCorpus(config, "updated")).resolves.toHaveLength(1);
    await expect(loadGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Updated saved content\n" });
  });

  it("preserves valid caches when a save fails before GitHub mutates content", async () => {
    await refreshGitHubDocsCache(config);
    const homePage = await loadGitHubDoc(config, { slug: "home" });
    await renderGitHubDocPageMarkdown({ config, languageCode: "en-US", page: homePage });
    fake.intercept((request) =>
      request.kind === "put-contents" ? new Response(JSON.stringify({ message: "GitHub rejected the write" }), { status: 422, headers: { "content-type": "application/json" } }) : undefined,
    );

    await expect(saveGitHubDoc(config, { path: "home.md", content: "Rejected content" })).rejects.toThrow("GitHub rejected");

    await expect(listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(config)}|`)).resolves.toHaveLength(1);
    await expect(loadGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Public home" });
  });
});
