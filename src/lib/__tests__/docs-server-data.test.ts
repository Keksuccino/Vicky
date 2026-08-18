import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  listMarkdownDocsTreePagesWithTitles: vi.fn(),
  loadGitHubDoc: vi.fn(),
  loadGitHubLocalizationSnapshot: vi.fn(),
  loadGitHubLocalizedDoc: vi.fn(),
  requestOpenRouterChatCompletion: vi.fn(),
  saveGitHubLocalizedDoc: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
  decryptSecret: mocks.decryptSecret,
}));

vi.mock("@/lib/github", () => ({
  listMarkdownDocsTreePagesWithTitles: mocks.listMarkdownDocsTreePagesWithTitles,
  loadGitHubDoc: mocks.loadGitHubDoc,
  loadGitHubLocalizationSnapshot: mocks.loadGitHubLocalizationSnapshot,
  loadGitHubLocalizedDoc: mocks.loadGitHubLocalizedDoc,
  saveGitHubLocalizedDoc: mocks.saveGitHubLocalizedDoc,
}));

vi.mock("@/lib/openrouter", () => ({
  requestOpenRouterChatCompletion: mocks.requestOpenRouterChatCompletion,
}));

vi.mock("@/lib/markdown-server-renderer", () => ({
  renderGitHubDocPageMarkdown: vi.fn(),
}));

import { DEFAULT_STORE } from "../defaults";
import { loadDocsPageForLanguage } from "../docs-server-data";
import type { GitHubDocPage, GitHubRuntimeConfig } from "../types";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const sourcePage: GitHubDocPage = {
  path: "home.md",
  slug: "home",
  sha: "source-sha",
  title: "Home",
  description: "Welcome page.",
  content: "## Hello\n\nWelcome to the docs.",
  markdown: "---\ntitle: Home\ndescription: Welcome page.\n---\n\n## Hello\n\nWelcome to the docs.",
  headings: [{ depth: 2, text: "Hello", slug: "hello" }],
  includeInPlaintextExport: true,
  updatedAt: "2026-05-04T15:37:03.000Z",
  updatedBy: "Ada",
};

const staleLocalizedPage: GitHubDocPage = {
  ...sourcePage,
  sha: "localized-sha",
  title: "Startseite",
  description: "Willkommensseite.",
  content: "## Hallo\n\nWillkommen in der Dokumentation.",
  markdown: "---\ntitle: Startseite\ndescription: Willkommensseite.\n---\n\n## Hallo\n\nWillkommen in der Dokumentation.",
  updatedAt: "2026-05-03T15:37:03.000Z",
  languageCode: "de",
  sourceLanguage: false,
  localizationStatus: "outdated",
};

describe("public docs localization delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadGitHubDoc.mockResolvedValue(sourcePage);
    mocks.loadGitHubLocalizedDoc.mockResolvedValue({
      sourcePage,
      page: staleLocalizedPage,
      status: "outdated",
      localizedRepoPath: "localizations/de/home.md",
    });
  });

  it("serves source fallback without decrypting credentials, invoking AI, or writing an outdated localization", async () => {
    const store = DEFAULT_STORE();
    store.settings.autoTranslate.enabled = true;
    store.settings.autoTranslate.openRouterModel = "openai/gpt-5.4-mini";
    store.settings.openRouter.apiKeyEncrypted = "encrypted-openrouter-key";

    const result = await loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store });

    expect(result.data).toMatchObject({
      title: "Home",
      sourceLanguage: true,
      translationStale: true,
      localizationStatus: "outdated",
    });
    expect(result.contentLanguageCode).toBe("en-US");
    expect(mocks.loadGitHubLocalizedDoc).toHaveBeenCalledTimes(1);
    expect(mocks.decryptSecret).not.toHaveBeenCalled();
    expect(mocks.requestOpenRouterChatCompletion).not.toHaveBeenCalled();
    expect(mocks.saveGitHubLocalizedDoc).not.toHaveBeenCalled();
  });
});
