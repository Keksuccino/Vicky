import { createBackgroundJobSlot, type BackgroundJobState } from "@/lib/background-jobs";
import { assertGitHubRuntimeConfigActive } from "@/lib/github-cache-invalidation";
import { assertValidGitHubRuntimeConfig } from "@/lib/github-docs-source";
import { ApiError } from "@/lib/http";
import { planMarkdownRenderCacheWarm } from "@/lib/markdown-render-cache-admin";
import { flushRenderedMarkdownCacheIndex } from "@/lib/markdown-render-cache-store";
import type { DocsStore, GitHubRuntimeConfig } from "@/lib/types";

/**
 * Warming the Markdown HTML cache as a background job: the admin's request returns at once, the
 * job renders every missing variant one at a time (yielding to requests between two renders, see
 * `planMarkdownRenderCacheWarm`), reports its progress, and keeps running when the admin leaves
 * the page. One job runs at a time; starting while one runs returns the running one.
 */

/** A job that reports no finished variant for this long has hung (no single blob download or render takes that long) and is failed. */
const WARM_JOB_STALL_LIMIT_MS = 5 * 60_000;
const WARM_JOB_WATCHDOG_INTERVAL_MS = 15_000;
/** Variants whose content loads at the same time (blob reads, downloads at bulk priority); they still render one at a time. */
const WARM_JOB_CONTENT_CONCURRENCY = 4;
/** Failures a snapshot lists; `failedVariants` counts all of them. */
const MAX_REPORTED_FAILURES = 20;

export type MarkdownRenderCacheWarmJobPhase = "planning" | "rendering" | "finished";

export type MarkdownRenderCacheWarmJobSnapshot = BackgroundJobState & {
  phase: MarkdownRenderCacheWarmJobPhase;
  totalPages: number;
  /** Variants of every page, cached or not. */
  totalVariants: number;
  /** Variants without HTML when the job planned its work; `processedVariants` counts up to it. */
  missingVariants: number;
  processedVariants: number;
  renderedVariants: number;
  /** Missing variants whose HTML a page view stored meanwhile. */
  skippedVariants: number;
  failedVariants: number;
  failures: Array<{ error: string; languageCode: string; slug: string }>;
  /** Estimated seconds until the last variant is processed; `null` until the first one is. */
  etaSeconds: number | null;
};

const finishWarmJob = (job: MarkdownRenderCacheWarmJobSnapshot, status: "completed" | "completed_with_failures" | "failed", error: string | null = null): void => {
  if (warmJobSlot.finish(job, status, error)) {
    job.phase = "finished";
    job.etaSeconds = null;
  }
};

const warmJobSlot = createBackgroundJobSlot<MarkdownRenderCacheWarmJobSnapshot>({
  idPrefix: "markdown-cache",
  name: "markdownRender.warmJobSlot",
  onStalled: (job) => finishWarmJob(job, "failed", `The job made no progress for ${WARM_JOB_STALL_LIMIT_MS / 60_000} minutes. Start it again; the HTML stored so far is kept.`),
  stallLimitMs: WARM_JOB_STALL_LIMIT_MS,
  watchdogIntervalMs: WARM_JOB_WATCHDOG_INTERVAL_MS,
});

const toSnapshot = (job: MarkdownRenderCacheWarmJobSnapshot): MarkdownRenderCacheWarmJobSnapshot => ({ ...job, failures: job.failures.map((failure) => ({ ...failure })) });

const recordProgress = (job: MarkdownRenderCacheWarmJobSnapshot, renderStartedAtMs: number): void => {
  job.processedVariants += 1;
  const elapsedMs = Date.now() - renderStartedAtMs;
  job.etaSeconds = Math.ceil(((elapsedMs / job.processedVariants) * Math.max(0, job.missingVariants - job.processedVariants)) / 1000);
  warmJobSlot.noteProgress(job);
};

const runWarmJob = async (job: MarkdownRenderCacheWarmJobSnapshot, input: { config: GitHubRuntimeConfig; store: DocsStore }): Promise<void> => {
  job.startedAt = new Date().toISOString();
  try {
    const plan = await planMarkdownRenderCacheWarm(input);
    if (job.status !== "running") {
      return;
    }

    job.totalPages = plan.totalPages;
    job.totalVariants = plan.totalVariants;
    job.missingVariants = plan.missing.length;
    job.phase = "rendering";
    const renderStartedAtMs = Date.now();
    warmJobSlot.noteProgress(job);

    let next = 0;
    const work = async (): Promise<void> => {
      while (next < plan.missing.length && job.status === "running") {
        const variant = plan.missing[next];
        next += 1;
        let outcome: "cached" | "rendered" | Error;
        try {
          outcome = await plan.warm(variant);
        } catch (error: unknown) {
          // A changed docs source makes every further variant fail the same way.
          if (error instanceof ApiError && error.status === 409) {
            throw error;
          }
          outcome = error instanceof Error ? error : new Error(String(error));
        }
        // A job the watchdog failed meanwhile keeps its final numbers.
        if (job.status !== "running") {
          return;
        }

        if (outcome instanceof Error) {
          job.failedVariants += 1;
          if (job.failures.length < MAX_REPORTED_FAILURES) {
            job.failures.push({ error: outcome.message, languageCode: variant.language.code, slug: variant.page.slug });
          }
        } else {
          job[outcome === "rendered" ? "renderedVariants" : "skippedVariants"] += 1;
        }
        recordProgress(job, renderStartedAtMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WARM_JOB_CONTENT_CONCURRENCY, plan.missing.length) }, work));

    await flushRenderedMarkdownCacheIndex();
    finishWarmJob(job, job.failedVariants > 0 ? "completed_with_failures" : "completed");
  } catch (error: unknown) {
    finishWarmJob(job, "failed", error instanceof Error ? error.message : String(error));
  }
};

/**
 * Starts rendering the missing HTML of the current docs and returns the job at once; a running
 * job is returned instead of starting another. Fails right away (400/409) when the docs source is
 * not configured or no longer authorized.
 */
export const startMarkdownRenderCacheWarmJob = (input: { config: GitHubRuntimeConfig; store: DocsStore }): MarkdownRenderCacheWarmJobSnapshot => {
  assertValidGitHubRuntimeConfig(input.config);
  assertGitHubRuntimeConfigActive(input.config);

  const { job } = warmJobSlot.start(
    (state) => ({
      ...state,
      phase: "planning",
      totalPages: 0,
      totalVariants: 0,
      missingVariants: 0,
      processedVariants: 0,
      renderedVariants: 0,
      skippedVariants: 0,
      failedVariants: 0,
      failures: [],
      etaSeconds: null,
    }),
    (started) => runWarmJob(started, input),
  );
  return toSnapshot(job);
};

/** The latest warm job, from process memory only: cheap enough for the admin card to poll. */
export const getMarkdownRenderCacheWarmJob = (): MarkdownRenderCacheWarmJobSnapshot | null => {
  const job = warmJobSlot.latest();
  return job ? toSnapshot(job) : null;
};
