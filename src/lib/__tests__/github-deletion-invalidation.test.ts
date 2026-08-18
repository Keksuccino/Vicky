import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubState = vi.hoisted(() => ({
  contentGate: null as Promise<void> | null,
  contentStarted: null as (() => void) | null,
  files: new Map<string, { markdown: string; sha: string }>(),
  writeError: null as Error | null,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    repos = {
      getBranch: vi.fn(async () => ({
        data: { commit: { sha: "branch-sha", commit: { tree: { sha: "tree-sha" } } } },
      })),
      getContent: vi.fn(async ({ path: repoPath }: { path: string }) => {
        githubState.contentStarted?.();
        await githubState.contentGate;
        const file = githubState.files.get(repoPath);
        if (!file) {
          throw Object.assign(new Error("Document not found."), { status: 404 });
        }

        return {
          data: {
            type: "file",
            content: Buffer.from(file.markdown, "utf8").toString("base64"),
            encoding: "base64",
            sha: file.sha,
          },
        };
      }),
      listCommits: vi.fn(async () => ({ data: [] })),
      createOrUpdateFileContents: vi.fn(async ({ content, path: repoPath }: { content: string; path: string }) => {
        if (githubState.writeError) {
          throw githubState.writeError;
        }

        const sha = `saved-${Date.now()}`;
        githubState.files.set(repoPath, { markdown: Buffer.from(content, "base64").toString("utf8"), sha });
        return { data: { commit: { sha: "commit-sha" }, content: { sha } } };
      }),
    };

    git = {
      getTree: vi.fn(async () => ({
        data: {
          tree: Array.from(githubState.files, ([repoPath, file]) => ({
            path: repoPath,
            sha: file.sha,
            type: "blob",
          })),
        },
      })),
    };
  },
}));

import { renderedMarkdownCache, translatedDocsPageCache } from "@/lib/cache";
import { readPersistentGitHubDocsSnapshot } from "@/lib/docs-snapshot-store";
import { loadGitHubDoc, loadGitHubLocalizationSnapshot, refreshGitHubDocsCache, saveGitHubDoc, toRuntimeConfigCacheKey } from "@/lib/github";
import { transitionGitHubRuntimeCaches } from "@/lib/github-cache-invalidation";
import { searchDocsCorpus } from "@/lib/docs-search";
import { listPersistentRenderedMarkdownCacheEntries } from "@/lib/markdown-render-cache-store";
import { renderGitHubDocPageMarkdown } from "@/lib/markdown-server-renderer";
import { readPersistentTranslatedPage, writePersistentTranslatedPage } from "@/lib/translation-cache-store";
import type { GitHubRuntimeConfig } from "@/lib/types";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
  cacheEpoch: "deletion-test",
};

