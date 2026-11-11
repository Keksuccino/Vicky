import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatCount } from "@/components/admin-settings/format";
import { useNewestRequest } from "@/components/admin-settings/request-lifetime";
import {
  clearAdminMarkdownCache,
  fetchAdminMarkdownCacheStatus,
  fetchAdminMarkdownCacheWarmJob,
  formatApiError,
  startAdminMarkdownCacheWarmJob,
} from "@/components/api";
import { startJobStatusPolling } from "@/components/job-status-polling";
import type { AdminMarkdownCachePageStatus, AdminMarkdownCacheStatus, AdminMarkdownCacheWarmJob } from "@/components/types";

const MARKDOWN_CACHE_WARM_JOB_POLL_MS = 1_000;

export type MarkdownCacheActionMessage = { tone: "success" | "warning" | "error"; text: string };

/** What the card says once a warm job it watched has finished. */
const markdownCacheWarmOutcome = (job: AdminMarkdownCacheWarmJob): MarkdownCacheActionMessage => {
  const rendered = `${formatCount(job.renderedVariants)} Markdown HTML variant${job.renderedVariants === 1 ? "" : "s"}`;
  if (job.status === "failed") {
    return { tone: "error", text: job.error ?? "Rendering the missing HTML stopped." };
  }
  if (job.failedVariants > 0) {
    return { tone: "warning", text: `Cached ${rendered}; ${formatCount(job.failedVariants)} failed.` };
  }
  if (job.renderedVariants === 0) {
    return { tone: "success", text: "All available Markdown HTML variants were already cached." };
  }
  return { tone: "success", text: `Cached ${rendered}.` };
};

export type MarkdownCacheStatus = {
  actionMessage: MarkdownCacheActionMessage | null;
  error: string | null;
  loading: boolean;
  status: AdminMarkdownCacheStatus | null;
  /** The latest warm job; while it runs, the card shows its progress. */
  warmJob: AdminMarkdownCacheWarmJob | null;
  refreshMarkdownCacheStatus: () => Promise<void>;
  setActionMessage: (message: MarkdownCacheActionMessage | null) => void;
  setError: (error: string | null) => void;
  setStatus: (status: AdminMarkdownCacheStatus) => void;
  trackWarmJob: (job: AdminMarkdownCacheWarmJob | null) => void;
};

/**
 * The Markdown HTML cache status, loaded only once the admin asks for it, and the latest warm
 * job, loaded with the panel because it keeps running while the admin is away.
 */
export function useMarkdownCacheStatus(lifetimeSignal: () => AbortSignal, panelReady: boolean) {
  const [status, setStatus] = useState<AdminMarkdownCacheStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<MarkdownCacheActionMessage | null>(null);
  const [warmJob, setWarmJob] = useState<AdminMarkdownCacheWarmJob | null>(null);
  /** Set once the admin asks for the status; it is never loaded before that. */
  const requestedRef = useRef(false);
  const warmJobRef = useRef<AdminMarkdownCacheWarmJob | null>(null);
  const lastWarmJobStatusRef = useRef<AdminMarkdownCacheWarmJob["status"] | null>(null);
  const runRequest = useNewestRequest(lifetimeSignal);

  const refreshMarkdownCacheStatus = useCallback(async () => {
    requestedRef.current = true;
    setLoading(true);
    setError(null);

    const result = await runRequest((signal) => fetchAdminMarkdownCacheStatus({ signal }));
    if (!result) {
      return;
    }

    // A failed refresh keeps the last status on screen next to the error.
    setStatus((current) => result.value ?? current);
    setError(result.error);
    setLoading(false);
  }, [runRequest]);

  /** Keeps a status the admin has opened up to date after changes that affect it. */
  const refreshRequestedMarkdownCacheStatus = useCallback(() => {
    if (requestedRef.current) {
      void refreshMarkdownCacheStatus();
    }
  }, [refreshMarkdownCacheStatus]);

  const trackWarmJob = useCallback((job: AdminMarkdownCacheWarmJob | null): void => {
    warmJobRef.current = job;
    setWarmJob(job);
  }, []);

  /** Reads the latest warm job; the server answers from memory, so the card can poll it while it runs. */
  const refreshMarkdownCacheWarmJob = useCallback(async () => {
    const signal = lifetimeSignal();
    try {
      const job = await fetchAdminMarkdownCacheWarmJob({ signal });
      if (!signal.aborted) {
        trackWarmJob(job);
      }
    } catch {
      // The next poll tries again; a job that is gone for good is no longer shown once polling stops.
    }
  }, [lifetimeSignal, trackWarmJob]);

  useEffect(() => {
    const job = warmJob;
    const previousStatus = lastWarmJobStatusRef.current;
    lastWarmJobStatusRef.current = job?.status ?? null;

    if (previousStatus === "running" && job && job.status !== "running") {
      // Runs once per warm job that finished while the card watched it, after its last poll is
      // shown; the outcome message stays until the admin's next cache action replaces it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActionMessage(markdownCacheWarmOutcome(job));
      refreshRequestedMarkdownCacheStatus();
    }
  }, [refreshRequestedMarkdownCacheStatus, warmJob]);

  useEffect(() => {
    if (!panelReady || warmJob?.status !== "running") {
      return;
    }

    return startJobStatusPolling({ documentTarget: document, intervalMs: MARKDOWN_CACHE_WARM_JOB_POLL_MS, isJobRunning: () => warmJobRef.current?.status === "running", onPoll: refreshMarkdownCacheWarmJob, windowTarget: window });
  }, [panelReady, refreshMarkdownCacheWarmJob, warmJob?.id, warmJob?.status]);

  const markdownCacheStatus = useMemo<MarkdownCacheStatus>(
    () => ({ actionMessage, error, loading, refreshMarkdownCacheStatus, setActionMessage, setError, setStatus, status, trackWarmJob, warmJob }),
    [actionMessage, error, loading, refreshMarkdownCacheStatus, status, trackWarmJob, warmJob],
  );

  return { markdownCacheStatus, refreshMarkdownCacheWarmJob, refreshRequestedMarkdownCacheStatus };
}

