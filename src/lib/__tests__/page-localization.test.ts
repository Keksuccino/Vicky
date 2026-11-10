import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Heap limit the translation run sees; unset uses the real one. */
  heapSizeLimit: undefined as number | undefined,
  loadGitHubLocalizationStatuses: vi.fn(),
  requestOpenRouterChatCompletion: vi.fn(),
  saveGitHubLocalizedDoc: vi.fn(),
  enqueueGitHubLocalizationUpload: vi.fn(),
}));

vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return { ...actual, getHeapStatistics: () => ({ ...actual.getHeapStatistics(), ...(mocks.heapSizeLimit === undefined ? {} : { heap_size_limit: mocks.heapSizeLimit }) }) };
});

vi.mock("@/lib/openrouter", () => ({
  requestOpenRouterChatCompletion: mocks.requestOpenRouterChatCompletion,
}));

vi.mock("@/lib/github-localization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github-localization")>()),
  loadGitHubLocalizationStatuses: mocks.loadGitHubLocalizationStatuses,
}));

vi.mock("@/lib/github-localization-saves", () => ({
  saveGitHubLocalizedDoc: mocks.saveGitHubLocalizedDoc,
}));

vi.mock("@/lib/github-localization-upload-queue", () => ({
  enqueueGitHubLocalizationUpload: mocks.enqueueGitHubLocalizationUpload,
}));

import { ApiError } from "../http";
import { parseMarkdownDocument } from "../markdown";
import {
  classifyTranslationFailure,
  translatePageLocalizations,
  translationRetryDelayMs,
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
  sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
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

const translatePages = (events: PageLocalizationTranslationEvent[] = [], sourcePages: GitHubDocPage[] = [sourcePage]) =>
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
    sourcePages,
  });

/** Missing translations of `count` distinct source pages. */
const manySourcePages = (count: number): GitHubDocPage[] =>
  Array.from({ length: count }, (_, index) => ({ ...sourcePage, path: `page-${index}.md`, slug: `page-${index}` }));

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    reject,
    resolve,
  };
};

