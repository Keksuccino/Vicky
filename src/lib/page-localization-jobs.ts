import {
  formatAutoTranslateLanguageForLog,
  getDetailedAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { createBackgroundJobSlot, type BackgroundJobState, type BackgroundJobStatus } from "@/lib/background-jobs";
import { listMarkdownDocsTreePagesWithTitles } from "@/lib/github";
import { recordGitHubLocalizationSourceVersions, type GitHubSourceVersionRecordingEvent } from "@/lib/github-localization-saves";
import {
  translatePageLocalizations,
  type PageLocalizationRequestMode,
  type PageLocalizationRequestResult,
  type PageLocalizationTranslationEvent,
} from "@/lib/page-localization";
import { isSourceLanguage, summarizePageLocalizationStatuses, type PageLocalizationLanguageStatus } from "@/lib/page-localization-read";
import type {
  AutoTranslateLanguage,
  GitHubRuntimeConfig,
} from "@/lib/types";

export type PageLocalizationJobStatus = BackgroundJobStatus;
/** `checking` and `uploading` are the phases of a source-version recording job. */
export type PageLocalizationJobPhase = "queued" | "checking" | "translating" | "uploading" | "finished";
/** A translation run, or `source-versions`: recording the source version in existing translations. */
export type PageLocalizationJobMode = PageLocalizationRequestMode | "source-versions";
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

export type PageLocalizationJobSnapshot = BackgroundJobState & {
  phase: PageLocalizationJobPhase;
  mode: PageLocalizationJobMode;
  languages: Array<Pick<AutoTranslateLanguage, "code" | "name">>;
  localizationPath: string;
  model: string;
  result: PageLocalizationRequestResult;
  statuses: PageLocalizationLanguageStatus[];
  logs: PageLocalizationJobLogEntry[];
};

export type PageLocalizationJobLookup = {
  state: "none" | "current" | "unknown";
  job: PageLocalizationJobSnapshot | null;
};

type PageLocalizationJob = PageLocalizationJobSnapshot & {
  /** Longest single step the job may wait on without reporting (one OpenRouter attempt). */
  attemptTimeoutMs: number;
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

type StartSourceVersionJobInput = {
  config: GitHubRuntimeConfig;
  /** Every configured language; the source language is left out of the recording. */
  languages: AutoTranslateLanguage[];
  localizationPath: string;
  /** Number of files the admin confirmed; a larger plan fails before anything is written. */
  maxFiles: number;
};

type JobDefinition = Pick<PageLocalizationJobSnapshot, "localizationPath" | "mode" | "model"> & {
  attemptTimeoutMs: number;
  languages: AutoTranslateLanguage[];
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

const addJobLog = (
  job: PageLocalizationJob,
  level: PageLocalizationJobLogLevel,
  message: string,
  options: Omit<PageLocalizationJobLogEntry, "createdAt" | "id" | "level" | "message"> = {},
): void => {
  job.logs.push({
    id: job.nextLogId,
    createdAt: new Date().toISOString(),
    level,
    message,
    ...options,
  });
  job.nextLogId += 1;

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

const createJob = (state: BackgroundJobState, definition: JobDefinition): PageLocalizationJob => ({
  ...state,
  phase: "queued",
  mode: definition.mode,
  languages: definition.languages.map((language) => ({
    code: language.code,
    name: language.name,
  })),
  localizationPath: definition.localizationPath,
  model: definition.model,
  result: emptyResult(),
  statuses: [],
  logs: [],
  attemptTimeoutMs: definition.attemptTimeoutMs,
  nextLogId: 1,
});

/** Moves a running job to its final state once; later results of a job that already finished are ignored. */
const finishJob = (
  job: PageLocalizationJob,
  outcome: { details?: string; error?: string; level: PageLocalizationJobLogLevel; message: string; result?: PageLocalizationRequestResult; status: Exclude<PageLocalizationJobStatus, "running"> },
): boolean => {
  if (!jobSlot.finish(job, outcome.status, outcome.error ?? null)) {
    return false;
  }

  if (outcome.result) {
    job.result = outcome.result;
  }
  job.phase = "finished";
  addJobLog(job, outcome.level, outcome.message, outcome.details ? { details: outcome.details } : {});
  return true;
};

/** Both job kinds write translations, so they share one slot and never overlap. */
const jobSlot = createBackgroundJobSlot<PageLocalizationJob>({
  idPrefix: "translation",
  name: "pageLocalization.jobSlot",
  onStalled: (job) =>
    finishJob(job, {
      details: `No progress for ${JOB_STALL_LIMIT_MS / 60_000} minutes. Start it again; files that were already committed are kept.`,
      error: "The job stopped making progress.",
      level: "error",
      message: "Job stopped because it made no progress.",
      status: "failed",
    }),
  stallLimitMs: JOB_STALL_LIMIT_MS,
  watchdogIntervalMs: JOB_WATCHDOG_INTERVAL_MS,
});

const formatLanguage = (language: Pick<AutoTranslateLanguage, "code" | "name">): string =>
  `${language.name || language.code} (${language.code})`;

const formatMode = (mode: PageLocalizationRequestMode): string =>
  mode === "outdated" ? "outdated pages" : "missing and outdated pages";

const formatPage = (event: Extract<PageLocalizationTranslationEvent, { sourcePage: { path: string; slug: string } }>): string =>
  event.sourcePage.slug || event.sourcePage.path || "unknown page";

/** Logs the start and the end of a status scan's downloads only; every download still counts as progress. */
const logTranslationDownloads = (job: PageLocalizationJob, downloaded: number, total: number): void => {
  if (downloaded === 0) {
    addJobLog(job, "info", `Downloading ${total} translation${total === 1 ? "" : "s"} from GitHub to check ${total === 1 ? "its" : "their"} status.`);
  } else if (downloaded === total) {
    addJobLog(job, "info", `Downloaded ${total} translation${total === 1 ? "" : "s"}.`);
  }
};

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
  jobSlot.noteProgress(job, nextActivityAtMs(job, event));

  if (event.type === "translation-stopped") {
    addJobLog(job, "error", "Stopped starting new translations.", { details: `Pages that were not translated yet count as failed. ${event.error}` });
    return;
  }

  if (event.type === "reading-translations") {
    logTranslationDownloads(job, event.downloaded, event.total);
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
  }
};

const updateJobFromSourceVersionEvent = (job: PageLocalizationJob, event: GitHubSourceVersionRecordingEvent): void => {
  if (job.status !== "running") {
    return;
  }
  jobSlot.noteProgress(job);

  if (event.type === "reading-translations") {
    logTranslationDownloads(job, event.downloaded, event.total);
    return;
  }

  if (event.type === "planned") {
    job.result = { ...job.result, requestedPages: event.files };
    const skipped = event.skipped.outdated + event.skipped.undetermined + event.skipped.unreadable;
    addJobLog(
      job,
      "info",
      event.files === 0
        ? "Every current translation already records its source version."
        : `Found ${event.files} current translation${event.files === 1 ? "" : "s"} that ${event.files === 1 ? "does" : "do"} not record ${event.files === 1 ? "its" : "their"} source version.`,
      skipped > 0
        ? {
            details: `Left ${skipped} as they are because their status is not certain (${event.skipped.outdated} outdated, ${event.skipped.undetermined} with an unknown commit date, ${event.skipped.unreadable} unreadable). The translation job records it when it updates them.`,
          }
        : {},
    );
    if (event.files > 0) {
      job.phase = "uploading";
    }
    return;
  }

  if (event.type === "sending") {
    addJobLog(job, "info", `Sent ${event.sentFiles} of ${event.totalFiles} translations to GitHub.`);
    return;
  }

  addJobLog(job, "success", `Committed ${event.files} translation${event.files === 1 ? "" : "s"} to GitHub.`, { details: `Commit ${event.commitSha}. Only the front matter changed.` });
};

const runSourceVersionJob = async (job: PageLocalizationJob, input: StartSourceVersionJobInput): Promise<void> => {
  try {
    job.startedAt = new Date().toISOString();
    job.phase = "checking";
    const targetLanguages = input.languages.filter((language) => !isSourceLanguage(language));
    addJobLog(job, "info", "Checking translations on GitHub.", { details: `Languages: ${targetLanguages.map(formatAutoTranslateLanguageForLog).join(", ")}.` });

    const outcome = await recordGitHubLocalizationSourceVersions({
      config: input.config,
      languageCodes: targetLanguages.map((language) => language.code),
      localizationPath: input.localizationPath,
      maxFiles: input.maxFiles,
      onEvent: (event) => updateJobFromSourceVersionEvent(job, event),
    });

    const recordedFiles = Array.from(outcome.recorded.values()).reduce((total, count) => total + count, 0);
    // Target languages only, like the statuses of translation jobs.
    job.statuses = summarizePageLocalizationStatuses(targetLanguages, outcome.sourcePages, outcome.statuses).map((status) => ({
      ...status,
      unrecordedPages: Math.max(0, status.unrecordedPages - (outcome.recorded.get(status.languageCode) ?? 0)),
    }));
    const failures = outcome.failures.map((failure) => ({ error: failure.error, languageCode: failure.languageCode, path: failure.sourcePage.path, slug: failure.sourcePage.slug, stage: "upload" as const }));
    finishJob(job, {
      level: failures.length > 0 ? "warning" : "success",
      message:
        outcome.plannedFiles === 0
          ? "Nothing to record."
          : `Recorded the source version in ${recordedFiles} translation${recordedFiles === 1 ? "" : "s"}${failures.length > 0 ? `; ${failures.length} could not be changed` : ""}.`,
      result: { ...emptyResult(), requestedPages: outcome.plannedFiles, uploadedPages: recordedFiles, uploadFailedPages: failures.length, failedPages: failures.length, failures },
      status: failures.length > 0 ? "completed_with_failures" : "completed",
    });
    for (const failure of failures) {
      addJobLog(job, "error", `Could not record the source version of ${failure.slug} in ${failure.languageCode}.`, { details: failure.error, languageCode: failure.languageCode, path: failure.path, slug: failure.slug });
    }
  } catch (error: unknown) {
    const message = getDetailedAutoTranslateErrorMessage(error);
    finishJob(job, { details: `${message} Nothing was committed.`, error: message, level: "error", message: "Recording source versions stopped.", status: "failed" });
  }
};

/** Starts a job unless one is running already, which then keeps running and logs the ignored request. */
const startJob = (definition: JobDefinition, queuedLog: { details: string; message: string }, run: (job: PageLocalizationJob) => Promise<void>): PageLocalizationJobSnapshot => {
  const { job, started } = jobSlot.start((state) => createJob(state, definition), run);
  if (started) {
    addJobLog(job, "info", queuedLog.message, { details: queuedLog.details });
  } else {
    addJobLog(job, "warning", "A new request was received while a job is already running.", {
      details: "Kept the current job running and ignored the new request.",
    });
  }
  return cloneJob(job);
};

export const startPageLocalizationJob = (input: StartPageLocalizationJobInput): PageLocalizationJobSnapshot =>
  startJob(
    { attemptTimeoutMs: input.requestTimeoutMs, languages: input.languages, localizationPath: input.localizationPath, mode: input.mode, model: input.model },
    {
      details: `Requested ${formatMode(input.mode)} for ${input.languages.length} target language${input.languages.length === 1 ? "" : "s"}.`,
      message: "Queued translation job.",
    },
    (job) => runPageLocalizationJob(job, input),
  );

/**
 * Records the source version in existing translations that lack it (see
 * `recordGitHubLocalizationSourceVersions`). Commits to the repository, so it only ever runs
 * when an admin starts it with the number of files they confirmed.
 */
export const startSourceVersionRecordingJob = (input: StartSourceVersionJobInput): PageLocalizationJobSnapshot =>
  startJob(
    { attemptTimeoutMs: 0, languages: input.languages.filter((language) => !isSourceLanguage(language)), localizationPath: input.localizationPath, mode: "source-versions", model: "" },
    { details: `Confirmed for up to ${input.maxFiles} translation${input.maxFiles === 1 ? "" : "s"}.`, message: "Queued recording source versions." },
    (job) => runSourceVersionJob(job, input),
  );

export const getLatestPageLocalizationJob = (): PageLocalizationJobSnapshot | null => {
  const job = jobSlot.latest();
  return job ? cloneJob(job) : null;
};

/**
 * Returns only the bounded in-process job snapshot. This lookup must remain free of repository,
 * provider, and filesystem refreshes because the admin client calls it while tracking active work.
 */
export const getPageLocalizationJobStatus = (jobId?: string): PageLocalizationJobLookup => {
  const job = jobSlot.latest();

  if (!job) {
    return { state: jobId ? "unknown" : "none", job: null };
  }

  if (jobId && job.id !== jobId) {
    return { state: "unknown", job: null };
  }

  return { state: "current", job: cloneJob(job, MAX_JOB_STATUS_LOG_ENTRIES) };
};
