import { describe, expect, it, vi } from "vitest";

import {
  classifyGitHubLocalizationUploadFailure,
  GitHubLocalizationUploadError,
  GitHubLocalizationUploadQueue,
  GitHubLocalizationUploadQueueClosedError,
  type GitHubLocalizationUploadEvent,
  type GitHubLocalizationUploadQueueOptions,
  type GitHubLocalizationUploadQueueInput,
} from "../github-localization-upload-queue";
import type { AutoTranslateLanguage, GitHubDocPage, GitHubRuntimeConfig } from "../types";

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
  content: "Welcome.",
  markdown: "---\ntitle: Home\n---\n\nWelcome.",
  headings: [],
  includeInPlaintextExport: true,
  updatedAt: "2026-05-04T15:37:03.000Z",
  updatedBy: "Ada",
};

const input = (onEvent?: (event: GitHubLocalizationUploadEvent) => void): GitHubLocalizationUploadQueueInput => ({
  config,
  input: {
    markdown: "---\ntitle: Startseite\n---\n\nWillkommen.",
    includeInPlaintextExport: true,
    commitMessage: "docs: update German localization",
  },
  language,
  localizationPath: "localizations",
  onEvent,
  sourcePage,
});

const createQueue = (saveBatch: ReturnType<typeof vi.fn>, options: { maxAttempts?: number; random?: () => number } = {}) => {
  let nowMs = Date.parse("2026-05-04T15:37:03.000Z");
  const scheduled: Array<{ callback: () => void; delayMs: number; unref: ReturnType<typeof vi.fn> }> = [];
  const clearTimer = vi.fn();
  const queue = new GitHubLocalizationUploadQueue({
    clearTimer,
    maxAttempts: options.maxAttempts ?? 3,
    now: () => nowMs,
    random: options.random ?? (() => 0.5),
    saveBatch: saveBatch as unknown as NonNullable<GitHubLocalizationUploadQueueOptions["saveBatch"]>,
    scheduleTimer: (callback, delayMs) => {
      const handle = { callback, delayMs, unref: vi.fn() };
      scheduled.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    uploadIntervalMs: 100,
  });

  return {
    advanceTo: (value: number) => {
      nowMs = value;
    },
    clearTimer,
    now: () => nowMs,
    queue,
    scheduled,
  };
};

const successfulBatch = { commitSha: "commit-sha", results: [] };

describe("GitHub localization upload queue", () => {
  it("batches uploads for the same repository and resolves every promise", async () => {
    const saveBatch = vi.fn().mockResolvedValue(successfulBatch);
    const harness = createQueue(saveBatch);
    const first = harness.queue.enqueue(input());
    const second = harness.queue.enqueue(input());

    expect(harness.scheduled[0]?.delayMs).toBe(100);
    expect(harness.scheduled[0]?.unref).toHaveBeenCalledTimes(1);

    harness.advanceTo(harness.now() + 100);
    await harness.queue.flush();

    await expect(first.upload).resolves.toBeUndefined();
    await expect(second.upload).resolves.toBeUndefined();
    expect(saveBatch).toHaveBeenCalledTimes(1);
    expect(saveBatch.mock.calls[0]?.[0].items).toHaveLength(2);
    await harness.queue.shutdown();
  });

  it("lets later arrivals join the already scheduled batch window", async () => {
    const saveBatch = vi.fn().mockResolvedValue(successfulBatch);
    const harness = createQueue(saveBatch);
    const first = harness.queue.enqueue(input());
    harness.advanceTo(harness.now() + 50);
    const second = harness.queue.enqueue(input());

    expect(second.flushAt).toBe(first.flushAt);
    harness.advanceTo(harness.now() + 50);
    await harness.queue.flush();

    await expect(Promise.all([first.upload, second.upload])).resolves.toEqual([undefined, undefined]);
    expect(saveBatch.mock.calls[0]?.[0].items).toHaveLength(2);
    await harness.queue.shutdown();
  });

  it("retries transient failures with bounded exponential backoff and deterministic jitter", async () => {
    const events: GitHubLocalizationUploadEvent[] = [];
    const saveBatch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("GitHub unavailable"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("GitHub still unavailable"), { status: 503 }))
      .mockResolvedValueOnce(successfulBatch);
    const harness = createQueue(saveBatch, { random: () => 0.75 });
    const queued = harness.queue.enqueue(input((event) => events.push(event)));

    harness.advanceTo(harness.now() + 100);
    await harness.queue.flush();
    expect(events.find((event) => event.type === "upload-retry")).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(harness.scheduled.at(-1)?.delayMs).toBe(110);

    harness.advanceTo(harness.now() + 110);
    await harness.queue.flush();
    expect(events.filter((event) => event.type === "upload-retry")[1]).toMatchObject({ attempt: 2, maxAttempts: 3 });
    expect(harness.scheduled.at(-1)?.delayMs).toBe(220);

    harness.advanceTo(harness.now() + 220);
    await harness.queue.flush();

    await expect(queued.upload).resolves.toBeUndefined();
    expect(saveBatch).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({ type: "upload-success", attempt: 3 });
    await harness.queue.shutdown();
  });

  it("rejects permanent GitHub failures immediately", async () => {
    const events: GitHubLocalizationUploadEvent[] = [];
    const saveBatch = vi.fn().mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
    const harness = createQueue(saveBatch);
    const queued = harness.queue.enqueue(input((event) => events.push(event)));
    const rejection = expect(queued.upload).rejects.toMatchObject({ attempts: 1, retryable: false });

    harness.advanceTo(harness.now() + 100);
    await harness.queue.flush();

    await rejection;
    expect(saveBatch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "upload-failed", attempts: 1, retryable: false });
    await harness.queue.shutdown();
  });

  it("rejects a retryable failure after the configured attempt cap", async () => {
    const saveBatch = vi.fn().mockRejectedValue(Object.assign(new Error("Service unavailable"), { status: 503 }));
    const harness = createQueue(saveBatch, { maxAttempts: 3 });
    const queued = harness.queue.enqueue(input());
    const rejection = expect(queued.upload).rejects.toBeInstanceOf(GitHubLocalizationUploadError);

    harness.advanceTo(harness.now() + 100);
    await harness.queue.flush();
    harness.advanceTo(harness.now() + 100);
    await harness.queue.flush();
    harness.advanceTo(harness.now() + 200);
    await harness.queue.flush();

    await rejection;
    expect(saveBatch).toHaveBeenCalledTimes(3);
    await harness.queue.shutdown();
  });

  it("does not retry before GitHub's rate-limit delay", async () => {
    const rateLimit = Object.assign(new Error("API rate limit exceeded"), {
      status: 429,
      response: { headers: { "retry-after": "12" } },
    });
    const saveBatch = vi.fn().mockRejectedValue(rateLimit);
    const harness = createQueue(saveBatch);
    const queued = harness.queue.enqueue(input());
    const rejection = expect(queued.upload).rejects.toBeInstanceOf(GitHubLocalizationUploadQueueClosedError);

    harness.advanceTo(harness.now() + 100);
    await harness.queue.flush();

    expect(harness.scheduled.at(-1)?.delayMs).toBe(12_000);
    await harness.queue.shutdown();
    await rejection;
  });

  it("rejects queued work and clears its timer during shutdown", async () => {
    const events: GitHubLocalizationUploadEvent[] = [];
    const saveBatch = vi.fn().mockResolvedValue(successfulBatch);
    const harness = createQueue(saveBatch);
    const queued = harness.queue.enqueue(input((event) => events.push(event)));
    const rejection = expect(queued.upload).rejects.toBeInstanceOf(GitHubLocalizationUploadQueueClosedError);

    await harness.queue.shutdown();

    await rejection;
    expect(harness.clearTimer).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "upload-failed", attempts: 0, retryable: false });
    await expect(harness.queue.enqueue(input()).upload).rejects.toBeInstanceOf(GitHubLocalizationUploadQueueClosedError);
    expect(saveBatch).not.toHaveBeenCalled();
  });

  it("waits for an in-flight batch during shutdown", async () => {
    let resolveBatch!: (value: typeof successfulBatch) => void;
    const batch = new Promise<typeof successfulBatch>((resolve) => {
      resolveBatch = resolve;
    });
    const saveBatch = vi.fn().mockReturnValue(batch);
    const harness = createQueue(saveBatch);
    const queued = harness.queue.enqueue(input());
    harness.advanceTo(harness.now() + 100);
    const flush = harness.queue.flush();
    await vi.waitFor(() => expect(saveBatch).toHaveBeenCalledTimes(1));
    let stopped = false;
    const shutdown = harness.queue.shutdown().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveBatch(successfulBatch);
    await Promise.all([flush, shutdown]);

    await expect(queued.upload).resolves.toBeUndefined();
    expect(stopped).toBe(true);
  });

  it("classifies GitHub rate limits and validation failures", () => {
    const rateLimit = Object.assign(new Error("API rate limit exceeded"), {
      status: 403,
      response: { headers: { "retry-after": "12", "x-ratelimit-remaining": "0" } },
    });

    expect(classifyGitHubLocalizationUploadFailure(rateLimit, 1_000)).toEqual({ retryable: true, retryAfterMs: 12_000 });
    expect(classifyGitHubLocalizationUploadFailure(Object.assign(new Error("Validation failed"), { status: 422 }), 1_000)).toEqual({ retryable: false, retryAfterMs: null });
    expect(classifyGitHubLocalizationUploadFailure(Object.assign(new Error("Reference update failed"), { status: 422 }), 1_000)).toEqual({ retryable: true, retryAfterMs: null });
  });
});