describe("GitHub deletion invalidation", () => {
  const previousSnapshotDir = process.env.WIKI_DOCS_SNAPSHOT_DIR;
  const previousMarkdownDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
  const previousTranslationDir = process.env.WIKI_TRANSLATION_CACHE_DIR;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-deletion-cache-"));
    process.env.WIKI_DOCS_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(tempDir, "markdown");
    process.env.WIKI_TRANSLATION_CACHE_DIR = path.join(tempDir, "translations");
    renderedMarkdownCache.clear();
    translatedDocsPageCache.clear();
    githubState.contentGate = null;
    githubState.contentStarted = null;
    githubState.writeError = null;
    githubState.files = new Map([
      ["docs/home.md", { markdown: "---\ntitle: Home\n---\n\nPublic home", sha: "home-sha" }],
      ["docs/private.md", { markdown: "---\ntitle: Private\n---\n\nSecret deleted text", sha: "private-sha" }],
      ["localizations/de/private.md", { markdown: "---\ntitle: Privat\n---\n\nGeheimer gelöschter Text", sha: "private-de-sha" }],
    ]);
  });

  afterEach(async () => {
    for (const [name, value] of [
      ["WIKI_DOCS_SNAPSHOT_DIR", previousSnapshotDir],
      ["WIKI_MARKDOWN_CACHE_DIR", previousMarkdownDir],
      ["WIKI_TRANSLATION_CACHE_DIR", previousTranslationDir],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    renderedMarkdownCache.clear();
    translatedDocsPageCache.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes deleted pages from page, snapshot, render, translation, and search caches on refresh", async () => {
    await refreshGitHubDocsCache(config);
    const deletedPage = await loadGitHubDoc(config, { slug: "private" });
    await renderGitHubDocPageMarkdown({ config, languageCode: "en-US", page: deletedPage });
    const localizedSnapshot = await loadGitHubLocalizationSnapshot({
      config,
      language: { code: "de" },
      localizationPath: "localizations",
      sourcePages: [deletedPage],
    });
    await renderGitHubDocPageMarkdown({ config, languageCode: "de", page: localizedSnapshot.pages[0] });
    const translationKey = `${toRuntimeConfigCacheKey(config)}|auto-translate|page|${"a".repeat(32)}|private|content`;
    await writePersistentTranslatedPage(translationKey, deletedPage);
    expect(await searchDocsCorpus(config, "secret")).toHaveLength(1);

    githubState.files.delete("docs/private.md");
    githubState.files.delete("localizations/de/private.md");
    await refreshGitHubDocsCache(config);

    await expect(loadGitHubDoc(config, { slug: "private" })).rejects.toThrow("Document not found");
    await expect(searchDocsCorpus(config, "secret")).resolves.toEqual([]);
    await expect(readPersistentTranslatedPage(translationKey)).resolves.toBeNull();
    await expect(listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(config)}|`)).resolves.toEqual([]);
    await expect(readPersistentGitHubDocsSnapshot(config)).resolves.toMatchObject({
      pages: [{ slug: "home" }],
      tree: [{ slug: "home" }],
    });
  });

  it("rejects an in-flight read under the old token and prevents it from repopulating caches", async () => {
    const previousConfig = { ...config, token: "old-token", cacheEpoch: "concurrent-old" };
    const nextConfig = { ...config, token: "new-token", cacheEpoch: "concurrent-new" };
    let releaseContent!: () => void;
    let markStarted!: () => void;
    githubState.contentGate = new Promise<void>((resolve) => {
      releaseContent = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    githubState.contentStarted = markStarted;

    const oldRead = loadGitHubDoc(previousConfig, { slug: "private" }, { bypassCache: true });
    await started;
    await transitionGitHubRuntimeCaches(previousConfig, nextConfig);
    githubState.files.set("docs/private.md", { markdown: "---\ntitle: New\n---\n\nNewly authorized content", sha: "new-sha" });
    releaseContent();

    await expect(oldRead).rejects.toThrow(/authorization changed/i);
    const newlyAuthorizedPage = await loadGitHubDoc(nextConfig, { slug: "private" }, { bypassCache: true });
    expect(newlyAuthorizedPage.sha).toBe("new-sha");
    expect(newlyAuthorizedPage.content).toContain("Newly authorized content");
  });

  it("evicts derived page caches only after a successful save", async () => {
    await refreshGitHubDocsCache(config);
    const homePage = await loadGitHubDoc(config, { slug: "home" });
    await renderGitHubDocPageMarkdown({ config, languageCode: "en-US", page: homePage });
    const translationKey = `${toRuntimeConfigCacheKey(config)}|auto-translate|page|${"b".repeat(32)}|home|content`;
    await writePersistentTranslatedPage(translationKey, homePage);
    expect(await searchDocsCorpus(config, "public")).toHaveLength(1);

    await saveGitHubDoc(config, { path: "home.md", content: "Updated saved content" });

    await expect(readPersistentTranslatedPage(translationKey)).resolves.toBeNull();
    await expect(listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(config)}|`)).resolves.toEqual([]);
    await expect(searchDocsCorpus(config, "public")).resolves.toEqual([]);
    await expect(searchDocsCorpus(config, "updated")).resolves.toHaveLength(1);
    await expect(loadGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Updated saved content" });
  });

  it("preserves valid caches when a save fails before GitHub mutates content", async () => {
    await refreshGitHubDocsCache(config);
    const homePage = await loadGitHubDoc(config, { slug: "home" });
    await renderGitHubDocPageMarkdown({ config, languageCode: "en-US", page: homePage });
    const translationKey = `${toRuntimeConfigCacheKey(config)}|auto-translate|page|${"c".repeat(32)}|home|content`;
    await writePersistentTranslatedPage(translationKey, homePage);
    githubState.writeError = new Error("GitHub rejected the write");

    await expect(saveGitHubDoc(config, { path: "home.md", content: "Rejected content" })).rejects.toThrow("GitHub rejected");

    await expect(readPersistentTranslatedPage(translationKey)).resolves.not.toBeNull();
    await expect(listPersistentRenderedMarkdownCacheEntries(`${toRuntimeConfigCacheKey(config)}|`)).resolves.toHaveLength(1);
    await expect(loadGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Public home" });
  });
});
