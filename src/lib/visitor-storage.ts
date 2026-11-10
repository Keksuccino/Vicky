import path from "node:path";
import { Worker } from "node:worker_threads";

import { processSingleton } from "@/lib/process-singleton.mjs";
import type { VisitorAnalyticsProgress, VisitorAnalyticsSummaryData, VisitorEventInput } from "@/lib/types";

const DEFAULT_ANALYTICS_DB_PATH = path.join(process.cwd(), "data", "wiki-analytics.sqlite");
// The worker runs this plain module unbundled, the way `server.mjs` loads its `src/lib` modules,
// so the path is resolved from the project directory rather than from the bundled route code.
const WORKER_SCRIPT_PATH = path.join(process.cwd(), "src", "lib", "visitor-analytics-worker.mjs");

/** Numbers younger than this are served from memory instead of being read again. */
const SUMMARY_MAX_AGE_MS = 60_000;
/** Shorter while visits are still being folded, so the numbers fill in visibly. */
const INCOMPLETE_SUMMARY_MAX_AGE_MS = 10_000;
/** An explicit refresh reads again once the numbers are at least this old. */
const SUMMARY_MIN_REFRESH_MS = 2_000;
/** Longest time a stats request waits for fresh numbers before answering with what it has. */
const SUMMARY_WAIT_MS = 2_500;
/** A worker that leaves a request unanswered this long without any message is restarted. */
const UNRESPONSIVE_MS = 60_000;
/** Allowance after the worker announced a long step (index drop, compaction). */
const LONG_STEP_ALLOWANCE_MS = 30 * 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
/** A worker that ran this long without failing resets the restart backoff. */
const HEALTHY_RUN_MS = 10 * 60_000;
const CLOSE_TIMEOUT_MS = 2_000;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type WorkerMessage =
  | { type: "ready"; progress: VisitorAnalyticsProgress | null }
  | { type: "progress"; progress: VisitorAnalyticsProgress | null }
  | { type: "busy"; step: string }
  | { type: "fatal"; error: string }
  | { type: "reply"; id: number; value?: unknown; error?: string };

type AnalyticsWorkerState = {
  dbPath: string | null;
  failure: { message: string; restarts: number; retryAt: number } | null;
  lastMessageAt: number;
  longStepUntil: number;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  progress: VisitorAnalyticsProgress | null;
  salt: string | null;
  startedAt: number;
  summary: VisitorAnalyticsSummaryData | null;
  summaryError: string | null;
  summaryRequest: Promise<void> | null;
  watchdog: ReturnType<typeof setInterval> | null;
  worker: Worker | null;
};

export type VisitorAnalyticsSnapshot = {
  error: string | null;
  progress: VisitorAnalyticsProgress | null;
  refreshing: boolean;
  summary: VisitorAnalyticsSummaryData | null;
};

const analyticsWorker = processSingleton("visitorAnalytics.worker", (): AnalyticsWorkerState => ({
  dbPath: null,
  failure: null,
  lastMessageAt: 0,
  longStepUntil: 0,
  nextRequestId: 1,
  pending: new Map(),
  progress: null,
  salt: null,
  startedAt: 0,
  summary: null,
  summaryError: null,
  summaryRequest: null,
  watchdog: null,
  worker: null,
}));

const getAnalyticsDbPath = (): string => process.env.WIKI_ANALYTICS_DB_PATH?.trim() || DEFAULT_ANALYTICS_DB_PATH;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const stopWatchdog = (): void => {
  if (analyticsWorker.watchdog) {
    clearInterval(analyticsWorker.watchdog);
  }
  analyticsWorker.watchdog = null;
};

const rejectPending = (message: string): void => {
  const pending = [...analyticsWorker.pending.values()];
  analyticsWorker.pending.clear();
  stopWatchdog();
  for (const request of pending) {
    request.reject(new Error(message));
  }
};

const detachWorker = (): Worker | null => {
  const { worker } = analyticsWorker;
  analyticsWorker.worker = null;
  analyticsWorker.progress = null;
  analyticsWorker.longStepUntil = 0;
  worker?.removeAllListeners();
  return worker;
};

