import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderedMarkdownCache } from "@/lib/cache";
import { clearGitHubDocsCache } from "@/lib/github";
import { listPersistentRenderedMarkdownCacheEntries } from "@/lib/markdown-render-cache-store";
import { renderGitHubDocPageMarkdown } from "@/lib/markdown-server-renderer";
import type { GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

const config: GitHubRuntimeConfig = {
  owner: "Keksuccino",
  repo: "Docs",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const createPage = (slug: string, content: string): GitHubDocPage => ({
  path: `${slug}.md`,
  slug,
  sha: `${slug}-sha`,
  title: slug,
  description: "",
  content,
  markdown: content,
  headings: [],
  includeInPlaintextExport: true,
});

describe("GitHub docs cache invalidation", () => {
  const previousCacheDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
  let cacheDir = "";

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-github-cache-"));
    process.env.WIKI_MARKDOWN_CACHE_DIR = cacheDir;
    renderedMarkdownCache.clear();
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

  it("does not delete rendered Markdown HTML when docs source caches are cleared", async () => {
    await renderGitHubDocPageMarkdown({
      config,
      languageCode: "en-US",
      page: createPage("home", "## Home"),
    });
    await renderGitHubDocPageMarkdown({
      config,
      languageCode: "en-US",
      page: createPage("advanced", "## Advanced"),
    });

    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(2);

    await clearGitHubDocsCache(config);

    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(2);

    await clearGitHubDocsCache();

    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(2);
  });
});