/**
 * The card's own actions: rendering the missing HTML and clearing the cache. Each saves pending
 * settings first, since the server renders with the saved ones.
 */
export function useMarkdownCacheActions(cache: MarkdownCacheStatus, lifetimeSignal: () => AbortSignal, persistLatestSettings: () => Promise<void>) {
  const { setActionMessage, setError, setStatus, trackWarmJob } = cache;
  /** The request that starts a warm job is on its way. */
  const [warmStarting, setWarmStarting] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [clearingSlug, setClearingSlug] = useState<string | null>(null);

  const cacheMissingMarkdownHtml = useCallback(async () => {
    const signal = lifetimeSignal();
    setWarmStarting(true);
    setActionMessage(null);
    setError(null);

    try {
      await persistLatestSettings();
      const job = await startAdminMarkdownCacheWarmJob();
      if (!signal.aborted) {
        trackWarmJob(job);
      }
    } catch (requestError) {
      if (!signal.aborted) {
        setActionMessage({
          tone: "error",
          text: formatApiError(requestError),
        });
      }
    } finally {
      if (!signal.aborted) {
        setWarmStarting(false);
      }
    }
  }, [lifetimeSignal, persistLatestSettings, setActionMessage, setError, trackWarmJob]);

  /** Clears the rendered HTML of `page`, or of all pages without one, after the admin confirmed it. */
  const clearMarkdownCache = useCallback(
    async (page: AdminMarkdownCachePageStatus | null) => {
      if (!window.confirm(page ? `Clear rendered Markdown HTML for "${page.title}"?` : "Clear rendered Markdown HTML for all pages?")) {
        return;
      }

      const signal = lifetimeSignal();
      if (page) {
        setClearingSlug(page.slug);
      } else {
        setClearingAll(true);
      }
      setActionMessage(null);
      setError(null);

      try {
        await persistLatestSettings();
        const { result, status } = page ? await clearAdminMarkdownCache(page.slug) : await clearAdminMarkdownCache();
        if (signal.aborted) {
          return;
        }
        setStatus(status);
        setActionMessage({
          tone: "success",
          text: `Cleared ${formatCount(result.clearedEntries)} Markdown HTML cache entr${result.clearedEntries === 1 ? "y" : "ies"}${
            page ? ` for ${page.title}` : ""
          }.`,
        });
      } catch (requestError) {
        if (!signal.aborted) {
          setActionMessage({
            tone: "error",
            text: formatApiError(requestError),
          });
        }
      } finally {
        if (!signal.aborted) {
          if (page) {
            setClearingSlug(null);
          } else {
            setClearingAll(false);
          }
        }
      }
    },
    [lifetimeSignal, persistLatestSettings, setActionMessage, setError, setStatus],
  );

  return { cacheMissingMarkdownHtml, clearMarkdownCache, clearingAll, clearingSlug, warmStarting };
}