/** Stops a failed worker; the next request starts a new one after a growing delay. */
const failWorker = (reason: string): void => {
  const worker = detachWorker();
  void worker?.terminate();
  const message = `Visitor analytics are unavailable: ${reason}`;
  const healthy = Date.now() - analyticsWorker.startedAt >= HEALTHY_RUN_MS;
  const restarts = healthy ? 1 : (analyticsWorker.failure?.restarts ?? 0) + 1;
  analyticsWorker.failure = { message, restarts, retryAt: Date.now() + Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (restarts - 1)) };
  console.warn(`[visitors] ${message}`);
  rejectPending(message);
};

const handleWorkerMessage = (message: WorkerMessage): void => {
  analyticsWorker.lastMessageAt = Date.now();
  analyticsWorker.longStepUntil = 0;
  switch (message.type) {
    case "ready":
      analyticsWorker.failure = null;
      analyticsWorker.progress = message.progress;
      return;
    case "progress":
      analyticsWorker.progress = message.progress;
      return;
    case "busy":
      analyticsWorker.longStepUntil = Date.now() + LONG_STEP_ALLOWANCE_MS;
      return;
    case "fatal":
      failWorker(message.error);
      return;
    case "reply": {
      const request = analyticsWorker.pending.get(message.id);
      analyticsWorker.pending.delete(message.id);
      if (analyticsWorker.pending.size === 0) {
        stopWatchdog();
      }
      if (message.error !== undefined) {
        request?.reject(new Error(message.error));
      } else {
        request?.resolve(message.value);
      }
    }
  }
};

const startWatchdog = (): void => {
  if (analyticsWorker.watchdog) {
    return;
  }
  analyticsWorker.watchdog = setInterval(() => {
    const deadline = Math.max(analyticsWorker.lastMessageAt + UNRESPONSIVE_MS, analyticsWorker.longStepUntil);
    if (analyticsWorker.pending.size > 0 && Date.now() > deadline) {
      failWorker("the analytics worker stopped responding.");
    }
  }, WATCHDOG_INTERVAL_MS);
  analyticsWorker.watchdog.unref?.();
};

const resetForDatabase = (dbPath: string): void => {
  const worker = detachWorker();
  if (worker) {
    worker.postMessage({ type: "close" });
  }
  rejectPending("The analytics database changed.");
  analyticsWorker.dbPath = dbPath;
  analyticsWorker.failure = null;
  analyticsWorker.salt = null;
  analyticsWorker.summary = null;
  analyticsWorker.summaryError = null;
  analyticsWorker.summaryRequest = null;
};

const ensureWorker = (): Worker => {
  const dbPath = getAnalyticsDbPath();
  if (analyticsWorker.dbPath !== dbPath) {
    resetForDatabase(dbPath);
  }
  if (analyticsWorker.worker) {
    return analyticsWorker.worker;
  }
  if (analyticsWorker.failure && Date.now() < analyticsWorker.failure.retryAt) {
    throw new Error(analyticsWorker.failure.message);
  }

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SCRIPT_PATH, { workerData: { dbPath } });
  } catch (error) {
    failWorker(errorMessage(error));
    throw new Error(analyticsWorker.failure?.message ?? errorMessage(error));
  }
  // Analytics must never keep the process alive on its own.
  worker.unref();
  worker.on("message", handleWorkerMessage);
  worker.on("error", (error) => failWorker(errorMessage(error)));
  worker.on("exit", (code) => {
    if (analyticsWorker.worker === worker) {
      failWorker(`the analytics worker exited with code ${code}.`);
    }
  });
  analyticsWorker.worker = worker;
  analyticsWorker.startedAt = Date.now();
  return worker;
};

