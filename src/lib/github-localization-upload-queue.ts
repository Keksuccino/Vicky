import { getDetailedAutoTranslateErrorMessage } from "@/lib/auto-translate-logging";
import {
  saveGitHubLocalizedDocsBatch,
  toRuntimeConfigCacheKey,
  type GitHubLocalizedDocSourcePage,
  type SaveGitHubLocalizedDocBatchItem,
} from "@/lib/github";
import type {
  AutoTranslateLanguage,
  GitHubDocPage,
  GitHubRuntimeConfig,
  SaveGitHubDocInput,
} from "@/lib/types";

export const GITHUB_LOCALIZATION_UPLOAD_INTERVAL_MS = 5 * 60 * 1_000;
export const GITHUB_LOCALIZATION_UPLOAD_MAX_ATTEMPTS = 4;
export const GITHUB_LOCALIZATION_UPLOAD_MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

const GITHUB_LOCALIZATION_UPLOAD_RETRY_JITTER_RATIO = 0.2;

export type GitHubLocalizationUploadEvent =
  | {
      type: "queued";
      flushAt: string;
      queueSize: number;
    }
  | {
      type: "upload-start";
      attempt: number;
      batchSize: number;
      maxAttempts: number;
    }
  | {
      type: "upload-success";
      attempt: number;
      batchSize: number;
      commitSha: string;
    }
  | {
      type: "upload-retry";
      attempt: number;
      batchSize: number;
      error: string;
      maxAttempts: number;
      retryAt: string;
    }
  | {
      type: "upload-failed";
      attempts: number;
      batchSize: number;
      error: string;
      retryable: boolean;
    };

export type GitHubLocalizationUploadQueueInput = {
  config: GitHubRuntimeConfig;
  input: Omit<SaveGitHubDocInput, "path" | "slug">;
  language: AutoTranslateLanguage;
  localizationPath: string;
  onEvent?: (event: GitHubLocalizationUploadEvent) => void;
  sourcePage: GitHubDocPage;
};

export type GitHubLocalizationQueuedUpload = {
  flushAt: string;
  upload: Promise<void>;
};

export type GitHubUploadFailureClassification = {
  retryable: boolean;
  retryAfterMs: number | null;
};

type UploadQueueItem = Omit<GitHubLocalizationUploadQueueInput, "sourcePage"> & {
  attempts: number;
  nextAttemptAt: number;
  reject: (error: unknown) => void;
  resolve: () => void;
  settled: boolean;
  sourcePage: GitHubLocalizedDocSourcePage;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type GitHubLocalizationUploadQueueOptions = {
  clearTimer?: (timer: TimerHandle) => void;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  random?: () => number;
  saveBatch?: typeof saveGitHubLocalizedDocsBatch;
  scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  uploadIntervalMs?: number;
};

const GITHUB_LOCALIZATION_UPLOAD_QUEUE_KEY = Symbol.for("vicky.githubLocalization.uploadQueue");
const GITHUB_LOCALIZATION_UPLOAD_SHUTDOWN_KEY = Symbol.for("vicky.githubLocalization.uploadQueue.shutdown");

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const finiteStatus = (value: unknown): number | null => {
  const status = typeof value === "number" ? value : Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
};

const errorStatus = (error: unknown): number | null => {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const record = asRecord(current);
    const status = finiteStatus(record.status) ?? finiteStatus(asRecord(record.response).status);
    if (status !== null) {
      return status;
    }
    current = record.cause;
  }

  return null;
};

const errorHeader = (error: unknown, name: string): string => {
  let current: unknown = error;
  const visited = new Set<unknown>();
  const normalizedName = name.toLowerCase();

  while (current && !visited.has(current)) {
    visited.add(current);
    const record = asRecord(current);
    const headers = asRecord(asRecord(record.response).headers);
    for (const [headerName, value] of Object.entries(headers)) {
      if (headerName.toLowerCase() === normalizedName && (typeof value === "string" || typeof value === "number")) {
        return String(value).trim();
      }
    }
    current = record.cause;
  }

  return "";
};

const retryAfterMsFromError = (error: unknown, nowMs: number): number | null => {
  const retryAfter = errorHeader(error, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1_000);
    }

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - nowMs);
    }
  }

  const rateLimitReset = Number(errorHeader(error, "x-ratelimit-reset"));
  if (Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
    return Math.max(0, Math.ceil(rateLimitReset * 1_000 - nowMs));
  }

  return null;
};

