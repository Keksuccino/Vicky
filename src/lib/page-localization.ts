import { getHeapStatistics } from "node:v8";

import { ApiError, parseRetryAfterMs } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { requestOpenRouterChatCompletion } from "@/lib/openrouter";
import {
  enqueueGitHubLocalizationUpload,
  type GitHubLocalizationUploadEvent,
} from "@/lib/github-localization-upload-queue";
import {
  DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { getDetailedAutoTranslateErrorMessage } from "@/lib/auto-translate-logging";
import { loadGitHubBlobs } from "@/lib/github-content-store";
import { getGitHubDocsCacheDir } from "@/lib/github-docs-cache-files";
import { loadGitHubLocalizationStatuses, type GitHubLocalizationStatus } from "@/lib/github-localization";
import { isSourceLanguage } from "@/lib/page-localization-read";
import type {
  AutoTranslateLanguage,
  GitHubDocPage,
  GitHubRuntimeConfig,
} from "@/lib/types";

/**
 * Parallel OpenRouter requests of one job. Each request is one long completion (often 30–120 s
 * and thousands of output tokens for a page), so the binding limit is the upstream provider's
 * request and output-token quota for the account; OpenRouter sets no request cap for paid
 * models but blocks traffic that dramatically exceeds reasonable usage. Sixteen at a time
 * translates a site of about 1,000 page versions in roughly an hour at typical latencies while
 * staying inside common paid-tier quotas; going wider mostly turns into 429 responses, which
 * pause every worker of the job anyway (see `retry-after` handling below).
 */
const TRANSLATION_CONCURRENCY = 16;
/** Attempts per page, the first included; retries wait with exponential backoff and jitter. */
const TRANSLATION_MAX_ATTEMPTS = 6;
const TRANSLATION_RETRY_BASE_DELAY_MS = 2_000;
const TRANSLATION_RETRY_MAX_DELAY_MS = 60_000;
/** Longest `retry-after` a job waits out; a provider asking for more stops the job's translations. */
const TRANSLATION_MAX_RETRY_AFTER_MS = 15 * 60_000;
const TRANSLATION_MEMORY_CRITICAL_RATIO = 0.9;
const TRANSLATION_MEMORY_POLL_INTERVAL_MS = 1_000;
/** Longest wait for heap headroom before the job stops starting translations. */
const TRANSLATION_MEMORY_WAIT_LIMIT_MS = 2 * 60_000;

export type PageLocalizationLanguageStatus = {
  languageCode: string;
  languageName: string;
  sourceLanguage: boolean;
  currentPages: number;
  missingPages: number;
  outdatedPages: number;
  totalPages: number;
  /** Current translations (by commit dates) that do not record their source version yet; recording it makes their status exact. */
  unrecordedPages: number;
};

export type PageLocalizationRequestMode = "outdated" | "missing-and-outdated";

export type PageLocalizationRequestResult = {
  totalPages: number;
  cachedPages: number;
  requestedPages: number;
  translatedPages: number;
  uploadedPages: number;
  translationFailedPages: number;
  uploadFailedPages: number;
  failedPages: number;
  failures: Array<{
    slug: string;
    path: string;
    languageCode: string;
    stage: "translation" | "upload";
    error: string;
  }>;
};

type TranslationPayload = {
  page_display_name: string;
  page_description: string;
  page_content: string;
};

type TranslationCandidate = {
  /** Blob of the outdated translation being replaced, whose front matter the new one keeps. */
  existingSha?: string;
  language: AutoTranslateLanguage;
  previousStatus: "missing" | "outdated";
  sourcePage: GitHubDocPage;
};

type PageLocalizationEventSourcePage = Pick<GitHubDocPage, "path" | "slug">;

export type PageLocalizationTranslationEvent =
  | {
      /** Translations the store did not hold yet are being downloaded to check their status. */
      type: "reading-translations";
      downloaded: number;
      total: number;
    }
  | {
      type: "prepared";
      totalPages: number;
      currentPages: number;
      requestedPages: number;
      statuses: PageLocalizationLanguageStatus[];
      targetLanguages: number;
    }
  | {
      type: "page-start";
      attempt: number;
      maxAttempts: number;
      language: AutoTranslateLanguage;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "page-retry";
      attempt: number;
      maxAttempts: number;
      error: string;
      language: AutoTranslateLanguage;
      /** When the next attempt starts. */
      retryAt: string;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      /** No further translations start: none of them could succeed. Pages not started yet count as failed. */
      type: "translation-stopped";
      error: string;
    }
  | {
      type: "page-success";
      attempt: number;
      language: AutoTranslateLanguage;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "page-failed";
      attempts: number;
      error: string;
      language: AutoTranslateLanguage;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "upload-queued";
      flushAt: string;
      language: AutoTranslateLanguage;
      queueSize: number;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "uploads-waiting";
      queuedUploads: number;
    }
  | {
      type: "upload-start";
      attempt: number;
      batchSize: number;
      language: AutoTranslateLanguage;
      maxAttempts: number;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "upload-success";
      attempt: number;
      batchSize: number;
      commitSha: string;
      language: AutoTranslateLanguage;
      previousStatus: "missing" | "outdated";
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "upload-retry";
      attempt: number;
      batchSize: number;
      error: string;
      language: AutoTranslateLanguage;
      maxAttempts: number;
      retryAt: string;
      sourcePage: PageLocalizationEventSourcePage;
    }
  | {
      type: "upload-failed";
      attempts: number;
      batchSize: number;
      error: string;
      language: AutoTranslateLanguage;
      retryable: boolean;
      sourcePage: PageLocalizationEventSourcePage;
    };

const SYSTEM_PROMPT = `You are a professional Markdown documentation page translator.
Translate documentation pages into natural, clear language for the target audience.
Preserve Markdown formatting, links, image syntax, code fences, frontmatter meaning, and custom alert markers.
You receive pages as a JSON array with page title, page description, and page content.
Translate all three values, then return the translated content as the same JSON array syntax.
Only return the JSON array.`;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const getHeapUsageRatio = (): number => {
  const heapLimit = getHeapStatistics().heap_size_limit;
  if (!Number.isFinite(heapLimit) || heapLimit <= 0) {
    return 0;
  }

  return process.memoryUsage().heapUsed / heapLimit;
};

const getAdaptiveTranslationConcurrency = (maxConcurrency: number): number => {
  const ratio = getHeapUsageRatio();

  if (ratio >= 0.86) {
    return 1;
  }

  if (ratio >= 0.78) {
    return Math.max(1, Math.floor(maxConcurrency / 4));
  }

  if (ratio >= 0.7) {
    return Math.max(1, Math.floor(maxConcurrency / 2));
  }

  return maxConcurrency;
};

/** Waits until heap usage drops below the critical ratio; false when it stays above it for the whole wait limit. */
const waitForTranslationMemoryHeadroom = async (): Promise<boolean> => {
  const giveUpAt = Date.now() + TRANSLATION_MEMORY_WAIT_LIMIT_MS;
  while (getHeapUsageRatio() >= TRANSLATION_MEMORY_CRITICAL_RATIO) {
    if (Date.now() >= giveUpAt) {
      return false;
    }
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    await delay(TRANSLATION_MEMORY_POLL_INTERVAL_MS);
  }
  return true;
};

/**
 * Runs the iteratee over the values with a concurrency that shrinks under memory pressure. Once
 * `isStopped` reports true, values still waiting are passed through without waiting for memory,
 * so the iteratee can settle them at once.
 */
const runWithAdaptiveConcurrency = async <T, R>({
  isStopped,
  iteratee,
  maxConcurrency,
  onMemoryExhausted,
  onResult,
  values,
}: {
  isStopped: () => boolean;
  iteratee: (value: T, index: number) => Promise<R>;
  maxConcurrency: number;
  onMemoryExhausted: () => void;
  onResult: (result: R, value: T, index: number) => void;
  values: T[];
}): Promise<void> => {
  if (values.length === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let completed = 0;
    let index = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedulePump = () => {
      if (timer || stopped) {
        return;
      }

      timer = setTimeout(() => {
        timer = null;
        void pump();
      }, TRANSLATION_MEMORY_POLL_INTERVAL_MS);
    };

    const pump = async () => {
      if (stopped) {
        return;
      }

      if (completed >= values.length) {
        stopped = true;
        resolve();
        return;
      }

      if (active === 0 && !isStopped() && !(await waitForTranslationMemoryHeadroom())) {
        onMemoryExhausted();
      }

      const allowedConcurrency = isStopped()
        ? maxConcurrency
        : Math.max(1, Math.min(maxConcurrency, values.length, getAdaptiveTranslationConcurrency(maxConcurrency)));

      if (index < values.length && active >= allowedConcurrency) {
        schedulePump();
        return;
      }

      while (index < values.length && active < allowedConcurrency) {
        const currentIndex = index;
        const value = values[currentIndex];
        index += 1;
        active += 1;

        Promise.resolve(iteratee(value, currentIndex))
          .then((result) => {
            onResult(result, value, currentIndex);
          })
          .then(
            () => {
              active -= 1;
              completed += 1;
              void pump();
            },
            (error: unknown) => {
              stopped = true;
              reject(error);
            },
          );
      }
    };

    void pump();
  });
};

