import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderedMarkdownCache } from "@/lib/cache";
import {
  clearMarkdownRenderCache,
  createMarkdownRenderCacheStatus,
  warmMarkdownRenderCache,
} from "@/lib/markdown-render-cache-admin";
import { listPersistentRenderedMarkdownCacheEntries } from "@/lib/markdown-render-cache-store";
import type {
  DocsStore,
  GitHubDocPage,
  GitHubRuntimeConfig,
} from "@/lib/types";

const listMarkdownDocsTreePagesWithTitlesMock = vi.fn();
const loadGitHubLocalizationSnapshotMock = vi.fn();

vi.mock("@/lib/github", () => ({
  loadGitHubLocalizationSnapshot: (...args: unknown[]) => loadGitHubLocalizationSnapshotMock(...args),
  listMarkdownDocsTreePagesWithTitles: (...args: unknown[]) => listMarkdownDocsTreePagesWithTitlesMock(...args),
  toRuntimeConfigCacheKey: (config: GitHubRuntimeConfig) =>
    [config.owner, config.repo, config.branch, config.docsPath].join("|"),
}));

const config: GitHubRuntimeConfig = {
  owner: "Keksuccino",
  repo: "Docs",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const store = {
  version: 11,
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

const createPage = (slug: string, content: string): GitHubDocPage => ({
  path: `${slug}.md`,
  slug,
  sha: `${slug}-sha`,
  title: slug === "home" ? "Home" : "Advanced",
  description: "",
  content,
  markdown: content,
  headings: [],
  includeInPlaintextExport: true,
});

describe("markdown render cache admin helpers", () => {
  const previousCacheDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
  let cacheDir = "";
  const pages = [createPage("home", "## Home"), createPage("advanced", "## Advanced")];

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-markdown-admin-cache-"));
    process.env.WIKI_MARKDOWN_CACHE_DIR = cacheDir;
    renderedMarkdownCache.clear();
    vi.clearAllMocks();
    listMarkdownDocsTreePagesWithTitlesMock.mockResolvedValue({ items: [], pages });
    loadGitHubLocalizationSnapshotMock.mockResolvedValue({
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tree: [],
      pages: [
        {
          ...pages[0],
          content: "## Startseite",
          markdown: "## Startseite",
          title: "Startseite",
        },
      ],
    });
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) {
      delete process.env.WIKI_MARKDOWN_CACHE_DIR;
    } else {
      process.env.WIKI_MARKDOWN_CACHE_DIR = previousCacheDir;
    }

    renderedMarkdownCache.clear();
    await rm(cacheDir, { recursive: true, force: true });
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

    const secondWarm = await warmMarkdownRenderCache({ config, store });
    expect(secondWarm.renderedVariants).toBe(0);
    expect(secondWarm.skippedVariants).toBe(3);
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);

    const homeClear = await clearMarkdownRenderCache({ config, slug: "home" });
    expect(homeClear).toMatchObject({ clearedEntries: 2, scope: "page", slug: "home" });

    const afterHomeClear = await createMarkdownRenderCacheStatus({ config, store });
    expect(afterHomeClear.cachedVariants).toBe(1);
    expect(afterHomeClear.pages.find((page) => page.slug === "home")?.cachedVariants).toBe(0);
    expect(afterHomeClear.pages.find((page) => page.slug === "advanced")?.cachedVariants).toBe(1);

    const allClear = await clearMarkdownRenderCache({ config });
    expect(allClear).toMatchObject({ clearedEntries: 1, scope: "all" });
    expect((await createMarkdownRenderCacheStatus({ config, store })).cachedVariants).toBe(0);
  });
});
