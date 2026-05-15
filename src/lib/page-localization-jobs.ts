import {
  formatAutoTranslateLanguageForLog,
  getDetailedAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { listMarkdownDocsTreePagesWithTitles } from "@/lib/github";
import {
  translatePageLocalizations,
  type PageLocalizationRequestMode,
  type PageLocalizationRequestResult,
  type PageLocalizationTranslationEvent,
} from "@/lib/page-localization";
import type {
  AutoTranslateLanguage,
  GitHubRuntimeConfig,
} from "@/lib/types";

export type PageLocalizationJobStatus = "running" | "completed" | "completed_with_failures" | "failed";
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
  mode: PageLocalizationRequestMode;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  languages: Array<Pick<AutoTranslateLanguage, "code" | "name">>;
  localizationPath: string;
  model: string;
  result: PageLocalizationRequestResult;
  error: string | null;
  logs: PageLocalizationJobLogEntry[];
};

type PageLocalizationJob = PageLocalizationJobSnapshot & {
  promise: Promise<void> | null;
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
  siteTitle: string;
};

const PAGE_LOCALIZATION_JOB_STATE_KEY = Symbol.for("vicky.pageLocalization.jobState");
const MAX_JOB_LOG_ENTRIES = 2_000;

const emptyResult = (): PageLocalizationRequestResult => ({
  totalPages: 0,
  cachedPages: 0,
  requestedPages: 0,
  translatedPages: 0,
  failedPages: 0,
  failures: [],
});

const getPageLocalizationJobState = (): PageLocalizationJobState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, PageLocalizationJobState | undefined>;
  let state = globalState[PAGE_LOCALIZATION_JOB_STATE_KEY];

  if (!state) {
    state = {
      latestJob: null,
      nextJobId: 1,
      nextLogId: 1,
    };
    globalState[PAGE_LOCALIZATION_JOB_STATE_KEY] = state;
  }

  return state;
};

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

const cloneJob = (job: PageLocalizationJob): PageLocalizationJobSnapshot => ({
  id: job.id,
  status: job.status,
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
  error: job.error,
  logs: job.logs.map((entry) => ({ ...entry })),
});

const createJob = (input: StartPageLocalizationJobInput): PageLocalizationJob => {
  const state = getPageLocalizationJobState();
  const job: PageLocalizationJob = {
    id: `translation-${Date.now()}-${state.nextJobId}`,
    status: "running",
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
    error: null,
    logs: [],
    promise: null,
  };

  state.nextJobId += 1;
  return job;
};

const formatLanguage = (language: Pick<AutoTranslateLanguage, "code" | "name">): string =>
  `${language.name || language.code} (${language.code})`;

const formatMode = (mode: PageLocalizationRequestMode): string =>
  mode === "outdated" ? "outdated pages" : "missing and outdated pages";

const formatPage = (event: Extract<PageLocalizationTranslationEvent, { sourcePage: { path: string; slug: string } }>): string =>
  event.sourcePage.slug || event.sourcePage.path || "unknown page";

const updateJobFromEvent = (job: PageLocalizationJob, event: PageLocalizationTranslationEvent): void => {
  if (event.type === "prepared") {
    job.result = {
      ...job.result,
      totalPages: event.totalPages,
      cachedPages: event.currentPages,
      requestedPages: event.requestedPages,
    };
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
      details: `Attempt ${event.attempt} failed. ${event.maxAttempts - event.attempt} attempt${event.maxAttempts - event.attempt === 1 ? "" : "s"} left. ${event.error}`,
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
      details: `Batch size: ${event.batchSize} localization${event.batchSize === 1 ? "" : "s"}.`,
    });
    return;
  }

  if (event.type === "upload-success") {
    addJobLog(job, "success", `Uploaded ${page} to GitHub.`, {
      ...pageContext,
      details: `Commit ${event.commitSha}. Batch size: ${event.batchSize}.`,
    });
    return;
  }

  if (event.type === "upload-retry") {
    addJobLog(job, "warning", `GitHub upload for ${page} will retry.`, {
      ...pageContext,
      details: `Batch size: ${event.batchSize}. Next upload window: ${new Date(
        event.retryAt,
      ).toLocaleString()}. ${event.error}`,
    });
    return;
  }

  job.result = {
    ...job.result,
    failedPages: job.result.failedPages + 1,
    failures: [
      ...job.result.failures,
      {
        languageCode: event.language.code,
        path: event.sourcePage.path,
        slug: event.sourcePage.slug,
        error: event.error,
      },
    ],
  };
  addJobLog(job, "error", `Skipped ${page} to ${language} after ${event.attempts} failed attempts.`, {
    ...pageContext,
    details: event.error,
  });
};

const runPageLocalizationJob = async (job: PageLocalizationJob, input: StartPageLocalizationJobInput): Promise<void> => {
  job.startedAt = new Date().toISOString();
  addJobLog(job, "info", `Started translating ${formatMode(input.mode)}.`, {
    details: `Languages: ${input.languages.map(formatAutoTranslateLanguageForLog).join(", ")}. Model: ${input.model}.`,
  });

  try {
    addJobLog(job, "info", "Loading source pages from GitHub.");
    const { pages } = await listMarkdownDocsTreePagesWithTitles(input.config, { bypassCache: true, store: false });
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
      sourcePages: pages,
      siteTitle: input.siteTitle,
    });

    job.result = result;
    job.status = result.failedPages > 0 ? "completed_with_failures" : "completed";
    job.finishedAt = new Date().toISOString();
    addJobLog(
      job,
      result.failedPages > 0 ? "warning" : "success",
      `Translation job finished with ${result.translatedPages} translated and uploaded, ${result.cachedPages} current, and ${result.failedPages} failed.`,
    );
    logAutoTranslateInfo("Page localization background job finished", {
      jobId: job.id,
      translatedPages: result.translatedPages,
      failedPages: result.failedPages,
      requestedPages: result.requestedPages,
    });
  } catch (error: unknown) {
    const message = getDetailedAutoTranslateErrorMessage(error);
    job.status = "failed";
    job.error = message;
    job.finishedAt = new Date().toISOString();
    addJobLog(job, "error", "Translation job stopped before all pages could be processed.", {
      details: message,
    });
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

  job.promise = runPageLocalizationJob(job, input);
  return cloneJob(job);
};

export const getLatestPageLocalizationJob = (): PageLocalizationJobSnapshot | null => {
  const job = getPageLocalizationJobState().latestJob;
  return job ? cloneJob(job) : null;
};
