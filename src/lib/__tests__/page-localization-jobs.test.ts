import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listMarkdownDocsTreePagesWithTitles: vi.fn(),
  translatePageLocalizations: vi.fn(),
}));

vi.mock("@/lib/github", () => ({
  listMarkdownDocsTreePagesWithTitles: mocks.listMarkdownDocsTreePagesWithTitles,
}));

vi.mock("@/lib/page-localization", () => ({
  translatePageLocalizations: mocks.translatePageLocalizations,
}));

import { getLatestPageLocalizationJob, startPageLocalizationJob } from "../page-localization-jobs";
import type { AutoTranslateLanguage, GitHubRuntimeConfig } from "../types";

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

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
};

describe("page localization background jobs", () => {
  it("deduplicates overlapping admin starts onto the active job", async () => {
    const sourceLoad = createDeferred<{ items: []; pages: [] }>();
    mocks.listMarkdownDocsTreePagesWithTitles.mockReturnValueOnce(sourceLoad.promise);
    mocks.translatePageLocalizations.mockResolvedValue({
      totalPages: 0,
      cachedPages: 0,
      requestedPages: 0,
      translatedPages: 0,
      failedPages: 0,
      failures: [],
    });
    const input = {
      apiKey: "openrouter-key",
      config,
      languages: [language],
      localizationPath: "localizations",
      mode: "missing-and-outdated" as const,
      model: "openai/gpt-5.4-mini",
      origin: "https://docs.example.com",
      requestTimeoutMs: 60_000,
      siteTitle: "Vicky Docs",
    };

    const first = startPageLocalizationJob(input);
    const duplicate = startPageLocalizationJob(input);

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.status).toBe("running");
    expect(mocks.listMarkdownDocsTreePagesWithTitles).toHaveBeenCalledTimes(1);

    sourceLoad.resolve({ items: [], pages: [] });
    await vi.waitFor(() => expect(mocks.translatePageLocalizations).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getLatestPageLocalizationJob()?.status).toBe("completed"));
  });
});
