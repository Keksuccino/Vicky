import {
  formatAutoTranslateLanguageForLog,
  getDetailedAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { listMarkdownDocsTreePagesWithTitles } from "@/lib/github";
import {
  translatePageLocalizations,
  type PageLocalizationLanguageStatus,
  type PageLocalizationRequestMode,
  type PageLocalizationRequestResult,
  type PageLocalizationTranslationEvent,
} from "@/lib/page-localization";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type {
  AutoTranslateLanguage,
  GitHubRuntimeConfig,
} from "@/lib/types";

export type PageLocalizationJobStatus = "running" | "completed" | "completed_with_failures" | "failed";
export type PageLocalizationJobPhase = "queued" | "translating" | "uploading" | "finished";
export type PageLocalizationJobLogLevel = "info" | "success" | "warning" | "error";

export type PageLocalizationJobLogEntry = {
  id: number;
  createdAt: string;
  level: PageLocalizationJobLogLevel;
  message: string;
  details?: string;
  languageCode?: string;
  path?: string;
  slug?: string;
};

export type PageLocalizationJobSnapshot = {
  id: string;
  status: PageLocalizationJobStatus;
  phase: PageLocalizationJobPhase;
  mode: PageLocalizationRequestMode;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  languages: Array<Pick<AutoTranslateLanguage, "code" | "name">>;
  localizationPath: string;
  model: string;
  result: PageLocalizationRequestResult;
  statuses: PageLocalizationLanguageStatus[];
  error: string | null;
  logs: PageLocalizationJobLogEntry[];
};

export type PageLocalizationJobLookup = {
  state: "none" | "current" | "unknown";
  job: PageLocalizationJobSnapshot | null;
};

type PageLocalizationJob = PageLocalizationJobSnapshot & {
  /** Longest single step the job may wait on without reporting (one OpenRouter attempt). */
  attemptTimeoutMs: number;
  /** The job fails if it reports no progress by then; see `noteJobProgress`. */
  progressDeadlineAtMs: number;
  promise: Promise<void> | null;
  watchdog: ReturnType<typeof setInterval> | null;
};

type PageLocalizationJobState = {
  latestJob: PageLocalizationJob | null;
  nextJobId: number;
  nextLogId: number;
};

type StartPageLocalizationJobInput = {
  apiKey: string;
  config: GitHubRuntimeConfig;
  languages: AutoTranslateLanguage[];
  localizationPath: string;
  mode: PageLocalizationRequestMode;
  model: string;
  origin: string;
  requestTimeoutMs: number;
  siteTitle: string;
};

const MAX_JOB_LOG_ENTRIES = 500;
const MAX_JOB_STATUS_LOG_ENTRIES = 200;
/**
 * A running job that reports nothing for this long past its next expected activity (a request
 * timeout, an upload window, a retry time) has hung, for example on a promise that never
 * settles. It is then failed, so it can never block later jobs.
 */
const JOB_STALL_LIMIT_MS = 15 * 60_000;
const JOB_WATCHDOG_INTERVAL_MS = 30_000;

const emptyResult = (): PageLocalizationRequestResult => ({
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

// Resolved on every access instead of once at module load, so removing the registration (as
// the job and status-route tests do between cases) starts a fresh job history.
const getPageLocalizationJobState = (): PageLocalizationJobState =>
  processSingleton("pageLocalization.jobState", (): PageLocalizationJobState => ({
    latestJob: null,
    nextJobId: 1,
    nextLogId: 1,
  }));

const addJobLog = (
  job: PageLocalizationJob,
  level: PageLocalizationJobLogLevel,
  message: string,
  options: Omit<PageLocalizationJobLogEntry, "createdAt" | "id" | "level" | "message"> = {},
): void => {
  const state = getPageLocalizationJobState();
  job.logs.push({
    id: state.nextLogId,
    createdAt: new Date().toISOString(),
    level,
    message,
    ...options,
  });
  state.nextLogId += 1;

  if (job.logs.length > MAX_JOB_LOG_ENTRIES) {
    job.logs.splice(0, job.logs.length - MAX_JOB_LOG_ENTRIES);
  }
};

const cloneJob = (job: PageLocalizationJob, logLimit = MAX_JOB_LOG_ENTRIES): PageLocalizationJobSnapshot => ({
  id: job.id,
  status: job.status,
  phase: job.phase,
  mode: job.mode,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  languages: job.languages.map((language) => ({ ...language })),
  localizationPath: job.localizationPath,
  model: job.model,
  result: {
    ...job.result,
    failures: job.result.failures.map((failure) => ({ ...failure })),
  },
  statuses: job.statuses.map((status) => ({ ...status })),
  error: job.error,
  logs: job.logs.slice(-Math.max(1, logLimit)).map((entry) => ({ ...entry })),
});

const createJob = (input: StartPageLocalizationJobInput): PageLocalizationJob => {
  const state = getPageLocalizationJobState();
  const job: PageLocalizationJob = {
    id: `translation-${Date.now()}-${state.nextJobId}`,
    status: "running",
    phase: "queued",
    mode: input.mode,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    languages: input.languages.map((language) => ({
      code: language.code,
      name: language.name,
    })),
    localizationPath: input.localizationPath,
    model: input.model,
    result: emptyResult(),
    statuses: [],
    error: null,
    logs: [],
    attemptTimeoutMs: input.requestTimeoutMs,
    progressDeadlineAtMs: Date.now() + JOB_STALL_LIMIT_MS,
    promise: null,
    watchdog: null,
  };

  state.nextJobId += 1;
  return job;
};

const noteJobProgress = (job: PageLocalizationJob, nextActivityAtMs = Date.now()): void => {
  job.progressDeadlineAtMs = Math.max(job.progressDeadlineAtMs, (Number.isFinite(nextActivityAtMs) ? nextActivityAtMs : Date.now()) + JOB_STALL_LIMIT_MS);
};

/** Moves a running job to its final state once; later results of a job that already finished are ignored. */
const finishJob = (
  job: PageLocalizationJob,
  outcome: { details?: string; error?: string; level: PageLocalizationJobLogLevel; message: string; result?: PageLocalizationRequestResult; status: Exclude<PageLocalizationJobStatus, "running"> },
): boolean => {
  if (job.status !== "running") {
    return false;
  }

  if (outcome.result) {
    job.result = outcome.result;
  }
  job.status = outcome.status;
  job.phase = "finished";
  job.error = outcome.error ?? null;
  job.finishedAt = new Date().toISOString();
  if (job.watchdog) {
    clearInterval(job.watchdog);
    job.watchdog = null;
  }
  addJobLog(job, outcome.level, outcome.message, outcome.details ? { details: outcome.details } : {});
  return true;
};

const startJobWatchdog = (job: PageLocalizationJob): void => {
  job.watchdog = setInterval(() => {
    if (Date.now() > job.progressDeadlineAtMs) {
      finishJob(job, {
        details: `No progress for ${JOB_STALL_LIMIT_MS / 60_000} minutes. Start the job again; translations that were already uploaded are kept.`,
        error: "The job stopped making progress.",
        level: "error",
        message: "Translation job stopped because it made no progress.",
        status: "failed",
      });
    }
  }, JOB_WATCHDOG_INTERVAL_MS);
  job.watchdog.unref?.();
};

const formatLanguage = (language: Pick<AutoTranslateLanguage, "code" | "name">): string =>
  `${language.name || language.code} (${language.code})`;

const formatMode = (mode: PageLocalizationRequestMode): string =>
  mode === "outdated" ? "outdated pages" : "missing and outdated pages";

const formatPage = (event: Extract<PageLocalizationTranslationEvent, { sourcePage: { path: string; slug: string } }>): string =>
  event.sourcePage.slug || event.sourcePage.path || "unknown page";

/** When the job reports next at the latest after this event: an attempt can take its timeout, a queued upload waits for its window. */
const nextActivityAtMs = (job: PageLocalizationJob, event: PageLocalizationTranslationEvent): number => {
  switch (event.type) {
    case "page-start":
      return Date.now() + job.attemptTimeoutMs;
    case "page-retry":
    case "upload-retry":
      return Date.parse(event.retryAt);
    case "upload-queued":
      return Date.parse(event.flushAt);
    default:
      return Date.now();
  }
};

const updateJobFromEvent = (job: PageLocalizationJob, event: PageLocalizationTranslationEvent): void => {
  if (job.status !== "running") {
    return;
  }
  noteJobProgress(job, nextActivityAtMs(job, event));

  if (event.type === "translation-stopped") {
    addJobLog(job, "error", "Stopped starting new translations.", { details: `Pages that were not translated yet count as failed. ${event.error}` });
    return;
  }

  if (event.type === "reading-translations") {
    // Logged at the start and at the end only; every download still counts as progress.
    if (event.downloaded === 0 || event.downloaded === event.total) {
      addJobLog(
        job,
        "info",
        event.downloaded === 0
          ? `Downloading ${event.total} translation${event.total === 1 ? "" : "s"} from GitHub to check ${event.total === 1 ? "its" : "their"} status.`
          : `Downloaded ${event.total} translation${event.total === 1 ? "" : "s"}.`,
      );
    }
    return;
  }

  if (event.type === "prepared") {
    job.result = {
      ...job.result,
      totalPages: event.totalPages,
      cachedPages: event.currentPages,
      requestedPages: event.requestedPages,
    };
    job.statuses = event.statuses.map((status) => ({ ...status }));
    addJobLog(
      job,
      "info",
      `Prepared ${event.requestedPages} page translation${event.requestedPages === 1 ? "" : "s"} across ${event.targetLanguages} target language${event.targetLanguages === 1 ? "" : "s"}.`,
      {
        details: `${event.currentPages} page localization${event.currentPages === 1 ? "" : "s"} already current.`,
      },
    );
    return;
  }

  if (event.type === "uploads-waiting") {
    job.phase = "uploading";
    addJobLog(
      job,
      "warning",
      "Finished translating pages. Waiting for the GitHub cooldown to sync translations to GitHub.",
      {
        details: `${event.queuedUploads} queued GitHub upload${event.queuedUploads === 1 ? "" : "s"} still pending.`,
      },
    );
    return;
  }

  const page = formatPage(event);
  const language = formatLanguage(event.language);
  const pageContext = {
    languageCode: event.language.code,
    path: event.sourcePage.path,
    slug: event.sourcePage.slug,
  };

  if (event.type === "page-start") {
    addJobLog(job, "info", `Translating ${page} to ${language}.`, {
      ...pageContext,
      details: `Attempt ${event.attempt} of ${event.maxAttempts}.`,
    });
    return;
  }

  if (event.type === "page-retry") {
    addJobLog(job, "warning", `Retrying ${page} to ${language}.`, {
      ...pageContext,
      details: `Attempt ${event.attempt} failed. ${event.maxAttempts - event.attempt} attempt${event.maxAttempts - event.attempt === 1 ? "" : "s"} left, next at ${new Date(event.retryAt).toLocaleTimeString()}. ${event.error}`,
    });
    return;
  }

  if (event.type === "page-success") {
    job.result = {
      ...job.result,
      translatedPages: job.result.translatedPages + 1,
    };
    addJobLog(job, "success", `Generated ${page} translation for ${language}.`, {
      ...pageContext,
      details: `Translation completed on attempt ${event.attempt}. Waiting for the queued GitHub upload.`,
    });
    return;
  }

  if (event.type === "upload-queued") {
    addJobLog(job, "info", `Queued GitHub upload for ${page} to ${language}.`, {
      ...pageContext,
      details: `Upload queue contains ${event.queueSize} item${event.queueSize === 1 ? "" : "s"}. Next upload window: ${new Date(
        event.flushAt,
      ).toLocaleString()}.`,
    });
    return;
  }

  if (event.type === "upload-start") {
    addJobLog(job, "info", `Uploading ${page} to GitHub.`, {
      ...pageContext,
      details: `Attempt ${event.attempt} of ${event.maxAttempts}. Batch size: ${event.batchSize} localization${event.batchSize === 1 ? "" : "s"}.`,
    });
    return;
  }

  if (event.type === "upload-success") {
    job.result = {
      ...job.result,
      uploadedPages: job.result.uploadedPages + 1,
    };
    const languageStatus = job.statuses.find((status) => status.languageCode.toLowerCase() === event.language.code.toLowerCase());
    if (languageStatus && !languageStatus.sourceLanguage) {
      languageStatus.currentPages += 1;
      if (event.previousStatus === "missing") {
        languageStatus.missingPages = Math.max(0, languageStatus.missingPages - 1);
      } else {
        languageStatus.outdatedPages = Math.max(0, languageStatus.outdatedPages - 1);
      }
    }
    addJobLog(job, "success", `Uploaded ${page} to GitHub.`, {
      ...pageContext,
      details: `Commit ${event.commitSha}. Upload completed on attempt ${event.attempt}. Batch size: ${event.batchSize}.`,
    });
    return;
  }

  if (event.type === "upload-retry") {
    addJobLog(job, "warning", `GitHub upload for ${page} will retry.`, {
      ...pageContext,
      details: `Attempt ${event.attempt} of ${event.maxAttempts} failed. Batch size: ${event.batchSize}. Next upload window: ${new Date(
        event.retryAt,
      ).toLocaleString()}. ${event.error}`,
    });
    return;
  }

  if (event.type === "upload-failed") {
    job.result = {
      ...job.result,
      uploadFailedPages: job.result.uploadFailedPages + 1,
      failedPages: job.result.failedPages + 1,
      failures: [
        ...job.result.failures,
        {
          languageCode: event.language.code,
          path: event.sourcePage.path,
          slug: event.sourcePage.slug,
          stage: "upload",
          error: event.error,
        },
      ],
    };
    addJobLog(job, "error", `GitHub upload failed for ${page} in ${language}.`, {
      ...pageContext,
      details: `${event.retryable ? `Stopped after ${event.attempts} attempts.` : "GitHub rejected the upload permanently."} Batch size: ${event.batchSize}. ${event.error}`,
    });
    return;
  }

  job.result = {
    ...job.result,
    translationFailedPages: job.result.translationFailedPages + 1,
    failedPages: job.result.failedPages + 1,
    failures: [
      ...job.result.failures,
      {
        languageCode: event.language.code,
        path: event.sourcePage.path,
        slug: event.sourcePage.slug,
        stage: "translation",
        error: event.error,
      },
    ],
  };
  addJobLog(job, "error", `Skipped ${page} to ${language} after ${event.attempts} failed attempt${event.attempts === 1 ? "" : "s"}.`, {
    ...pageContext,
    details: event.error,
  });
};

const runPageLocalizationJob = async (job: PageLocalizationJob, input: StartPageLocalizationJobInput): Promise<void> => {
  try {
    job.startedAt = new Date().toISOString();
    job.phase = "translating";
    addJobLog(job, "info", `Started translating ${formatMode(input.mode)}.`, {
      details: `Languages: ${input.languages.map(formatAutoTranslateLanguageForLog).join(", ")}. Model: ${input.model}.`,
    });
    addJobLog(job, "info", "Loading source pages from GitHub.");
    const { pages } = await listMarkdownDocsTreePagesWithTitles(input.config, { bypassCache: true });
    addJobLog(job, "info", `Loaded ${pages.length} source page${pages.length === 1 ? "" : "s"} from GitHub.`);

    const result = await translatePageLocalizations({
      apiKey: input.apiKey,
      config: input.config,
      languages: input.languages,
      localizationPath: input.localizationPath,
      mode: input.mode,
      model: input.model,
      onEvent: (event) => updateJobFromEvent(job, event),
      origin: input.origin,
      queueUploads: true,
      requestTimeoutMs: input.requestTimeoutMs,
      sourcePages: pages,
      siteTitle: input.siteTitle,
    });

    const finished = finishJob(job, {
      level: result.failedPages > 0 ? "warning" : "success",
      message: `Translation job finished with ${result.translatedPages} translated, ${result.uploadedPages} uploaded, ${result.cachedPages} current, and ${result.failedPages} failed.`,
      result,
      status: result.failedPages > 0 ? "completed_with_failures" : "completed",
    });
    if (finished) {
      logAutoTranslateInfo("Page localization background job finished", {
        jobId: job.id,
        translatedPages: result.translatedPages,
        failedPages: result.failedPages,
        requestedPages: result.requestedPages,
      });
    }
  } catch (error: unknown) {
    const message = getDetailedAutoTranslateErrorMessage(error);
    finishJob(job, { details: message, error: message, level: "error", message: "Translation job stopped before all pages could be processed.", status: "failed" });
    logAutoTranslateInfo("Page localization background job failed", {
      jobId: job.id,
      error: message,
    });
  } finally {
    job.promise = null;
  }
};

export const startPageLocalizationJob = (input: StartPageLocalizationJobInput): PageLocalizationJobSnapshot => {
  const state = getPageLocalizationJobState();
  const activeJob = state.latestJob;

  if (activeJob?.status === "running") {
    addJobLog(activeJob, "warning", "A new translation request was received while a job is already running.", {
      details: "Kept the current job running and ignored the duplicate start request.",
    });
    return cloneJob(activeJob);
  }

  const job = createJob(input);
  state.latestJob = job;
  addJobLog(job, "info", "Queued translation job.", {
    details: `Requested ${formatMode(input.mode)} for ${input.languages.length} target language${input.languages.length === 1 ? "" : "s"}.`,
  });

  startJobWatchdog(job);
  job.promise = Promise.resolve().then(() => runPageLocalizationJob(job, input));
  return cloneJob(job);
};

export const getLatestPageLocalizationJob = (): PageLocalizationJobSnapshot | null => {
  const job = getPageLocalizationJobState().latestJob;
  return job ? cloneJob(job) : null;
};

/**
 * Returns only the bounded in-process job snapshot. This lookup must remain free of repository,
 * provider, and filesystem refreshes because the admin client calls it while tracking active work.
 */
export const getPageLocalizationJobStatus = (jobId?: string): PageLocalizationJobLookup => {
  const job = getPageLocalizationJobState().latestJob;

  if (!job) {
    return { state: jobId ? "unknown" : "none", job: null };
  }

  if (jobId && job.id !== jobId) {
    return { state: "unknown", job: null };
  }

  return { state: "current", job: cloneJob(job, MAX_JOB_STATUS_LOG_ENTRIES) };
};
