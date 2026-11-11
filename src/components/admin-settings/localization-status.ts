import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { progressPercent } from "@/components/admin-settings/format";
import { useNewestRequest } from "@/components/admin-settings/request-lifetime";
import type { SettingsStore } from "@/components/admin-settings/settings-store";
import { fetchAdminLanguageTranslationOverview, fetchAdminLanguageTranslationStatus } from "@/components/api";
import { startJobStatusPolling } from "@/components/job-status-polling";
import type { AdminLanguageTranslationCacheStatus, AdminSettings, AdminTranslationJobSnapshot } from "@/components/types";
import { normalizeAutoTranslateLanguageCode, normalizeLocalizationPath } from "@/lib/auto-translate";

const TRANSLATION_CACHE_STATUS_POLL_MS = 4_000;
/** How often the card asks again while a language's translations are fetched for the first time. */
const TRANSLATION_OVERVIEW_POLL_MS = 1_500;

export type TranslationRequestStatus = {
  tone: "success" | "warning" | "error";
  message: string;
};

export const translationCacheStatusKey = (languageCode: string): string =>
  normalizeAutoTranslateLanguageCode(languageCode).toLowerCase();

const createTranslationCacheStatusMap = (
  statuses: AdminLanguageTranslationCacheStatus[],
): Record<string, AdminLanguageTranslationCacheStatus> => {
  const output: Record<string, AdminLanguageTranslationCacheStatus> = {};

  for (const status of statuses) {
    const key = translationCacheStatusKey(status.languageCode);
    if (key) {
      output[key] = status;
    }
  }

  return output;
};

/** A language whose translations the server is still fetching for the first time, so its counts are not final. */
export const isTranslationStatusPending = (status: AdminLanguageTranslationCacheStatus | undefined): boolean =>
  Boolean(status && !status.sourceLanguage && (status.loading || status.pendingPages > 0));

/** Progress of that first fetch: its blob downloads, or null while only commit dates are being looked up. */
export const getTranslationStatusProgressPercent = (status: AdminLanguageTranslationCacheStatus): number | null =>
  status.loading && status.loading.total > 0 ? progressPercent(status.loading.downloaded, status.loading.total) : null;

/** What the localization overview depends on: the localization directory and the language codes. */
const translationOverviewSignature = (settings: AdminSettings): string =>
  JSON.stringify([normalizeLocalizationPath(settings.autoTranslateLocalizationPath), settings.autoTranslateLanguages.map((language) => translationCacheStatusKey(language.code))]);

export type LocalizationStatus = {
  /** The latest translation or source-version job of the server. */
  job: AdminTranslationJobSnapshot | null;
  requestStatus: TranslationRequestStatus | null;
  statusError: string | null;
  statusLoading: boolean;
  /** Statuses by `translationCacheStatusKey`. */
  statuses: Record<string, AdminLanguageTranslationCacheStatus>;
  /** Localization directory the statuses belong to; they are hidden while the panel shows another one. */
  statusesLocalizationPath: string | null;
  /** Follows a job the admin just started, so its finish is noticed. */
  followStartedJob: (job: AdminTranslationJobSnapshot) => void;
  setRequestStatus: (status: TranslationRequestStatus | null) => void;
};

type LocalizationStatusOptions = {
  lifetimeSignal: () => AbortSignal;
  /** Called first when a job the card watched finishes; the overview is loaded again after it. */
  onJobFinished: () => void;
  panelReady: boolean;
  settingsStore: SettingsStore;
};

/**
 * Each language's localization status and the latest translation job. The overview reads the
 * saved languages and localization directory, without a job; a running job reports the
 * statuses of its languages live, and the overview is loaded again once it finished.
 */