const errorCode = (error: unknown): string => {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && !visited.has(current)) {
    visited.add(current);
    const record = asRecord(current);
    if (typeof record.code === "string" && record.code.trim()) {
      return record.code.trim().toUpperCase();
    }
    current = record.cause;
  }

  return "";
};

export const classifyGitHubLocalizationUploadFailure = (error: unknown, nowMs = Date.now()): GitHubUploadFailureClassification => {
  const status = errorStatus(error);
  const retryAfterMs = retryAfterMsFromError(error, nowMs);
  const message = getDetailedAutoTranslateErrorMessage(error).toLowerCase();

  if (errorCode(error) === "ABORT_ERR" || message.includes("aborterror")) {
    return { retryable: false, retryAfterMs: null };
  }

  if (status === 403) {
    const rateLimited = retryAfterMs !== null || errorHeader(error, "x-ratelimit-remaining") === "0" || /rate limit|secondary rate|abuse detection/.test(message);
    return { retryable: rateLimited, retryAfterMs: rateLimited ? retryAfterMs : null };
  }

  if (status === 422) {
    const refConflict = /reference update failed|failed to update ref|not a fast forward|expected.*sha/.test(message);
    return { retryable: refConflict, retryAfterMs: null };
  }

  if (status !== null) {
    return {
      retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500,
      retryAfterMs,
    };
  }

  const code = errorCode(error);
  const permanentNetworkCodes = new Set(["ERR_INVALID_URL", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
  return {
    // Unknown transport failures are retried because they are commonly socket/DNS interruptions. The attempt cap still guarantees settlement.
    retryable: !permanentNetworkCodes.has(code),
    retryAfterMs,
  };
};

export class GitHubLocalizationUploadError extends Error {
  readonly attempts: number;
  readonly retryable: boolean;
  readonly cause: unknown;

  constructor(message: string, options: { attempts: number; cause: unknown; retryable: boolean }) {
    super(message);
    this.name = "GitHubLocalizationUploadError";
    this.attempts = options.attempts;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

export class GitHubLocalizationUploadQueueClosedError extends Error {
  constructor(message = "GitHub localization upload queue is shutting down.") {
    super(message);
    this.name = "GitHubLocalizationUploadQueueClosedError";
  }
}

const compactSourcePage = (page: GitHubDocPage): GitHubLocalizedDocSourcePage => ({
  path: page.path,
  slug: page.slug,
  sha: page.sha,
  includeInPlaintextExport: page.includeInPlaintextExport,
  updatedAt: page.updatedAt,
  updatedBy: page.updatedBy,
});

const toBatchItem = (item: UploadQueueItem): SaveGitHubLocalizedDocBatchItem => ({
  input: item.input,
  language: item.language,
  localizationPath: item.localizationPath,
  sourcePage: item.sourcePage,
});

const groupQueueItems = (items: UploadQueueItem[]): UploadQueueItem[][] => {
  const groups = new Map<string, UploadQueueItem[]>();

  for (const item of items) {
    const key = toRuntimeConfigCacheKey(item.config);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return Array.from(groups.values());
};

export class GitHubLocalizationUploadQueue {
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly maxAttempts: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly saveBatch: typeof saveGitHubLocalizedDocsBatch;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly uploadIntervalMs: number;
  private activeFlush: Promise<void> | null = null;
  private closed = false;
  private lastFlushStartedAt = 0;
  private pending: UploadQueueItem[] = [];
  private scheduledFlushAt: number | null = null;
  private timer: TimerHandle | null = null;

  constructor(options: GitHubLocalizationUploadQueueOptions = {}) {
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? GITHUB_LOCALIZATION_UPLOAD_MAX_ATTEMPTS));
    this.maxRetryDelayMs = Math.max(1, options.maxRetryDelayMs ?? GITHUB_LOCALIZATION_UPLOAD_MAX_RETRY_DELAY_MS);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.saveBatch = options.saveBatch ?? saveGitHubLocalizedDocsBatch;
    this.scheduleTimer = options.scheduleTimer ?? setTimeout;
    this.uploadIntervalMs = Math.max(1, options.uploadIntervalMs ?? GITHUB_LOCALIZATION_UPLOAD_INTERVAL_MS);
  }

  enqueue(input: GitHubLocalizationUploadQueueInput): GitHubLocalizationQueuedUpload {
    if (this.closed) {
      const error = new GitHubLocalizationUploadQueueClosedError();
      const upload = Promise.reject<void>(error);
      void upload.catch(() => undefined);
      try {
        input.onEvent?.({ type: "upload-failed", attempts: 0, batchSize: 1, error: error.message, retryable: false });
      } catch {
        // Progress observers are diagnostic only and must never change upload delivery or settlement.
      }
      return { flushAt: new Date(this.now()).toISOString(), upload };
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const upload = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    // Consumers receive the original rejecting promise. Attaching a handler immediately prevents a fast failure from becoming unhandled before a batch consumer reaches Promise.all.
    void upload.catch(() => undefined);

    const item: UploadQueueItem = {
      ...input,
      attempts: 0,
      nextAttemptAt: this.initialFlushAt(),
      reject,
      resolve,
      settled: false,
      sourcePage: compactSourcePage(input.sourcePage),
    };
    this.pending.push(item);
    const flushAt = new Date(this.nextFlushAt()).toISOString();
    this.notify(item, {
      type: "queued",
      flushAt,
      queueSize: this.pending.length,
    });
    this.scheduleFlush();

    return { flushAt, upload };
  }

  async flush(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.activeFlush) {
      return this.activeFlush;
    }
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
      this.scheduledFlushAt = null;
    }

    const flush = this.flushReadyItems().finally(() => {
      if (this.activeFlush === flush) {
        this.activeFlush = null;
      }
      this.scheduleFlush();
    });
    this.activeFlush = flush;
    return flush;
  }

  async shutdown(reason: unknown = new GitHubLocalizationUploadQueueClosedError()): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (this.timer) {
        this.clearTimer(this.timer);
        this.timer = null;
        this.scheduledFlushAt = null;
      }

      const queued = this.pending;
      this.pending = [];
      for (const item of queued) {
        this.notify(item, { type: "upload-failed", attempts: item.attempts, batchSize: 1, error: getDetailedAutoTranslateErrorMessage(reason), retryable: false });
        this.failItem(item, reason, false);
      }
    }

    await this.activeFlush;
  }

  private nextAllowedFlushAt(candidate: number): number {
    return this.lastFlushStartedAt > 0 ? Math.max(candidate, this.lastFlushStartedAt + this.uploadIntervalMs) : candidate;
  }

  private initialFlushAt(): number {
    if (this.scheduledFlushAt !== null) {
      return this.scheduledFlushAt;
    }
    if (this.lastFlushStartedAt > 0) {
      return Math.max(this.now(), this.lastFlushStartedAt + this.uploadIntervalMs);
    }
    return this.now() + this.uploadIntervalMs;
  }

  private nextFlushAt(): number {
    const earliestItem = this.pending.reduce((earliest, item) => Math.min(earliest, item.nextAttemptAt), Number.POSITIVE_INFINITY);
    return this.nextAllowedFlushAt(Number.isFinite(earliestItem) ? earliestItem : this.now() + this.uploadIntervalMs);
  }

  private scheduleFlush(): void {
    if (this.closed || this.activeFlush || this.pending.length === 0) {
      return;
    }

    const flushAt = this.nextFlushAt();
    if (this.timer && this.scheduledFlushAt !== null && this.scheduledFlushAt <= flushAt) {
      return;
    }
    if (this.timer) {
      this.clearTimer(this.timer);
    }
    this.scheduledFlushAt = flushAt;
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      this.scheduledFlushAt = null;
      void this.flush().catch((error: unknown) => this.failPendingAfterUnexpectedFlushError(error));
    }, Math.max(0, flushAt - this.now()));
    // A queued background upload must not keep an otherwise idle Next.js process alive.
    this.timer.unref?.();
  }

  private async flushReadyItems(): Promise<void> {
    const nowMs = this.now();
    if (this.pending.length === 0 || this.nextAllowedFlushAt(nowMs) > nowMs) {
      return;
    }

    const ready: UploadQueueItem[] = [];
    const waiting: UploadQueueItem[] = [];
    for (const item of this.pending) {
      (item.nextAttemptAt <= nowMs ? ready : waiting).push(item);
    }
    if (ready.length === 0) {
      return;
    }

    this.pending = waiting;
    this.lastFlushStartedAt = nowMs;

    try {
      for (const group of groupQueueItems(ready)) {
        await this.uploadGroup(group);
      }
    } catch (error: unknown) {
      for (const item of ready) {
        if (!item.settled && !this.pending.includes(item)) {
          this.failItem(item, error, false);
        }
      }
    }
  }

  private async uploadGroup(group: UploadQueueItem[]): Promise<void> {
    for (const item of group) {
      item.attempts += 1;
      this.notify(item, {
        type: "upload-start",
        attempt: item.attempts,
        batchSize: group.length,
        maxAttempts: this.maxAttempts,
      });
    }

    try {
      const result = await this.saveBatch({
        config: group[0].config,
        includePages: false,
        items: group.map(toBatchItem),
      });

      for (const item of group) {
        this.notify(item, {
          type: "upload-success",
          attempt: item.attempts,
          batchSize: group.length,
          commitSha: result.commitSha,
        });
        this.resolveItem(item);
      }
    } catch (error: unknown) {
      const classification = classifyGitHubLocalizationUploadFailure(error, this.now());
      const message = getDetailedAutoTranslateErrorMessage(error);
      const retryJitter = this.random();

      for (const item of group) {
        if (!this.closed && classification.retryable && item.attempts < this.maxAttempts) {
          const delayMs = this.retryDelayMs(item.attempts, classification.retryAfterMs, retryJitter);
          item.nextAttemptAt = this.nextAllowedFlushAt(this.now() + delayMs);
          this.pending.push(item);
          this.notify(item, {
            type: "upload-retry",
            attempt: item.attempts,
            batchSize: group.length,
            error: message,
            maxAttempts: this.maxAttempts,
            retryAt: new Date(item.nextAttemptAt).toISOString(),
          });
          continue;
        }

        this.notify(item, {
          type: "upload-failed",
          attempts: item.attempts,
          batchSize: group.length,
          error: message,
          retryable: classification.retryable,
        });
        this.failItem(item, new GitHubLocalizationUploadError(message, { attempts: item.attempts, cause: error, retryable: classification.retryable }), classification.retryable);
      }
    }
  }

  private retryDelayMs(attempts: number, retryAfterMs: number | null, random: number): number {
    const exponential = Math.min(this.maxRetryDelayMs, this.uploadIntervalMs * 2 ** Math.max(0, attempts - 1));
    const boundedRandom = Math.min(1, Math.max(0, random));
    const multiplier = 1 - GITHUB_LOCALIZATION_UPLOAD_RETRY_JITTER_RATIO + boundedRandom * GITHUB_LOCALIZATION_UPLOAD_RETRY_JITTER_RATIO * 2;
    const jittered = Math.round(exponential * multiplier);
    return Math.min(this.maxRetryDelayMs, Math.max(jittered, retryAfterMs ?? 0));
  }

  private notify(item: UploadQueueItem, event: GitHubLocalizationUploadEvent): void {
    try {
      item.onEvent?.(event);
    } catch {
      // Progress observers are diagnostic only and must never change upload delivery or settlement.
    }
  }

  private resolveItem(item: UploadQueueItem): void {
    if (item.settled) {
      return;
    }
    item.settled = true;
    item.resolve();
  }

  private failItem(item: UploadQueueItem, error: unknown, retryable: boolean): void {
    if (item.settled) {
      return;
    }
    item.settled = true;
    const failure = error instanceof Error ? error : new GitHubLocalizationUploadError(String(error), { attempts: item.attempts, cause: error, retryable });
    item.reject(failure);
  }

  private failPendingAfterUnexpectedFlushError(error: unknown): void {
    const queued = this.pending;
    this.pending = [];
    for (const item of queued) {
      this.failItem(item, error, false);
    }
  }
}

