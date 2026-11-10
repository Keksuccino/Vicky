import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docsSourceCache, renderedMarkdownCache } from "@/lib/cache";
import { clearGitHubBlobMemory } from "@/lib/github-content-store";
import {
  clearMarkdownRenderCache,
  createMarkdownRenderCacheStatus,
  warmMarkdownRenderCache,
} from "@/lib/markdown-render-cache-admin";
import { listPersistentRenderedMarkdownCacheEntries } from "@/lib/markdown-render-cache-store";
import type {
  DocsStore,
  GitHubRuntimeConfig,
} from "@/lib/types";

import { createFakeGitHub } from "./fixtures/fake-github-api";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
  cacheEpoch: "markdown-cache-admin-test",
};

const store = {
  version: 13,
  settings: {
    autoTranslate: {
      enabled: true,
      openRouterModel: "openai/gpt-5.4-mini",
      requestTimeoutMs: 300_000,
      localizationPath: "localizations",
      languages: [
        { name: "English (US)", code: "en-US", icon: "us", enabled: true },
        { name: "German", code: "de", icon: "de", enabled: true },
      ],
    },
  },
} as unknown as DocsStore;

describe("markdown render cache admin helpers", () => {
  const previousCacheDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
  const previousDocsCacheDir = process.env.WIKI_DOCS_CACHE_DIR;
  let cacheDir = "";
  let docsCacheDir = "";

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-markdown-admin-cache-"));
    docsCacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-markdown-admin-docs-"));
    process.env.WIKI_MARKDOWN_CACHE_DIR = cacheDir;
    process.env.WIKI_DOCS_CACHE_DIR = docsCacheDir;
    renderedMarkdownCache.clear();
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    const fake = createFakeGitHub();
    fake.setFile("docs/home.md", "---\ntitle: Home\n---\n## Home");
    fake.setFile("docs/advanced.md", "---\ntitle: Advanced\n---\n## Advanced");
    fake.setFile("localizations/de/home.md", "---\ntitle: Startseite\n---\n## Startseite");
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const [name, value] of [["WIKI_MARKDOWN_CACHE_DIR", previousCacheDir], ["WIKI_DOCS_CACHE_DIR", previousDocsCacheDir]] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    renderedMarkdownCache.clear();
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    await rm(cacheDir, { recursive: true, force: true });
    await rm(docsCacheDir, { recursive: true, force: true });
  });

  it("caches only missing current source and translated HTML variants", async () => {
    const initialStatus = await createMarkdownRenderCacheStatus({ config, store });
    expect(initialStatus.totalPages).toBe(2);
    expect(initialStatus.totalVariants).toBe(3);
    expect(initialStatus.cachedVariants).toBe(0);

    const firstWarm = await warmMarkdownRenderCache({ config, store });
    expect(firstWarm.renderedVariants).toBe(3);
    expect(firstWarm.skippedVariants).toBe(0);
    expect(firstWarm.failedVariants).toBe(0);
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);
    const warmedStatus = await createMarkdownRenderCacheStatus({ config, store });
    expect(warmedStatus.cacheDirectory).toBe(cacheDir);
    expect(warmedStatus.currentSourceEntries).toBe(3);
    expect(warmedStatus.globalEntries).toBe(3);
    expect(warmedStatus.otherSourceEntries).toBe(0);

    const secondWarm = await warmMarkdownRenderCache({ config, store });
    expect(secondWarm.renderedVariants).toBe(0);
    expect(secondWarm.skippedVariants).toBe(3);
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);

    const homeClear = await clearMarkdownRenderCache({ config, slug: "home" });
    expect(homeClear).toMatchObject({ clearedEntries: 2, scope: "page", slug: "home" });

    if (process.platform !== "win32") {
      const pagesDir = path.join(cacheDir, "pages");
      const remainingPageFiles = await readdir(pagesDir);
      expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
      expect((await stat(pagesDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(cacheDir, "metadata.json"))).mode & 0o777).toBe(0o600);
      await Promise.all(remainingPageFiles.map(async (fileName) => expect((await stat(path.join(pagesDir, fileName))).mode & 0o777).toBe(0o600)));
    }

    const afterHomeClear = await createMarkdownRenderCacheStatus({ config, store });
    expect(afterHomeClear.cachedVariants).toBe(1);
    expect(afterHomeClear.lastMutation).toMatchObject({
      deletedEntries: 2,
      reason: "admin-clear-page",
      scope: "page",
      target: "home",
    });
    expect(afterHomeClear.pages.find((page) => page.slug === "home")?.cachedVariants).toBe(0);
    expect(afterHomeClear.pages.find((page) => page.slug === "advanced")?.cachedVariants).toBe(1);

    const allClear = await clearMarkdownRenderCache({ config });
    expect(allClear).toMatchObject({ clearedEntries: 1, scope: "all" });
    const afterAllClear = await createMarkdownRenderCacheStatus({ config, store });
    expect(afterAllClear.cachedVariants).toBe(0);
    expect(afterAllClear.lastMutation).toMatchObject({
      deletedEntries: 1,
      reason: "admin-clear-current-source",
      scope: "all",
    });
  });
});