export function useLocalizationStatus({ lifetimeSignal, onJobFinished, panelReady, settingsStore }: LocalizationStatusOptions) {
  const [requestStatus, setRequestStatus] = useState<TranslationRequestStatus | null>(null);
  const [job, setJob] = useState<AdminTranslationJobSnapshot | null>(null);
  const [statuses, setStatuses] = useState<Record<string, AdminLanguageTranslationCacheStatus>>({});
  const [statusesLocalizationPath, setStatusesLocalizationPath] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const jobStatusInFlightRef = useRef(false);
  /** Translation settings of the latest overview request, to fetch it again after a save changes them. */
  const overviewSignatureRef = useRef<string | null>(null);
  const statusesPendingRef = useRef(false);
  const jobRef = useRef<AdminTranslationJobSnapshot | null>(null);
  const lastJobStatusRef = useRef<AdminTranslationJobSnapshot["status"] | null>(null);
  const runOverviewRequest = useNewestRequest(lifetimeSignal);

  /** Whether a language's translations are still being fetched for the first time; the overview is polled meanwhile. */
  const statusesPending = useMemo(() => Object.values(statuses).some(isTranslationStatusPending), [statuses]);

  useEffect(() => {
    statusesPendingRef.current = statusesPending;
  }, [statusesPending]);

  const trackJob = useCallback((nextJob: AdminTranslationJobSnapshot | null): void => {
    jobRef.current = nextJob;
    setJob(nextJob);
  }, []);

  /** Shows statuses computed for the localization directory the panel has saved; `merge` keeps the other languages. */
  const applyStatuses = useCallback((nextStatuses: AdminLanguageTranslationCacheStatus[], localizationPath: string, merge: boolean) => {
    const currentSettings = settingsStore.getState().draft;
    const path = normalizeLocalizationPath(localizationPath);
    if (path !== normalizeLocalizationPath(currentSettings.autoTranslateLocalizationPath)) {
      return;
    }

    const currentLanguageCodes = new Set(currentSettings.autoTranslateLanguages.map((language) => translationCacheStatusKey(language.code)));
    const applicable = createTranslationCacheStatusMap(nextStatuses.filter((status) => currentLanguageCodes.has(translationCacheStatusKey(status.languageCode))));
    setStatuses((current) => (merge ? { ...current, ...applicable } : applicable));
    setStatusesLocalizationPath(path);
  }, [settingsStore]);

  /**
   * Loads the status of every saved language without a job, from the server's repository index
   * and stored summaries. Only the newest request may update the card, and a running job keeps
   * the floor: it reports its languages live and the overview is loaded again once it finished.
   */
  const refreshTranslationOverview = useCallback(async () => {
    overviewSignatureRef.current = translationOverviewSignature(settingsStore.getState().draft);
    setStatusLoading(true);
    setStatusError(null);

    const result = await runOverviewRequest((signal) => fetchAdminLanguageTranslationOverview({ signal }));
    if (!result) {
      return;
    }

    if (result.value) {
      if (jobRef.current?.status !== "running") {
        applyStatuses(result.value.statuses, result.value.localizationPath, false);
      }
    } else {
      setStatusError(result.error);
    }
    setStatusLoading(false);
  }, [applyStatuses, runOverviewRequest, settingsStore]);

  /** Reads the latest translation job of the server; while it runs, its statuses follow its uploads. */
  const refreshTranslationJobStatus = useCallback(async () => {
    if (jobStatusInFlightRef.current) {
      return;
    }

    const signal = lifetimeSignal();
    jobStatusInFlightRef.current = true;
    try {
      const runtimeStatus = await fetchAdminLanguageTranslationStatus(jobRef.current?.id, { signal });
      if (signal.aborted) {
        return;
      }

      if (runtimeStatus.job?.status === "running") {
        applyStatuses(runtimeStatus.statuses, runtimeStatus.job.localizationPath, true);
      }
      if (runtimeStatus.jobState === "unknown") {
        trackJob(null);
        setRequestStatus({ tone: "warning", message: "Translation job status is no longer available. The server may have restarted or replaced its in-process job snapshot." });
      } else {
        trackJob(runtimeStatus.job);
      }
    } catch {
      // The next poll asks again; without a running job nothing waits for this answer.
    } finally {
      jobStatusInFlightRef.current = false;
    }
  }, [applyStatuses, lifetimeSignal, trackJob]);

  /** Loads the overview again after a save changed what it reads: the saved languages or directory. */
  const refreshOverviewAfterSave = useCallback((saved: AdminSettings) => {
    if (overviewSignatureRef.current !== null && translationOverviewSignature(saved) !== overviewSignatureRef.current) {
      void refreshTranslationOverview();
    }
  }, [refreshTranslationOverview]);

  const followStartedJob = useCallback((startedJob: AdminTranslationJobSnapshot) => {
    trackJob(startedJob);
    lastJobStatusRef.current = startedJob.status;
    void refreshTranslationJobStatus();
  }, [refreshTranslationJobStatus, trackJob]);

  useEffect(() => {
    const nextStatus = job?.status ?? null;
    const previousStatus = lastJobStatusRef.current;
    lastJobStatusRef.current = nextStatus;

    if (previousStatus === "running" && nextStatus && nextStatus !== "running") {
      onJobFinished();
      void refreshTranslationOverview();
    }
  }, [job?.status, onJobFinished, refreshTranslationOverview]);

  useEffect(() => {
    if (!panelReady || job?.status !== "running") {
      return;
    }

    return startJobStatusPolling({ documentTarget: document, intervalMs: TRANSLATION_CACHE_STATUS_POLL_MS, isJobRunning: () => jobRef.current?.status === "running", onPoll: refreshTranslationJobStatus, windowTarget: window });
  }, [job?.id, job?.status, panelReady, refreshTranslationJobStatus]);

  useEffect(() => {
    if (!panelReady || !statusesPending) {
      return;
    }

    return startJobStatusPolling({ documentTarget: document, intervalMs: TRANSLATION_OVERVIEW_POLL_MS, isJobRunning: () => statusesPendingRef.current, onPoll: refreshTranslationOverview, windowTarget: window });
  }, [panelReady, refreshTranslationOverview, statusesPending]);

  const localizationStatus = useMemo<LocalizationStatus>(
    () => ({ followStartedJob, job, requestStatus, setRequestStatus, statusError, statusLoading, statuses, statusesLocalizationPath }),
    [followStartedJob, job, requestStatus, statusError, statusLoading, statuses, statusesLocalizationPath],
  );

  return { localizationStatus, refreshOverviewAfterSave, refreshTranslationJobStatus, refreshTranslationOverview };
}