const getUploadQueue = (): GitHubLocalizationUploadQueue => {
  const globalState = globalThis as typeof globalThis & Record<symbol, GitHubLocalizationUploadQueue | (() => Promise<void>) | undefined>;
  let queue = globalState[GITHUB_LOCALIZATION_UPLOAD_QUEUE_KEY] as GitHubLocalizationUploadQueue | undefined;

  if (!queue) {
    // Uploads intentionally share the process lifetime of their in-memory translation jobs. Persisting token-bearing queue inputs without durable job/callback ownership would create orphaned writes after restart.
    queue = new GitHubLocalizationUploadQueue();
    globalState[GITHUB_LOCALIZATION_UPLOAD_QUEUE_KEY] = queue;
    // The custom production server cannot import a Next.js TypeScript module directly. A symbol hook keeps shutdown explicit without adding process listeners per hot reload.
    globalState[GITHUB_LOCALIZATION_UPLOAD_SHUTDOWN_KEY] = () => queue!.shutdown();
  }

  return queue;
};

export const flushGitHubLocalizationUploads = async (): Promise<void> => getUploadQueue().flush();

export const shutdownGitHubLocalizationUploads = async (): Promise<void> => getUploadQueue().shutdown();

export const enqueueGitHubLocalizationUpload = (input: GitHubLocalizationUploadQueueInput): GitHubLocalizationQueuedUpload =>
  getUploadQueue().enqueue(input);
