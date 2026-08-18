import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadGitHubLocalizationSnapshot: vi.fn(),
  loadGitHubLocalizationStatusIndex: vi.fn(),
  loadGitHubLocalizedDoc: vi.fn(),
  requestOpenRouterChatCompletion: vi.fn(),
  saveGitHubLocalizedDoc: vi.fn(),
  enqueueGitHubLocalizationUpload: vi.fn(),
}));

vi.mock("@/lib/openrouter", () => ({
  requestOpenRouterChatCompletion: mocks.requestOpenRouterChatCompletion,
}));

vi.mock("@/lib/github", () => ({
  loadGitHubLocalizationSnapshot: mocks.loadGitHubLocalizationSnapshot,
  loadGitHubLocalizationStatusIndex: mocks.loadGitHubLocalizationStatusIndex,
  loadGitHubLocalizedDoc: mocks.loadGitHubLocalizedDoc,
  saveGitHubLocalizedDoc: mocks.saveGitHubLocalizedDoc,
}));

vi.mock("@/lib/github-localization-upload-queue", () => ({
  enqueueGitHubLocalizationUpload: mocks.enqueueGitHubLocalizationUpload,
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
    mocks.loadGitHubLocalizationSnapshot.mockResolvedValue({
      fetchedAt: "2026-05-04T15:37:03.000Z",
      expiresAt: "2026-05-04T16:37:03.000Z",
      tree: [],
      pages: [],
    });
    mocks.loadGitHubLocalizationStatusIndex.mockResolvedValue(new Map());
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

  it("retries a failing page translation before marking it translated", async () => {
    const events: PageLocalizationTranslationEvent[] = [];
    mocks.requestOpenRouterChatCompletion
      .mockRejectedValueOnce(new Error("Provider connection dropped"))
      .mockRejectedValueOnce(new Error("Provider connection dropped again"))
      .mockResolvedValueOnce(translatedPayload);

    const result = await translatePages(events);

    expect(mocks.requestOpenRouterChatCompletion).toHaveBeenCalledTimes(3);
    expect(result.translatedPages).toBe(1);
    expect(result.uploadedPages).toBe(1);
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
    expect(result.translationFailedPages).toBe(1);
    expect(result.failedPages).toBe(1);
    expect(result.failures[0]?.error).toContain("Error: Provider rejected the request");
    expect(events.find((event) => event.type === "page-failed")).toMatchObject({
      attempts: 11,
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

});
