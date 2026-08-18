import { beforeEach, describe, expect, it, vi } from "vitest";

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
import type { PageLocalizationRequestResult, PageLocalizationTranslationEvent } from "../page-localization";
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
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("vicky.pageLocalization.jobState")];
  });

  it("deduplicates overlapping admin starts onto the active job", async () => {
    const sourceLoad = createDeferred<{ items: []; pages: [] }>();
    mocks.listMarkdownDocsTreePagesWithTitles.mockReturnValueOnce(sourceLoad.promise);
    mocks.translatePageLocalizations.mockResolvedValue({
      totalPages: 0,
      cachedPages: 0,
      requestedPages: 0,
      translatedPages: 0,
      uploadedPages: 0,
      translationFailedPages: 0,
      uploadFailedPages: 0,
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
    expect(duplicate.phase).toBe("queued");

    await vi.waitFor(() => expect(mocks.listMarkdownDocsTreePagesWithTitles).toHaveBeenCalledTimes(1));
    sourceLoad.resolve({ items: [], pages: [] });
    await vi.waitFor(() => expect(mocks.translatePageLocalizations).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(getLatestPageLocalizationJob()?.status).toBe("completed"));
  });

  it("moves from translation to upload progress and finishes with permanent upload failures", async () => {
    const result = createDeferred<PageLocalizationRequestResult>();
    mocks.listMarkdownDocsTreePagesWithTitles.mockResolvedValue({ items: [], pages: [] });
    mocks.translatePageLocalizations.mockImplementation(async (input: { onEvent?: (event: PageLocalizationTranslationEvent) => void }) => {
      input.onEvent?.({
        type: "uploads-waiting",
        queuedUploads: 1,
      });
      input.onEvent?.({
        type: "upload-failed",
        attempts: 1,
        batchSize: 1,
        error: "RequestError: Bad credentials",
        language,
        retryable: false,
        sourcePage: { path: "home.md", slug: "home" },
      });
      return result.promise;
    });
    const job = startPageLocalizationJob({
      apiKey: "openrouter-key",
      config,
      languages: [language],
      localizationPath: "localizations",
      mode: "missing-and-outdated",
      model: "openai/gpt-5.4-mini",
      origin: "https://docs.example.com",
      requestTimeoutMs: 60_000,
      siteTitle: "Vicky Docs",
    });

    expect(job.phase).toBe("queued");
    await vi.waitFor(() => expect(getLatestPageLocalizationJob()?.phase).toBe("uploading"));
    expect(getLatestPageLocalizationJob()?.logs.at(-1)).toMatchObject({ level: "error", message: "GitHub upload failed for home in German (de)." });

    result.resolve({
      totalPages: 1,
      cachedPages: 0,
      requestedPages: 1,
      translatedPages: 1,
      uploadedPages: 0,
      translationFailedPages: 0,
      uploadFailedPages: 1,
      failedPages: 1,
      failures: [{ slug: "home", path: "home.md", languageCode: "de", stage: "upload", error: "RequestError: Bad credentials" }],
    });

    await vi.waitFor(() => expect(getLatestPageLocalizationJob()?.status).toBe("completed_with_failures"));
    expect(getLatestPageLocalizationJob()).toMatchObject({ phase: "finished", result: { translatedPages: 1, uploadedPages: 0, uploadFailedPages: 1 } });
  });
});
