import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";

import {
  getGitHubDocPageTranslationCacheStatus,
  loadTranslatedDocTreeTitles,
  translateGitHubDocPage,
} from "../auto-translate-server";
import { writePersistentTranslatedPage } from "../translation-cache-store";
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
  enabled: true,
};

const settings: AutoTranslateSettings = {
  enabled: true,
  openRouterModel: "openai/gpt-5.4-mini",
  requestTimeoutMs: 300_000,
  localizationPath: "localizations",
  languages: [
    { name: "English (US)", code: "en-US", icon: "us", enabled: true },
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
let consoleInfoSpy: ReturnType<typeof vi.spyOn> | null = null;

const legacyHashValue = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

const legacyPageTranslationCacheKey = (
  page: GitHubDocPage,
  targetLanguage = language,
  model = settings.openRouterModel,
): string =>
  [
    gitHubRuntimeCacheKey(config),
    "auto-translate",
    "page",
    legacyHashValue({
      languageCode: targetLanguage.code,
      languageName: targetLanguage.name,
      model,
    }),
    page.slug,
    page.sha,
  ].join("|");

const resetTranslationState = (): void => {
  translatedDocsPageCache.clear();
  translatedDocsTitleCache.clear();
  mocks.requestOpenRouterChatCompletion.mockReset();
};

const waitForPendingWork = (delayMs = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

const waitForOpenRouterCalls = async (count: number): Promise<void> => {
  for (let index = 0; index < 50; index += 1) {
    if (mocks.requestOpenRouterChatCompletion.mock.calls.length >= count) {
      return;
    }

    await waitForPendingWork();
  }

  throw new Error(`Timed out waiting for ${count} OpenRouter request(s).`);
};

const createDeferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
};

describe("auto translate persistent cache", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-translations-test-"));
    process.env.WIKI_TRANSLATION_CACHE_DIR = tempDir;
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    resetTranslationState();
  });

  afterEach(async () => {
    consoleInfoSpy?.mockRestore();
    consoleInfoSpy = null;
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

  it("reuses persisted page translations when the source sha changes but markdown content is unchanged", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
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

    const refetchedSourcePage = {
      ...sourcePage,
      sha: "source-sha-2",
      updatedAt: "2026-05-05T08:15:00.000Z",
      updatedBy: "Grace",
    };

    const refetched = await translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage: refetchedSourcePage,
    });

    expect(refetched.title).toBe("Installationsanleitung");
    expect(refetched.sha).toBe(refetchedSourcePage.sha);
    expect(refetched.updatedBy).toBe(refetchedSourcePage.updatedBy);
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("reuses persisted page translations when translation model or language display name changes", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
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

    const reused = await translateGitHubDocPage({
      apiKey: "key",
      config,
      language: { ...language, name: "Deutsch" },
      model: "openai/gpt-5.5",
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage,
    });

    expect(reused.title).toBe("Installationsanleitung");
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("requests a new page translation when the source markdown content changes", async () => {
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

  it("counts cached page translations by source markdown content instead of source sha", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
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

    expect(
      getGitHubDocPageTranslationCacheStatus({
        config,
        language,
        model: settings.openRouterModel,
        pages: [sourcePage],
      }),
    ).toEqual({ totalPages: 1, cachedPages: 1 });

    expect(
      getGitHubDocPageTranslationCacheStatus({
        config,
        language,
        model: settings.openRouterModel,
        pages: [{ ...sourcePage, sha: "source-sha-2" }],
      }),
    ).toEqual({ totalPages: 1, cachedPages: 1 });

    expect(
      getGitHubDocPageTranslationCacheStatus({
        config,
        language,
        model: settings.openRouterModel,
        pages: [
          {
            ...sourcePage,
            sha: "source-sha-2",
            content: "## New Setup\n\nInstall the updated package.",
            markdown:
              "---\ntitle: Install Guide\ndescription: Package setup instructions.\n---\n\n## New Setup\n\nInstall the updated package.",
          },
        ],
      }),
    ).toEqual({ totalPages: 1, cachedPages: 0 });
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("reuses legacy sha-keyed persistent page translations", async () => {
    const legacyTranslatedPage: GitHubDocPage = {
      ...sourcePage,
      title: "Legacy Installation",
      description: "Legacy persisted translation.",
      content: "## Legacy\n\nPersisted translation.",
      markdown:
        "---\ntitle: Legacy Installation\ndescription: Legacy persisted translation.\n---\n\n## Legacy\n\nPersisted translation.",
      headings: [{ depth: 2, text: "Legacy", slug: "legacy" }],
    };

    await expect(writePersistentTranslatedPage(legacyPageTranslationCacheKey(sourcePage), legacyTranslatedPage)).resolves.toBe(
      true,
    );

    const translated = await translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage,
    });

    expect(translated.title).toBe("Legacy Installation");
    expect(mocks.requestOpenRouterChatCompletion).not.toHaveBeenCalled();
    expect(
      getGitHubDocPageTranslationCacheStatus({
        config,
        language,
        model: settings.openRouterModel,
        pages: [sourcePage],
      }),
    ).toEqual({ totalPages: 1, cachedPages: 1 });
  });

  it("does not mark translations cached when the persistent page cache write fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blockedCachePath = path.join(tempDir, "blocked-cache");
    await writeFile(blockedCachePath, "not a directory", "utf8");
    process.env.WIKI_TRANSLATION_CACHE_DIR = blockedCachePath;
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
        },
      ]),
    );

    await expect(
      translateGitHubDocPage({
        apiKey: "key",
        config,
        language,
        model: settings.openRouterModel,
        origin: "https://example.com",
        settings,
        siteTitle: "Vicky Docs",
        sourcePage,
      }),
    ).rejects.toThrow("Failed to persist translated docs page cache.");

    expect(
      getGitHubDocPageTranslationCacheStatus({
        config,
        language,
        model: settings.openRouterModel,
        pages: [sourcePage],
      }),
    ).toEqual({ totalPages: 1, cachedPages: 0 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("dedupes concurrent page translation requests for the same source key", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
        },
      ]),
    );

    const translations = await Promise.all(
      Array.from({ length: 5 }, () =>
        translateGitHubDocPage({
          apiKey: "key",
          config,
          language,
          model: settings.openRouterModel,
          origin: "https://example.com",
          settings,
          siteTitle: "Vicky Docs",
          sourcePage,
        }),
      ),
    );

    expect(translations.map((translation) => translation.title)).toEqual(
      Array.from({ length: 5 }, () => "Installationsanleitung"),
    );
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("queues page translation requests per page and language before cache keys can race", async () => {
    const firstRequest = createDeferred<string>();
    const changedSourcePage: GitHubDocPage = {
      ...sourcePage,
      sha: "source-sha-2",
      description: "Updated package setup instructions.",
      content: "## Setup\n\nInstall the package with pnpm.",
      markdown:
        "---\ntitle: Install Guide\ndescription: Updated package setup instructions.\n---\n\n## Setup\n\nInstall the package with pnpm.",
    };

    mocks.requestOpenRouterChatCompletion
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            page_display_name: "Aktualisierte Installationsanleitung",
            page_description: "Aktualisierte deutsche Einrichtung.",
            page_content: "## Einrichtung\n\nInstalliere das Paket mit pnpm.",
          },
        ]),
      );

    const firstTranslation = translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage,
    });

    await waitForOpenRouterCalls(1);
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);

    const secondTranslation = translateGitHubDocPage({
      apiKey: "key",
      config,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
      sourcePage: changedSourcePage,
    });

    await waitForPendingWork(25);
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);

    firstRequest.resolve(
      JSON.stringify([
        {
          page_display_name: "Installationsanleitung",
          page_description: "Deutsche Einrichtung.",
          page_content: "## Einrichtung\n\nInstalliere das Paket mit npm.",
        },
      ]),
    );

    const [first, second] = await Promise.all([firstTranslation, secondTranslation]);

    expect(first.title).toBe("Installationsanleitung");
    expect(second.title).toBe("Aktualisierte Installationsanleitung");
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

  it("dedupes concurrent sidebar title translation requests for the same title key", async () => {
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(
      JSON.stringify([
        {
          page_slug: "install",
          page_display_name: "Installation",
        },
      ]),
    );

    const translatedTrees = await Promise.all(
      Array.from({ length: 5 }, () =>
        loadTranslatedDocTreeTitles({
          apiKey: "key",
          config,
          items: treeItems,
          language,
          model: settings.openRouterModel,
          origin: "https://example.com",
          settings,
          siteTitle: "Vicky Docs",
        }),
      ),
    );

    expect(translatedTrees.map((tree) => tree[0]?.name)).toEqual(Array.from({ length: 5 }, () => "Installation"));
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("queues sidebar title translation requests per language before title keys can race", async () => {
    const firstRequest = createDeferred<string>();
    const renamedTreeItems: GitHubDocTreeItem[] = [
      {
        ...treeItems[0],
        name: "Setup Guide",
      },
    ];

    mocks.requestOpenRouterChatCompletion
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            page_slug: "install",
            page_display_name: "Einrichtung",
          },
        ]),
      );

    const firstTree = loadTranslatedDocTreeTitles({
      apiKey: "key",
      config,
      items: treeItems,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
    });

    await waitForOpenRouterCalls(1);
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);

    const secondTree = loadTranslatedDocTreeTitles({
      apiKey: "key",
      config,
      items: renamedTreeItems,
      language,
      model: settings.openRouterModel,
      origin: "https://example.com",
      settings,
      siteTitle: "Vicky Docs",
    });

    await waitForPendingWork(25);
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(1);

    firstRequest.resolve(
      JSON.stringify([
        {
          page_slug: "install",
          page_display_name: "Installation",
        },
      ]),
    );

    const [first, second] = await Promise.all([firstTree, secondTree]);

    expect(first[0]?.name).toBe("Installation");
    expect(second[0]?.name).toBe("Einrichtung");
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(2);
  });
});
