import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestOpenRouterChatCompletion: vi.fn(),
}));

vi.mock("@/lib/openrouter", () => ({
  requestOpenRouterChatCompletion: mocks.requestOpenRouterChatCompletion,
}));

import { translatedDocsPageCache, translatedDocsTitleCache } from "@/lib/cache";

import {
  loadTranslatedDocTreeTitles,
  translateGitHubDocPage,
} from "../auto-translate-server";
import type {
  AutoTranslateLanguage,
  AutoTranslateSettings,
  GitHubDocPage,
  GitHubDocTreeItem,
  GitHubRuntimeConfig,
} from "../types";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const language: AutoTranslateLanguage = {
  name: "German",
  code: "de",
  icon: "de",
};

const settings: AutoTranslateSettings = {
  enabled: true,
  openRouterModel: "openai/gpt-5.4-mini",
  languages: [
    { name: "English (US)", code: "en-US", icon: "us" },
    language,
  ],
};

const sourcePage: GitHubDocPage = {
  path: "install.md",
  slug: "install",
  sha: "source-sha-1",
  title: "Install Guide",
  description: "Package setup instructions.",
  content: "## Setup\n\nInstall the package with npm.",
  markdown: "---\ntitle: Install Guide\ndescription: Package setup instructions.\n---\n\n## Setup\n\nInstall the package with npm.",
  headings: [{ depth: 2, text: "Setup", slug: "setup" }],
  includeInPlaintextExport: true,
  updatedAt: "2026-05-04T15:37:03.000Z",
  updatedBy: "Ada",
};

const treeItems: GitHubDocTreeItem[] = [
  {
    path: "install.md",
    slug: "install",
    name: "Install Guide",
  },
];

const previousTranslationCacheDir = process.env.WIKI_TRANSLATION_CACHE_DIR;
let tempDir = "";

const resetTranslationState = (): void => {
  translatedDocsPageCache.clear();
  translatedDocsTitleCache.clear();
  mocks.requestOpenRouterChatCompletion.mockReset();
};

describe("auto translate persistent cache", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-translations-test-"));
    process.env.WIKI_TRANSLATION_CACHE_DIR = tempDir;
    resetTranslationState();
  });

  afterEach(async () => {
    resetTranslationState();
    if (previousTranslationCacheDir === undefined) {
      delete process.env.WIKI_TRANSLATION_CACHE_DIR;
    } else {
      process.env.WIKI_TRANSLATION_CACHE_DIR = previousTranslationCacheDir;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("reuses persisted page translations after the in-memory cache is cleared", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
        },
      ]),
    );

    const first = await translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage,
    });

    translatedDocsPageCache.clear();

    const second = await translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage,
    });

    expect(first.title).toBe("Installationsanleitung");
    expect(second.title).toBe("Installationsanleitung");
    expect(second.updatedBy).toBe(sourcePage.updatedBy);
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("requests a new page translation when the source content sha changes", async () => {
    mocks.requestOpenRouterChatCompletion
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            page_display_name: "Installationsanleitung",
            page_description: "Deutsche Einrichtung.",
            page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            page_display_name: "Neue Installationsanleitung",
            page_description: "Aktualisierte Einrichtung.",
            page_content: "## Neue Einrichtung\n\nInstalliere das aktualisierte Paket.",
          },
        ]),
      );

    await translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage,
    });

    translatedDocsPageCache.clear();

    const changedSourcePage = {
      ...sourcePage,
      sha: "source-sha-2",
      content: "## New Setup\n\nInstall the updated package.",
      markdown:
        "---\ntitle: Install Guide\ndescription: Package setup instructions.\n---\n\n## New Setup\n\nInstall the updated package.",
    };

    const changed = await translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage: changedSourcePage,
    });

    expect(changed.title).toBe("Neue Installationsanleitung");
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("reuses persisted sidebar title translations after the in-memory cache is cleared", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_slug: "install",
          page_display_name: "Installation",
        },
      ]),
    );

    const first = await loadTranslatedDocTreeTitles({
      apiKey: "key",
      config,
      items: treeItems,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
    });

    translatedDocsTitleCache.clear();

    const second = await loadTranslatedDocTreeTitles({
      apiKey: "key",
      config,
      items: treeItems,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
    });

    expect(first[0]?.name).toBe("Installation");
    expect(second[0]?.name).toBe("Installation");
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });
});