const requestWorker = <T>(message: Record<string, unknown>): Promise<T> => {
  let worker: Worker;
  try {
    worker = ensureWorker();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  const id = analyticsWorker.nextRequestId;
  analyticsWorker.nextRequestId += 1;
  return new Promise<T>((resolve, reject) => {
    if (analyticsWorker.pending.size === 0) {
      analyticsWorker.lastMessageAt = Date.now();
    }
    analyticsWorker.pending.set(id, { reject, resolve: resolve as (value: unknown) => void });
    startWatchdog();
    worker.postMessage({ ...message, id });
  });
};

/** The salt for hashing client addresses; read once and kept in memory. */
export const getVisitorAnalyticsSalt = async (): Promise<string> => {
  if (analyticsWorker.salt === null) {
    const dbPath = getAnalyticsDbPath();
    const salt = await requestWorker<string>({ type: "salt" });
    if (analyticsWorker.dbPath === dbPath) {
      analyticsWorker.salt = salt;
    }
    return salt;
  }
  return analyticsWorker.salt;
};

/** Stores a batch of visits in one transaction; duplicates by visitor and event ID are skipped. */
export const recordVisitorEvents = (events: VisitorEventInput[]): Promise<{ duplicates: number; recorded: number }> =>
  requestWorker({ type: "record", events });

const startSummaryRefresh = (): Promise<void> => {
  const dbPath = analyticsWorker.dbPath;
  const refresh = requestWorker<VisitorAnalyticsSummaryData>({ type: "summary", now: Date.now() })
    .then(
      (summary) => {
        if (analyticsWorker.dbPath === dbPath) {
          analyticsWorker.summary = summary;
          analyticsWorker.summaryError = null;
        }
      },
      (error: unknown) => {
        analyticsWorker.summaryError = errorMessage(error);
      },
    )
    .finally(() => {
      if (analyticsWorker.summaryRequest === refresh) {
        analyticsWorker.summaryRequest = null;
      }
    });
  analyticsWorker.summaryRequest = refresh;
  return refresh;
};

const summaryNeedsRefresh = (refresh: boolean): boolean => {
  const { summary } = analyticsWorker;
  if (!summary) {
    return true;
  }
  const age = Date.now() - summary.computedAt;
  if (!summary.complete && (age > INCOMPLETE_SUMMARY_MAX_AGE_MS || !analyticsWorker.progress)) {
    return true;
  }
  return age > SUMMARY_MAX_AGE_MS || (refresh && age > SUMMARY_MIN_REFRESH_MS);
};

/**
 * Returns the latest analytics numbers. They are read again only when they are older than
 * `SUMMARY_MAX_AGE_MS` (or on an explicit refresh), and a request waits at most
 * `SUMMARY_WAIT_MS` for that before answering with what it has and `refreshing: true`.
 */
export const loadVisitorAnalytics = async ({ refresh = false }: { refresh?: boolean } = {}): Promise<VisitorAnalyticsSnapshot> => {
  if (analyticsWorker.dbPath !== getAnalyticsDbPath()) {
    resetForDatabase(getAnalyticsDbPath());
  }
  if (summaryNeedsRefresh(refresh)) {
    const pending = analyticsWorker.summaryRequest ?? startSummaryRefresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SUMMARY_WAIT_MS);
    })]);
    clearTimeout(timer);
  }

  return {
    error: analyticsWorker.failure?.message ?? analyticsWorker.summaryError,
    progress: analyticsWorker.progress,
    refreshing: analyticsWorker.summaryRequest !== null,
    summary: analyticsWorker.summary,
  };
};

/** Closes the worker and forgets every cached value (tests use a new database each time). */
export const resetVisitorAnalyticsStorageForTests = async (): Promise<void> => {
  const worker = detachWorker();
  rejectPending("The analytics worker was stopped.");
  analyticsWorker.dbPath = null;
  analyticsWorker.failure = null;
  analyticsWorker.salt = null;
  analyticsWorker.summary = null;
  analyticsWorker.summaryError = null;
  analyticsWorker.summaryRequest = null;
  if (!worker) {
    return;
  }
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  worker.postMessage({ type: "close" });
  const timer = setTimeout(() => void worker.terminate(), CLOSE_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
};
