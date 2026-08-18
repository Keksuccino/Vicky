import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderedMarkdownCache, translatedDocsPageCache } from "@/lib/cache";
import { clearGitHubDocsCache, toRuntimeConfigCacheKey } from "@/lib/github";
import { assertGitHubRuntimeConfigActive, transitionGitHubRuntimeCaches } from "@/lib/github-cache-invalidation";
import { gitHubDocsLogicalSourceKey, gitHubRuntimeCacheKey, legacyGitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { listPersistentRenderedMarkdownCacheEntries, writePersistentRenderedMarkdown } from "@/lib/markdown-render-cache-store";
import { renderGitHubDocPageMarkdown } from "@/lib/markdown-server-renderer";
import { readPersistentTranslatedPage, writePersistentTranslatedPage } from "@/lib/translation-cache-store";
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
  const previousSnapshotCacheDir = process.env.WIKI_DOCS_SNAPSHOT_DIR;
  const previousTranslationCacheDir = process.env.WIKI_TRANSLATION_CACHE_DIR;
  let cacheDir = "";

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-github-cache-"));
    process.env.WIKI_MARKDOWN_CACHE_DIR = cacheDir;
    process.env.WIKI_DOCS_SNAPSHOT_DIR = path.join(cacheDir, "snapshots");
    process.env.WIKI_TRANSLATION_CACHE_DIR = path.join(cacheDir, "translations");
    renderedMarkdownCache.clear();
    translatedDocsPageCache.clear();
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) {
      delete process.env.WIKI_MARKDOWN_CACHE_DIR;
    } else {
      process.env.WIKI_MARKDOWN_CACHE_DIR = previousCacheDir;
    }
    if (previousTranslationCacheDir === undefined) {
      delete process.env.WIKI_TRANSLATION_CACHE_DIR;
    } else {
      process.env.WIKI_TRANSLATION_CACHE_DIR = previousTranslationCacheDir;
    }
    if (previousSnapshotCacheDir === undefined) {
      delete process.env.WIKI_DOCS_SNAPSHOT_DIR;
    } else {
      process.env.WIKI_DOCS_SNAPSHOT_DIR = previousSnapshotCacheDir;
    }

    renderedMarkdownCache.clear();
    translatedDocsPageCache.clear();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("clears persistent derived caches only for the selected source authorization", async () => {
    const otherConfig = { ...config, repo: "OtherDocs" };
    const translationKey = `${toRuntimeConfigCacheKey(config)}|auto-translate|page|${"a".repeat(32)}|home|content`;
    await renderGitHubDocPageMarkdown({
      config,
      languageCode: "en-US",
      page: createPage("home", "## Home"),
    });
    await renderGitHubDocPageMarkdown({
      config: otherConfig,
      languageCode: "en-US",
      page: createPage("advanced", "## Advanced"),
    });
    await writePersistentTranslatedPage(translationKey, createPage("home", "## Translated"));

    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(2);
    expect(await readPersistentTranslatedPage(translationKey)).not.toBeNull();

    await clearGitHubDocsCache(config);

    const remaining = await listPersistentRenderedMarkdownCacheEntries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.key.startsWith(`${toRuntimeConfigCacheKey(otherConfig)}|`)).toBe(true);
    expect(await readPersistentTranslatedPage(translationKey)).toBeNull();
  });

  it("revokes old config objects after a token/security-epoch transition", async () => {
    const previousConfig = { ...config, token: "old-token", cacheEpoch: "old-epoch" };
    const nextConfig = { ...config, token: "new-token", cacheEpoch: "new-epoch" };
    await renderGitHubDocPageMarkdown({
      config: previousConfig,
      languageCode: "en-US",
      page: createPage("private", "## Private"),
    });

    await transitionGitHubRuntimeCaches(previousConfig, nextConfig);

    expect(() => assertGitHubRuntimeConfigActive(previousConfig)).toThrow(/authorization changed/i);
    expect(() => assertGitHubRuntimeConfigActive(nextConfig)).not.toThrow();
    expect(await listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(previousConfig)}|`)).toHaveLength(0);
  });

  it("physically removes only the selected source's pre-v12 persistent artifacts", async () => {
    const previousConfig = { ...config, token: "legacy-token", cacheEpoch: "legacy-transition-old" };
    const nextConfig = { ...config, token: "rotated-token", cacheEpoch: "legacy-transition-new" };
    const otherConfig = { ...config, repo: "OtherDocs", token: "other-token", cacheEpoch: "other-epoch" };
    const legacyPrefix = `${legacyGitHubRuntimeCacheKey(previousConfig)}|`;
    const otherLegacyPrefix = `${legacyGitHubRuntimeCacheKey(otherConfig)}|`;
    const legacyRenderKey = `${legacyPrefix}markdown-render|v1|private|en-us|old`;
    const legacyTranslationKey = `${legacyPrefix}auto-translate|page|language|private|old`;
    const otherRenderKey = `${otherLegacyPrefix}markdown-render|v1|public|en-us|other`;
    const otherTranslationKey = `${otherLegacyPrefix}auto-translate|page|language|public|other`;
    const nextRenderKey = `${toRuntimeConfigCacheKey(nextConfig)}|markdown-render|v1|private|en-us|new`;
    const nextTranslationKey = `${toRuntimeConfigCacheKey(nextConfig)}|auto-translate|page|language|private|new`;

    await writePersistentRenderedMarkdown(legacyRenderKey, { headings: [], html: "legacy private" });
    await writePersistentRenderedMarkdown(otherRenderKey, { headings: [], html: "other source" });
    await writePersistentRenderedMarkdown(nextRenderKey, { headings: [], html: "current authorization" });
    await writePersistentTranslatedPage(legacyTranslationKey, createPage("private", "legacy private"));
    await writePersistentTranslatedPage(otherTranslationKey, createPage("public", "other source"));
    await writePersistentTranslatedPage(nextTranslationKey, createPage("private", "current authorization"));

    const snapshotDir = process.env.WIKI_DOCS_SNAPSHOT_DIR as string;
    const snapshotPath = (sourceKey: string): string => path.join(snapshotDir, `${createHash("sha256").update(sourceKey).digest("hex")}.json`);
    const legacySnapshotPath = snapshotPath(gitHubDocsLogicalSourceKey(previousConfig));
    const otherSnapshotPath = snapshotPath(gitHubDocsLogicalSourceKey(otherConfig));
    const nextSnapshotPath = snapshotPath(gitHubRuntimeCacheKey(nextConfig));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(legacySnapshotPath, "legacy private snapshot", "utf8");
    await writeFile(otherSnapshotPath, "other source snapshot", "utf8");
    await writeFile(nextSnapshotPath, "current authorization snapshot", "utf8");

    await transitionGitHubRuntimeCaches(previousConfig, nextConfig);

    const renderKeys = (await listPersistentRenderedMarkdownCacheEntries()).map((entry) => entry.key);
    expect(renderKeys).not.toContain(legacyRenderKey);
    expect(renderKeys).toContain(otherRenderKey);
    expect(renderKeys).toContain(nextRenderKey);
    expect(await readPersistentTranslatedPage(legacyTranslationKey)).toBeNull();
    expect(await readPersistentTranslatedPage(otherTranslationKey)).not.toBeNull();
    expect(await readPersistentTranslatedPage(nextTranslationKey)).not.toBeNull();
    await expect(access(legacySnapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(otherSnapshotPath)).resolves.toBeUndefined();
    await expect(access(nextSnapshotPath)).resolves.toBeUndefined();
  });
});
