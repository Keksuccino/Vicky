import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadGitHubLocalizationSnapshot: vi.fn(),
  loadGitHubLocalizedDoc: vi.fn(),
  requestOpenRouterChatCompletion: vi.fn(),
  saveGitHubLocalizedDoc: vi.fn(),
}));

vi.mock("@/lib/openrouter", () => ({
  requestOpenRouterChatCompletion: mocks.requestOpenRouterChatCompletion,
}));

vi.mock("@/lib/github", () => ({
  loadGitHubLocalizationSnapshot: mocks.loadGitHubLocalizationSnapshot,
  loadGitHubLocalizedDoc: mocks.loadGitHubLocalizedDoc,
  saveGitHubLocalizedDoc: mocks.saveGitHubLocalizedDoc,
}));

import {
  translatePageLocalizations,
  type PageLocalizationTranslationEvent,
} from "../page-localization";
import type {
  AutoTranslateLanguage,
  GitHubDocPage,
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

const translatedPayload = JSON.stringify([
  {
    page_display_name: "Startseite",
    page_description: "Willkommensseite.",
    page_content: "## Hallo\n\nWillkommen in der Dokumentation.",
  },
]);

const translatePages = (events: PageLocalizationTranslationEvent[] = []) =>
  translatePageLocalizations({
    apiKey: "openrouter-key",
    config,
    languages: [language],
    localizationPath: "localizations",
    mode: "missing-and-outdated",
    model: "openai/gpt-5.4-mini",
    onEvent: (event) => events.push(event),
    origin: "https://docs.example.com",
    siteTitle: "Vicky Docs",
    sourcePages: [sourcePage],
  });

describe("page localization translations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadGitHubLocalizationSnapshot.mockResolvedValue({
      fetchedAt: "2026-05-04T15:37:03.000Z",
      expiresAt: "2026-05-04T16:37:03.000Z",
      tree: [],
      pages: [],
    });
    mocks.saveGitHubLocalizedDoc.mockResolvedValue({
      localizedRepoPath: "localizations/de/home.md",
      page: sourcePage,
    });
  });

  it("retries a failing page translation before marking it translated", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    mocks.requestOpenRouterChatCompletion
      .mockRejectedValueOnce(new Error("Provider connection dropped"))
      .mockRejectedValueOnce(new Error("Provider connection dropped again"))
      .mockResolvedValueOnce(translatedPayload);

    const result = await translatePages(events);

    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.translatedPages).toBe(1);
    expect(result.failedPages).toBe(0);
    expect(events.filter((event) => event.type === "page-retry")).toHaveLength(2);
    expect(events.find((event) => event.type === "page-success")).toMatchObject({
      attempt: 3,
      type: "page-success",
    });
  });

  it("skips a page after ten retries and keeps the batch result usable", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    mocks.requestOpenRouterChatCompletion.mockRejectedValue(new Error("Provider rejected the request"));

    const result = await translatePages(events);

    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(11);
    expect(result.translatedPages).toBe(0);
    expect(result.failedPages).toBe(1);
    expect(result.failures[0]?.error).toContain("Error: Provider rejected the request");
    expect(events.find((event) => event.type === "page-failed")).toMatchObject({
      attempts: 11,
      type: "page-failed",
    });
  });
});