describe("page localization translations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadGitHubLocalizationStatuses.mockResolvedValue(new Map());
    mocks.saveGitHubLocalizedDoc.mockResolvedValue({
      localizedRepoPath: "localizations/de/home.md",
      page: sourcePage,
    });
    mocks.enqueueGitHubLocalizationUpload.mockImplementation(
      (input: { onEvent?: (event: { type: "queued"; flushAt: string; queueSize: number }) => void }) => {
        const flushAt = "2026-05-04T15:42:03.000Z";
        input.onEvent?.({ type: "queued", flushAt, queueSize: 1 });
        return {
          flushAt,
          upload: Promise.resolve(),
        };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    mocks.heapSizeLimit = undefined;
  });

  it("retries a failing page translation before marking it translated", async () => {
    vi.useFakeTimers();
    const events: PageLocalizationTranslationEvent[] = [];
    mocks.requestOpenRouterChatCompletion
      .mockRejectedValueOnce(new Error("Provider connection dropped"))
      .mockRejectedValueOnce(new Error("Provider connection dropped again"))
      .mockResolvedValueOnce(translatedPayload);

    const run = translatePages(events);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run;

    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.translatedPages).toBe(1);
    expect(result.uploadedPages).toBe(1);
    expect(result.failedPages).toBe(0);
    expect(events.filter((event) => event.type === "page-retry")).toHaveLength(2);
    expect(events.find((event) => event.type === "page-success")).toMatchObject({
      attempt: 3,
      type: "page-success",
    });
    expect(events.find((event) => event.type === "prepared")).toMatchObject({
      statuses: [{ languageCode: "de", currentPages: 0, missingPages: 1, outdatedPages: 0, totalPages: 1, unrecordedPages: 0 }],
      type: "prepared",
    });
  });

  it("tags successful upload progress with the status it replaced", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(translatedPayload);
    mocks.enqueueGitHubLocalizationUpload.mockImplementation((input: { onEvent?: (event: { type: "queued"; flushAt: string; queueSize: number } | { type: "upload-success"; attempt: number; batchSize: number; commitSha: string }) => void }) => {
      const flushAt = "2026-05-04T15:42:03.000Z";
      input.onEvent?.({ type: "queued", flushAt, queueSize: 1 });
      input.onEvent?.({ type: "upload-success", attempt: 1, batchSize: 1, commitSha: "commit-sha" });
      return { flushAt, upload: Promise.resolve() };
    });

    await translatePageLocalizations({ apiKey: "openrouter-key", config, languages: [language], localizationPath: "localizations", mode: "missing-and-outdated", model: "openai/gpt-5.4-mini", onEvent: (event) => events.push(event), origin: "https://docs.example.com", queueUploads: true, siteTitle: "Vicky Docs", sourcePages: [sourcePage] });

    expect(events.find((event) => event.type === "upload-success")).toMatchObject({ type: "upload-success", previousStatus: "missing" });
    const queuedMarkdown = (mocks.enqueueGitHubLocalizationUpload.mock.calls[0]?.[0] as { input: { markdown: string } }).input.markdown;
    expect(parseMarkdownDocument(queuedMarkdown)).toMatchObject({ title: "Startseite", sourceBlobSha: sourcePage.sha });
  });

  it("gives up on a page after six attempts with growing delays and keeps the batch result usable", async () => {
    vi.useFakeTimers();
    const events: PageLocalizationTranslationEvent[] = [];
    const calledAt: number[] = [];
    mocks.requestOpenRouterChatCompletion.mockImplementation(async () => {
      calledAt.push(Date.now());
      throw new Error("Provider connection dropped");
    });

    const run = translatePages(events);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const result = await run;

    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(6);
    for (let attempt = 1; attempt < calledAt.length; attempt += 1) {
      // Equal jitter: at least half of the exponential delay of the failed attempt.
      expect(calledAt[attempt] - calledAt[attempt - 1]).toBeGreaterThanOrEqual(1_000 * 2 ** (attempt - 1));
    }
    expect(result.translatedPages).toBe(0);
    expect(result.translationFailedPages).toBe(1);
    expect(result.failedPages).toBe(1);
    expect(result.failures[0]?.error).toContain("Error: Provider connection dropped");
    expect(events.find((event) => event.type === "page-failed")).toMatchObject({
      attempts: 6,
      type: "page-failed",
    });
  });

  it("reports when page translation is finished and queued GitHub uploads are still pending", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    const upload = createDeferred<void>();
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(translatedPayload);
    mocks.enqueueGitHubLocalizationUpload.mockImplementation(
      (input: { onEvent?: (event: { type: "queued"; flushAt: string; queueSize: number }) => void }) => {
        const flushAt = "2026-05-04T15:42:03.000Z";
        input.onEvent?.({ type: "queued", flushAt, queueSize: 1 });
        return {
          flushAt,
          upload: upload.promise,
        };
      },
    );

    const run = translatePageLocalizations({
      apiKey: "openrouter-key",
      config,
      languages: [language],
      localizationPath: "localizations",
      mode: "missing-and-outdated",
      model: "openai/gpt-5.4-mini",
      onEvent: (event) => events.push(event),
      origin: "https://docs.example.com",
      queueUploads: true,
      siteTitle: "Vicky Docs",
      sourcePages: [sourcePage],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.find((event) => event.type === "uploads-waiting")).toMatchObject({
      queuedUploads: 1,
      type: "uploads-waiting",
    });

    upload.resolve();
    await expect(run).resolves.toMatchObject({
      translatedPages: 1,
      uploadedPages: 1,
    });
  });

  it("reports a rejected queued upload as an upload failure without rejecting the whole job", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    const upload = createDeferred<void>();
    mocks.requestOpenRouterChatCompletion.mockResolvedValueOnce(translatedPayload);
    mocks.enqueueGitHubLocalizationUpload.mockImplementation(
      (input: { onEvent?: (event: { type: "queued"; flushAt: string; queueSize: number }) => void }) => {
        const flushAt = "2026-05-04T15:42:03.000Z";
        input.onEvent?.({ type: "queued", flushAt, queueSize: 1 });
        return { flushAt, upload: upload.promise };
      },
    );

    const run = translatePageLocalizations({
      apiKey: "openrouter-key",
      config,
      languages: [language],
      localizationPath: "localizations",
      mode: "missing-and-outdated",
      model: "openai/gpt-5.4-mini",
      onEvent: (event) => events.push(event),
      origin: "https://docs.example.com",
      queueUploads: true,
      siteTitle: "Vicky Docs",
      sourcePages: [sourcePage],
    });

    await vi.waitFor(() => expect(events.some((event) => event.type === "uploads-waiting")).toBe(true));
    upload.reject(new Error("GitHub rejected the commit"));

    await expect(run).resolves.toMatchObject({
      translatedPages: 1,
      uploadedPages: 0,
      failedPages: 1,
      uploadFailedPages: 1,
      translationFailedPages: 0,
      failures: [{ languageCode: "de", path: "home.md", slug: "home", stage: "upload" }],
    });
  });

  it("classifies translation failures by what another attempt could achieve", () => {
    expect(classifyTranslationFailure(new ApiError(429, "Rate limited", { "Retry-After": "12" }))).toEqual({ retryable: true, stopsJob: false, retryAfterMs: 12_000 });
    expect(classifyTranslationFailure(new ApiError(503, "No provider available"))).toEqual({ retryable: true, stopsJob: false });
    expect(classifyTranslationFailure(new ApiError(504, "Timed out"))).toEqual({ retryable: true, stopsJob: false });
    expect(classifyTranslationFailure(new ApiError(402, "Spending limit in flight", { "Retry-After": "5" }))).toEqual({ retryable: true, stopsJob: false, retryAfterMs: 5_000 });
    expect(classifyTranslationFailure(new Error("socket hang up"))).toEqual({ retryable: true, stopsJob: false });
    expect(classifyTranslationFailure(new ApiError(400, "Context too long"))).toEqual({ retryable: false, stopsJob: false });
    expect(classifyTranslationFailure(new ApiError(403, "Flagged by moderation"))).toEqual({ retryable: false, stopsJob: false });
    for (const status of [401, 402, 404]) {
      expect(classifyTranslationFailure(new ApiError(status, "Unusable account"))).toEqual({ retryable: false, stopsJob: true });
    }
    expect(classifyTranslationFailure(Object.assign(new Error("Queue closed"), { name: "GitHubLocalizationUploadQueueClosedError" }))).toEqual({ retryable: false, stopsJob: true });
  });

  it("backs off exponentially with jitter and never retries before the provider's retry-after", () => {
    expect([1, 2, 3, 4].map((attempt) => translationRetryDelayMs(attempt, undefined, () => 0))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(translationRetryDelayMs(3, undefined, () => 1)).toBe(8_000);
    expect(translationRetryDelayMs(10, undefined, () => 1)).toBe(60_000);
    expect(translationRetryDelayMs(1, 45_000, () => 1)).toBe(45_000);
  });

  it("does not retry a page that cannot succeed and keeps translating the others", async () => {
    mocks.requestOpenRouterChatCompletion.mockRejectedValueOnce(new ApiError(400, "Context too long")).mockResolvedValue(translatedPayload);

    const result = await translatePages([], manySourcePages(3));

    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ requestedPages: 3, translatedPages: 2, translationFailedPages: 1 });
  });

  it("stops starting translations when no page can succeed and fails the rest without requests", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    mocks.requestOpenRouterChatCompletion.mockRejectedValue(new ApiError(401, "No auth credentials found"));

    const result = await translatePages(events, manySourcePages(20));

    // The first 16 run in parallel; the remaining 4 never reach OpenRouter.
    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(16);
    expect(result).toMatchObject({ requestedPages: 20, translatedPages: 0, translationFailedPages: 20 });
    expect(events.filter((event) => event.type === "translation-stopped")).toHaveLength(1);
    expect(events.filter((event) => event.type === "page-retry")).toHaveLength(0);
  });

  it("pauses every worker for the provider's retry-after", async () => {
    vi.useFakeTimers();
    const calledAt: number[] = [];
    mocks.requestOpenRouterChatCompletion.mockImplementation(async () => {
      calledAt.push(Date.now());
      if (calledAt.length === 1) {
        throw new ApiError(429, "Rate limited", { "Retry-After": "30" });
      }
      return translatedPayload;
    });
    const startedAt = Date.now();

    const run = translatePages([], manySourcePages(17));
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await run;

    expect(result).toMatchObject({ translatedPages: 17, failedPages: 0 });
    expect(calledAt).toHaveLength(18);
    // 16 requests start at once; the 17th page and the retry of the rate-limited one wait out the pause.
    expect(calledAt.filter((at) => at - startedAt >= 30_000)).toHaveLength(2);
  });

  it("stops after a bounded wait when the server stays low on memory instead of hanging", async () => {
    vi.useFakeTimers();
    mocks.heapSizeLimit = 1;
    const events: PageLocalizationTranslationEvent[] = [];

    const run = translatePages(events, manySourcePages(2));
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 2_000);
    const result = await run;

    expect(mocks.requestOpenRouterChatCompletion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requestedPages: 2, translatedPages: 0, translationFailedPages: 2 });
    expect(events.filter((event) => event.type === "translation-stopped")).toHaveLength(1);
  });
});