export type TranslationFailureClass = {
  /** Another attempt can succeed: rate limits, timeouts, provider and network failures, unusable model output. */
  retryable: boolean;
  /** No page of the job can succeed (rejected key, no credits, unknown model, upload queue closed): stop starting translations. */
  stopsJob: boolean;
  /** Pause the provider asked for; it applies to every request of the job. */
  retryAfterMs?: number;
};

const errorStatus = (error: unknown): number | undefined => {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
};

/**
 * Sorts a failed translation attempt by what another attempt could achieve, following
 * OpenRouter's documented error codes: 401 (key rejected), 404 (model or resource unknown), and
 * 402 without `retry-after` (no credits) fail every page; 408, 409, 425, 429, 402 with
 * `retry-after` (in-flight spending limit), and 5xx are transient; any other 4xx (bad request,
 * moderation, payload too large) fails only this page. Errors without a status are network
 * failures or unusable model output and are retried.
 */
export const classifyTranslationFailure = (error: unknown): TranslationFailureClass => {
  // Matched by name: the upload queue may come from another module graph of the same process.
  if (error instanceof Error && error.name === "GitHubLocalizationUploadQueueClosedError") {
    return { retryable: false, stopsJob: true };
  }

  const status = errorStatus(error);
  if (status === undefined) {
    return { retryable: true, stopsJob: false };
  }

  const retryAfterMs = error instanceof ApiError ? parseRetryAfterMs(new Headers(error.headers).get("retry-after")) : undefined;
  if (status === 401 || status === 404 || (status === 402 && retryAfterMs === undefined)) {
    return { retryable: false, stopsJob: true };
  }
  if (status === 402 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
    return { retryable: true, stopsJob: false, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  return { retryable: false, stopsJob: false };
};

/** Exponential backoff with equal jitter, and never shorter than the pause the provider asked for. */
export const translationRetryDelayMs = (attempt: number, retryAfterMs?: number, random: () => number = Math.random): number => {
  const exponential = Math.min(TRANSLATION_RETRY_MAX_DELAY_MS, TRANSLATION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.max(Math.round(exponential / 2 + random() * (exponential / 2)), retryAfterMs ?? 0);
};

const stripJsonCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
};

const parseJsonResponse = (value: string): unknown => {
  const normalized = stripJsonCodeFence(value);

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    const firstArrayIndex = normalized.indexOf("[");
    const lastArrayIndex = normalized.lastIndexOf("]");
    if (firstArrayIndex >= 0 && lastArrayIndex > firstArrayIndex) {
      try {
        return JSON.parse(normalized.slice(firstArrayIndex, lastArrayIndex + 1)) as unknown;
      } catch {
        throw new ApiError(502, "OpenRouter returned translation JSON that could not be parsed.");
      }
    }

    throw new ApiError(502, "OpenRouter returned translation JSON that could not be parsed.");
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const normalizeTranslationResponse = (value: string): TranslationPayload => {
  const parsed = parseJsonResponse(value);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const record = asRecord(first);
  const title = record.page_display_name;
  const description = record.page_description;
  const content = record.page_content;

  if (typeof title !== "string" || typeof description !== "string" || typeof content !== "string") {
    throw new ApiError(502, "OpenRouter returned an invalid page translation payload.");
  }

  return {
    page_display_name: title.trim(),
    page_description: description.trim(),
    page_content: content,
  };
};

const buildTranslationPrompt = (targetLanguageDisplayName: string, page: GitHubDocPage): string => {
  const payload: TranslationPayload[] = [
    {
      page_display_name: page.title,
      page_description: page.description,
      page_content: page.content,
    },
  ];

  return `Translate the following page to ${targetLanguageDisplayName}. Return only the translated JSON array, nothing else:

${JSON.stringify(payload, null, 2)}`;
};

/**
 * Writes a translation that records the source version it was made from. Front-matter keys an
 * author added to the translation it replaces are kept.
 */
const toTranslatedMarkdown = (sourcePage: GitHubDocPage, translation: TranslationPayload, existingMarkdown?: string): string => {
  const markdown = serializeMarkdownDocument(
    {
      title: translation.page_display_name || sourcePage.title,
      description: translation.page_description,
      content: translation.page_content,
      includeInPlaintextExport: sourcePage.includeInPlaintextExport,
      sourceBlobSha: sourcePage.sha,
    },
    existingMarkdown,
  );
  parseMarkdownDocument(markdown);
  return markdown;
};

type PageTranslationInput = {
  apiKey: string;
  config: GitHubRuntimeConfig;
  /** Blob of the translation being replaced; it is read from the content store before the paid request. */
  existingSha?: string;
  language: AutoTranslateLanguage;
  localizationPath: string;
  model: string;
  origin: string;
  requestTimeoutMs?: number;
  siteTitle: string;
  sourcePage: GitHubDocPage;
};

const requestTranslatedMarkdown = async ({
  apiKey,
  config,
  existingSha,
  language,
  model,
  origin,
  requestTimeoutMs = DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  siteTitle,
  sourcePage,
}: PageTranslationInput): Promise<string> => {
  const existing = existingSha ? (await loadGitHubBlobs(config, [existingSha], getGitHubDocsCacheDir())).get(existingSha) : undefined;
  const text = await requestOpenRouterChatCompletion({
    apiKey,
    model,
    origin,
    siteTitle,
    timeoutMs: requestTimeoutMs,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildTranslationPrompt(language.name, sourcePage),
      },
    ],
  });

  return toTranslatedMarkdown(sourcePage, normalizeTranslationResponse(text), existing?.markdown);
};

export const translatePageToQueuedGitHubLocalization = async ({
  onUploadEvent,
  ...input
}: PageTranslationInput & { onUploadEvent?: (event: GitHubLocalizationUploadEvent) => void }): Promise<{ upload: Promise<void> }> => {
  const { config, language, localizationPath, sourcePage } = input;
  const markdown = await requestTranslatedMarkdown(input);
  const queued = enqueueGitHubLocalizationUpload({
    config,
    language,
    localizationPath,
    onEvent: onUploadEvent,
    sourcePage,
    input: {
      markdown,
      includeInPlaintextExport: sourcePage.includeInPlaintextExport,
      commitMessage: `docs: update ${language.code} localization for ${sourcePage.path}`,
    },
  });

  return {
    upload: queued.upload,
  };
};

/**
 * Per-language counts for the admin status: undetermined translations count as current, as
 * readers serve them; `unrecordedPages` counts the current ones the stamping action can record.
 */
export const summarizePageLocalizationStatuses = (
  languages: AutoTranslateLanguage[],
  sourcePages: readonly GitHubDocPage[],
  localizations: Map<string, Map<string, GitHubLocalizationStatus>>,
): PageLocalizationLanguageStatus[] =>
  languages.map((language) => {
    const base = { languageCode: language.code, languageName: language.name, totalPages: sourcePages.length };
    if (isSourceLanguage(language)) {
      return { ...base, sourceLanguage: true, currentPages: sourcePages.length, missingPages: 0, outdatedPages: 0, unrecordedPages: 0 };
    }

    const byPath = localizations.get(language.code);
    const status = { ...base, sourceLanguage: false, currentPages: 0, missingPages: 0, outdatedPages: 0, unrecordedPages: 0 };
    for (const sourcePage of sourcePages) {
      const localization = byPath?.get(sourcePage.path);
      if (!localization) {
        status.missingPages += 1;
      } else if (localization.state === "outdated") {
        status.outdatedPages += 1;
      } else {
        status.currentPages += 1;
        if (localization.state === "current" && localization.summary && !localization.summary.sourceBlobSha) {
          status.unrecordedPages += 1;
        }
      }
    }
    return status;
  });

export const translatePageLocalizations = async ({
  apiKey,
  config,
  languages,
  localizationPath,
  mode,
  model,
  onEvent,
  origin,
  requestTimeoutMs = DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  siteTitle,
  sourcePages,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  languages: AutoTranslateLanguage[];
  localizationPath: string;
  mode: PageLocalizationRequestMode;
  model: string;
  onEvent?: (event: PageLocalizationTranslationEvent) => void;
  origin: string;
  requestTimeoutMs?: number;
  siteTitle: string;
  sourcePages: GitHubDocPage[];
}): Promise<PageLocalizationRequestResult> => {
  const targetLanguages = languages.filter((language) => !isSourceLanguage(language));
  const localizations = await loadGitHubLocalizationStatuses({
    config,
    languageCodes: targetLanguages.map((language) => language.code),
    localizationPath,
    onDownloadProgress: (downloaded, total) => onEvent?.({ type: "reading-translations", downloaded, total }),
    sourcePages,
  });
  const statuses = summarizePageLocalizationStatuses(languages, sourcePages, localizations);
  const currentPages = statuses.reduce((total, status) => total + (status.sourceLanguage ? 0 : status.currentPages), 0);
  const candidates: TranslationCandidate[] = targetLanguages.flatMap((language) =>
    sourcePages.flatMap((sourcePage): TranslationCandidate[] => {
      const localization = localizations.get(language.code)?.get(sourcePage.path);
      if (!localization) {
        return mode === "missing-and-outdated" ? [{ language, previousStatus: "missing", sourcePage }] : [];
      }
      return localization.state === "outdated" ? [{ existingSha: localization.sha, language, previousStatus: "outdated", sourcePage }] : [];
    }),
  );

  onEvent?.({
    type: "prepared",
    totalPages: sourcePages.length * targetLanguages.length,
    currentPages,
    requestedPages: candidates.length,
    statuses,
    targetLanguages: targetLanguages.length,
  });

  const toEventSourcePage = (sourcePage: GitHubDocPage): PageLocalizationEventSourcePage => ({
    path: sourcePage.path,
    slug: sourcePage.slug,
  });

  const toUploadEvent = (
    context: { language: AutoTranslateLanguage; previousStatus: "missing" | "outdated"; sourcePage: PageLocalizationEventSourcePage },
    event: GitHubLocalizationUploadEvent,
  ): PageLocalizationTranslationEvent => {
    if (event.type === "queued") {
      return {
        type: "upload-queued",
        flushAt: event.flushAt,
        language: context.language,
        queueSize: event.queueSize,
        sourcePage: context.sourcePage,
      };
    }

    if (event.type === "upload-start") {
      return {
        type: "upload-start",
        attempt: event.attempt,
        batchSize: event.batchSize,
        language: context.language,
        maxAttempts: event.maxAttempts,
        sourcePage: context.sourcePage,
      };
    }

    if (event.type === "upload-success") {
      return {
        type: "upload-success",
        attempt: event.attempt,
        batchSize: event.batchSize,
        commitSha: event.commitSha,
        language: context.language,
        previousStatus: context.previousStatus,
        sourcePage: context.sourcePage,
      };
    }

    if (event.type === "upload-retry") {
      return {
        type: "upload-retry",
        attempt: event.attempt,
        batchSize: event.batchSize,
        error: event.error,
        language: context.language,
        maxAttempts: event.maxAttempts,
        retryAt: event.retryAt,
        sourcePage: context.sourcePage,
      };
    }

    return {
      type: "upload-failed",
      attempts: event.attempts,
      batchSize: event.batchSize,
      error: event.error,
      language: context.language,
      retryable: event.retryable,
      sourcePage: context.sourcePage,
    };
  };

  /** Set once no further translation can succeed; candidates not started yet fail with it. */
  let stopReason: string | null = null;
  /** Provider-requested pause shared by every worker: a 429 for one request applies to all. */
  let pausedUntilMs = 0;
  const stopTranslations = (reason: string): void => {
    if (!stopReason) {
      stopReason = reason;
      onEvent?.({ type: "translation-stopped", error: reason });
    }
  };

  const translateCandidate = async (candidate: TranslationCandidate): Promise<{ ok: true; upload: Promise<void> } | { ok: false; error: string }> => {
    const maxAttempts = TRANSLATION_MAX_ATTEMPTS;
    const eventSourcePage = toEventSourcePage(candidate.sourcePage);
    const uploadEventContext = {
      language: candidate.language,
      previousStatus: candidate.previousStatus,
      sourcePage: eventSourcePage,
    };

    for (let attempt = 1; ; attempt += 1) {
      const pauseMs = pausedUntilMs - Date.now();
      if (pauseMs > 0 && !stopReason) {
        await delay(pauseMs);
      }
      if (stopReason) {
        return { ok: false, error: stopReason };
      }

      onEvent?.({
        type: "page-start",
        attempt,
        maxAttempts,
        language: candidate.language,
        sourcePage: eventSourcePage,
      });

      try {
        const pageInput: PageTranslationInput = {
          apiKey,
          config,
          existingSha: candidate.existingSha,
          language: candidate.language,
          localizationPath,
          model,
          origin,
          requestTimeoutMs,
          siteTitle,
          sourcePage: candidate.sourcePage,
        };
        const { upload } = await translatePageToQueuedGitHubLocalization({ ...pageInput, onUploadEvent: (event) => onEvent?.(toUploadEvent(uploadEventContext, event)) });

        onEvent?.({
          type: "page-success",
          attempt,
          language: candidate.language,
          sourcePage: eventSourcePage,
        });
        return { ok: true, upload };
      } catch (error: unknown) {
        const message = getDetailedAutoTranslateErrorMessage(error);
        const failure = classifyTranslationFailure(error);

        if (failure.retryAfterMs !== undefined && failure.retryAfterMs > TRANSLATION_MAX_RETRY_AFTER_MS) {
          stopTranslations(`OpenRouter asked to wait ${Math.ceil(failure.retryAfterMs / 60_000)} minutes before the next request. ${message}`);
        } else if (failure.stopsJob) {
          stopTranslations(message);
        } else if (failure.retryable && attempt < maxAttempts) {
          if (failure.retryAfterMs !== undefined) {
            pausedUntilMs = Math.max(pausedUntilMs, Date.now() + failure.retryAfterMs);
          }
          const delayMs = translationRetryDelayMs(attempt, failure.retryAfterMs);
          onEvent?.({
            type: "page-retry",
            attempt,
            maxAttempts,
            error: message,
            language: candidate.language,
            retryAt: new Date(Date.now() + delayMs).toISOString(),
            sourcePage: eventSourcePage,
          });
          await delay(delayMs);
          continue;
        }

        onEvent?.({
          type: "page-failed",
          attempts: attempt,
          error: message,
          language: candidate.language,
          sourcePage: eventSourcePage,
        });
        return { ok: false, error: message };
      }
    }
  };

  const failures: PageLocalizationRequestResult["failures"] = [];
  const uploads: Array<{ promise: Promise<{ candidate: TranslationCandidate; error: string | null }>; settled: boolean }> = [];
  let translatedPages = 0;

  await runWithAdaptiveConcurrency({
    values: candidates,
    maxConcurrency: TRANSLATION_CONCURRENCY,
    isStopped: () => stopReason !== null,
    iteratee: async (candidate) => translateCandidate(candidate),
    onMemoryExhausted: () => stopTranslations(`The server stayed low on memory for ${TRANSLATION_MEMORY_WAIT_LIMIT_MS / 60_000} minutes, so no further pages were translated.`),
    onResult: (result, candidate) => {
      if (!result.ok) {
        failures.push({
          slug: candidate.sourcePage.slug,
          path: candidate.sourcePage.path,
          languageCode: candidate.language.code,
          stage: "translation",
          error: result.error,
        });
        return;
      }

      translatedPages += 1;

      // Attach both settlement handlers immediately. A fast queue rejection must not surface as an unhandled rejection while other translations are still running.
      const tracked = { promise: Promise.resolve({ candidate, error: null as string | null }), settled: false };
      tracked.promise = result.upload.then(() => ({ candidate, error: null }), (error: unknown) => ({ candidate, error: getDetailedAutoTranslateErrorMessage(error) })).then((outcome) => {
        tracked.settled = true;
        return outcome;
      });
      uploads.push(tracked);
    },
  });

  let uploadedPages = 0;
  const pendingUploads = uploads.filter((upload) => !upload.settled).length;
  if (pendingUploads > 0) {
    onEvent?.({
      type: "uploads-waiting",
      queuedUploads: pendingUploads,
    });
  }
  if (uploads.length > 0) {
    const outcomes = await Promise.all(uploads.map((upload) => upload.promise));
    for (const outcome of outcomes) {
      if (!outcome.error) {
        uploadedPages += 1;
        continue;
      }

      failures.push({
        slug: outcome.candidate.sourcePage.slug,
        path: outcome.candidate.sourcePage.path,
        languageCode: outcome.candidate.language.code,
        stage: "upload",
        error: outcome.error,
      });
    }
  }

  const translationFailedPages = failures.filter((failure) => failure.stage === "translation").length;
  const uploadFailedPages = failures.filter((failure) => failure.stage === "upload").length;

  return {
    totalPages: sourcePages.length * targetLanguages.length,
    cachedPages: currentPages,
    requestedPages: candidates.length,
    translatedPages,
    uploadedPages,
    translationFailedPages,
    uploadFailedPages,
    failedPages: failures.length,
    failures,
  };
};

export const normalizeRequestedLocalizationLanguageCodes = (
  values: unknown,
  languages: AutoTranslateLanguage[],
): AutoTranslateLanguage[] => {
  if (!Array.isArray(values) || values.length === 0) {
    return languages.filter((language) => !isSourceLanguage(language));
  }

  const requested = new Set(
    values
      .map((value) => (typeof value === "string" ? normalizeAutoTranslateLanguageCode(value).toLowerCase() : ""))
      .filter(Boolean),
  );

  return languages.filter(
    (language) => !isSourceLanguage(language) && requested.has(normalizeAutoTranslateLanguageCode(language.code).toLowerCase()),
  );
};
