import { processSingleton } from "@/lib/process-singleton.mjs";

/**
 * Lifecycle shared by the admin's background jobs (translations, recording source versions,
 * warming the Markdown HTML cache): at most one running job per slot, one final state reached
 * exactly once, and a watchdog that fails a job reporting no progress for too long, so a job
 * can never stay running forever or block later ones. Jobs live in process memory; the admin
 * client polls the latest one, also after navigating away and back.
 */

export type BackgroundJobStatus = "running" | "completed" | "completed_with_failures" | "failed";

/**
 * Resolves after pending I/O callbacks ran (`setImmediate` follows the poll phase), so a
 * background loop of synchronous CPU work yields to request handling between two steps.
 */
export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What every job of a slot reports. */
export type BackgroundJobState = {
  id: string;
  status: BackgroundJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type SlotState<TJob extends BackgroundJobState> = {
  latest: TJob | null;
  nextJobId: number;
  /** The running job fails once it reported nothing by then; see `noteProgress`. */
  progressDeadlineAtMs: number;
  watchdog: ReturnType<typeof setInterval> | null;
};

export type BackgroundJobSlot<TJob extends BackgroundJobState> = {
  /** The latest job, running or finished. */
  latest: () => TJob | null;
  /**
   * Starts a job built by `create` unless one is running, which is returned instead
   * (`started: false`). `run` starts after the caller's current task, so the caller can log or
   * snapshot the job first; a rejection of `run` fails the job.
   */
  start: (create: (state: BackgroundJobState) => TJob, run: (job: TJob) => Promise<void>) => { job: TJob; started: boolean };
  /** Moves the stall deadline to the stall limit after the job's next expected activity (now by default). */
  noteProgress: (job: TJob, nextActivityAtMs?: number) => void;
  /** Moves a running job to its final state; false when it already had one (its later results are ignored). */
  finish: (job: TJob, status: Exclude<BackgroundJobStatus, "running">, error?: string | null) => boolean;
};

export const createBackgroundJobSlot = <TJob extends BackgroundJobState>({
  idPrefix,
  name,
  onStalled,
  stallLimitMs,
  watchdogIntervalMs,
}: {
  idPrefix: string;
  /** `processSingleton` name of the slot. */
  name: string;
  /** Called once a running job missed its deadline; it should finish the job (`finish`). */
  onStalled: (job: TJob) => void;
  stallLimitMs: number;
  watchdogIntervalMs: number;
}): BackgroundJobSlot<TJob> => {
  // Resolved on every access instead of once at module load, so removing the registration (as
  // tests do between cases) starts a fresh job history.
  const getState = (): SlotState<TJob> =>
    processSingleton(name, (): SlotState<TJob> => ({ latest: null, nextJobId: 1, progressDeadlineAtMs: 0, watchdog: null }));

  const stopWatchdog = (state: SlotState<TJob>): void => {
    if (state.watchdog) {
      clearInterval(state.watchdog);
      state.watchdog = null;
    }
  };

  const finish: BackgroundJobSlot<TJob>["finish"] = (job, status, error = null) => {
    if (job.status !== "running") {
      return false;
    }

    job.status = status;
    job.error = error;
    job.finishedAt = new Date().toISOString();
    const state = getState();
    if (state.latest === job) {
      stopWatchdog(state);
    }
    return true;
  };

  const noteProgress: BackgroundJobSlot<TJob>["noteProgress"] = (job, nextActivityAtMs = Date.now()) => {
    const state = getState();
    if (state.latest === job && job.status === "running") {
      state.progressDeadlineAtMs = Math.max(state.progressDeadlineAtMs, (Number.isFinite(nextActivityAtMs) ? nextActivityAtMs : Date.now()) + stallLimitMs);
    }
  };

  const start: BackgroundJobSlot<TJob>["start"] = (create, run) => {
    const state = getState();
    if (state.latest?.status === "running") {
      return { job: state.latest, started: false };
    }

    const job = create({
      id: `${idPrefix}-${Date.now()}-${state.nextJobId}`,
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    state.nextJobId += 1;
    state.latest = job;
    state.progressDeadlineAtMs = Date.now() + stallLimitMs;
    stopWatchdog(state);
    state.watchdog = setInterval(() => {
      if (job.status === "running" && Date.now() > state.progressDeadlineAtMs) {
        onStalled(job);
      }
      if (job.status !== "running") {
        stopWatchdog(state);
      }
    }, watchdogIntervalMs);
    state.watchdog.unref?.();

    void Promise.resolve()
      .then(() => run(job))
      .catch((error: unknown) => {
        finish(job, "failed", error instanceof Error ? error.message : String(error));
      });
    return { job, started: true };
  };

  return { finish, latest: () => getState().latest, noteProgress, start };
};
