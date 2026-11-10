import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadGitHubLocalizedPages: vi.fn(),
  listMarkdownDocsTreePagesWithTitles: vi.fn(),
  toRuntimeConfigCacheKey: vi.fn(),
}));

vi.mock("@/lib/github", () => ({
  listMarkdownDocsTreePagesWithTitles: mocks.listMarkdownDocsTreePagesWithTitles,
  toRuntimeConfigCacheKey: mocks.toRuntimeConfigCacheKey,
}));

vi.mock("@/lib/github-localization", () => ({
  loadGitHubLocalizedPages: mocks.loadGitHubLocalizedPages,
}));

import { docsSearchCorpusCache } from "@/lib/cache";

import { searchDocsCorpus } from "../docs-search";
import type { GitHubDocPage, GitHubRuntimeConfig } from "../types";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const sourcePage: GitHubDocPage = {
  path: "install.md",
  slug: "install",
  sha: "source-sha",
  title: "Install Guide",
  description: "Package setup instructions.",
  content: "## Setup\n\nInstall the package with npm.",
  markdown: "---\ntitle: Install Guide\n---\n\n## Setup\n\nInstall the package with npm.",
  headings: [{ depth: 2, text: "Setup", slug: "setup" }],
  includeInPlaintextExport: true,
};

const translatedPage: GitHubDocPage = {
  ...sourcePage,
  title: "Installationsanleitung",
  description: "Deutsche Einrichtung.",
  content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
  markdown: "---\ntitle: Installationsanleitung\n---\n\n## Einrichtung\n\nInstalliere das Paket mit npm.",
  headings: [{ depth: 2, text: "Einrichtung", slug: "einrichtung" }],
};

describe("docs search", () => {
  beforeEach(() => {
    docsSearchCorpusCache.clear();
    mocks.loadGitHubLocalizedPages.mockReset();
    mocks.listMarkdownDocsTreePagesWithTitles.mockReset();
    mocks.toRuntimeConfigCacheKey.mockReset();

    mocks.listMarkdownDocsTreePagesWithTitles.mockResolvedValue({
      items: [{ path: sourcePage.path, slug: sourcePage.slug, name: sourcePage.title }],
      pages: [sourcePage],
    });
    mocks.toRuntimeConfigCacheKey.mockReturnValue("runtime-config");
  });

  it("uses cached translated pages for translated search when available", async () => {
    const language = { name: "German", code: "de", icon: "de", enabled: true };
    mocks.loadGitHubLocalizedPages.mockResolvedValue({ complete: true, pages: [translatedPage] });

    const results = await searchDocsCorpus(config, "installiere", {
      translation: {
        language,
        localizationPath: "localizations",
      },
    });

    expect(results[0]).toMatchObject({
      path: "install.md",
      title: "Installationsanleitung",
      excerpt: "Einrichtung Installiere das Paket mit npm.",
      anchor: "einrichtung",
    });
    expect(mocks.loadGitHubLocalizedPages).toHaveBeenCalledWith({ config, languageCode: "de", localizationPath: "localizations" });

    await searchDocsCorpus(config, "paket", { translation: { language, localizationPath: "localizations" } });
    expect(mocks.loadGitHubLocalizedPages).toHaveBeenCalledTimes(1);
    // The source and the German corpus count toward the cache's byte bound.
    expect(docsSearchCorpusCache.size).toBe(2);
    expect(docsSearchCorpusCache.approximateBytes).toBeGreaterThan(2 * Buffer.byteLength(translatedPage.content));
  });

  it("rebuilds a localized corpus per search while the language is still loading", async () => {
    const translation = { language: { name: "German", code: "de", icon: "de", enabled: true }, localizationPath: "localizations" };
    mocks.loadGitHubLocalizedPages.mockResolvedValueOnce({ complete: false, pages: [] }).mockResolvedValue({ complete: true, pages: [translatedPage] });

    await expect(searchDocsCorpus(config, "installiere", { translation })).resolves.toEqual([]);
    await expect(searchDocsCorpus(config, "installiere", { translation })).resolves.toEqual([expect.objectContaining({ title: "Installationsanleitung" })]);
    await searchDocsCorpus(config, "paket", { translation });

    expect(mocks.loadGitHubLocalizedPages).toHaveBeenCalledTimes(2);
  });

  it("does not create translations while searching translated content", async () => {
    mocks.loadGitHubLocalizedPages.mockResolvedValue({ complete: true, pages: [] });

    const results = await searchDocsCorpus(config, "einrichtung", {
      translation: {
        language: { name: "German", code: "de", icon: "de", enabled: true },
        localizationPath: "localizations",
      },
    });

    expect(results).toEqual([]);
    expect(mocks.loadGitHubLocalizedPages).toHaveBeenCalledTimes(1);
  });
});
