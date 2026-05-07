import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCachedTranslatedDocPage: vi.fn(),
  listMarkdownDocsTree: vi.fn(),
  loadGitHubDoc: vi.fn(),
  toRuntimeConfigCacheKey: vi.fn(),
}));

vi.mock("@/lib/auto-translate-server", () => ({
  getCachedTranslatedDocPage: mocks.getCachedTranslatedDocPage,
}));

vi.mock("@/lib/github", () => ({
  listMarkdownDocsTree: mocks.listMarkdownDocsTree,
  loadGitHubDoc: mocks.loadGitHubDoc,
  toRuntimeConfigCacheKey: mocks.toRuntimeConfigCacheKey,
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
    mocks.getCachedTranslatedDocPage.mockReset();
    mocks.listMarkdownDocsTree.mockReset();
    mocks.loadGitHubDoc.mockReset();
    mocks.toRuntimeConfigCacheKey.mockReset();

    mocks.listMarkdownDocsTree.mockResolvedValue([{ path: sourcePage.path, slug: sourcePage.slug, name: sourcePage.title }]);
    mocks.loadGitHubDoc.mockResolvedValue(sourcePage);
    mocks.toRuntimeConfigCacheKey.mockReturnValue("runtime-config");
  });

  it("uses cached translated pages for translated search when available", async () => {
    const language = { name: "German", code: "de" };
    mocks.getCachedTranslatedDocPage.mockReturnValue(translatedPage);

    const results = await searchDocsCorpus(config, "installiere", {
      translation: {
        language,
        model: "openai/gpt-5.4-mini",
      },
    });

    expect(results[0]).toMatchObject({
      path: "install.md",
      title: "Installationsanleitung",
      excerpt: "Einrichtung Installiere das Paket mit npm.",
      anchor: "einrichtung",
    });
    expect(mocks.getCachedTranslatedDocPage).toHaveBeenCalledWith(
      config,
      sourcePage,
      language,
      "openai/gpt-5.4-mini",
    );
  });

  it("does not create translations while searching translated content", async () => {
    mocks.getCachedTranslatedDocPage.mockReturnValue(null);

    const results = await searchDocsCorpus(config, "einrichtung", {
      translation: {
        language: { name: "German", code: "de" },
        model: "openai/gpt-5.4-mini",
      },
    });

    expect(results).toEqual([]);
    expect(mocks.getCachedTranslatedDocPage).toHaveBeenCalledTimes(1);
  });
});
