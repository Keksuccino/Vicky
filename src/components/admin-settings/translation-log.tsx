"use client";

import { useEffect, useRef } from "react";

import { formatStatusTimestamp } from "@/components/admin-settings/format";
import type { TranslationRequestStatus } from "@/components/admin-settings/localization-status";
import { MaterialIcon } from "@/components/material-icon";
import type { AdminTranslationJobLogEntry, AdminTranslationJobSnapshot } from "@/components/types";

const getTranslationJobStatusLabel = (job: AdminTranslationJobSnapshot | null): string => {
  if (!job) {
    return "Idle";
  }

  if (job.status === "running") {
    if (job.phase === "queued") {
      return "Queued";
    }

    if (job.phase === "checking") {
      return "Checking";
    }

    return job.phase === "uploading" ? "Uploading" : "Translating";
  }

  if (job.status === "completed") {
    return "Complete";
  }

  if (job.status === "completed_with_failures") {
    return "Complete with failures";
  }

  return "Failed";
};

const getTranslationJobStatusTone = (
  job: AdminTranslationJobSnapshot | null,
): "loading" | "complete" | "partial" | "empty" => {
  if (!job || job.status === "running") {
    return "loading";
  }

  if (job.status === "completed") {
    return "complete";
  }

  return job.status === "completed_with_failures" ? "partial" : "empty";
};

const getTranslationLogIcon = (level: AdminTranslationJobLogEntry["level"]): string => {
  if (level === "success") {
    return "check_circle";
  }

  if (level === "warning") {
    return "warning";
  }

  if (level === "error") {
    return "error";
  }

  return "info";
};

type TranslationLogProps = {
  job: AdminTranslationJobSnapshot | null;
  /** What the card says about its last request, above the job's own log entries. */
  requestStatus: TranslationRequestStatus | null;
};

/** The latest job's status, result counts, and log, scrolled to its newest entry. */
export function TranslationLog({ job, requestStatus }: TranslationLogProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const logEntries = job?.logs ?? [];

  useEffect(() => {
    const logElement = logRef.current;
    if (!logElement) {
      return;
    }

    logElement.scrollTop = logElement.scrollHeight;
  }, [logEntries.length, job?.id]);

  return (
    <div className="translation-log-panel">
      <div className="translation-log-header">
        <span className="field-label">Translation log</span>
        <span className={`translation-language-cache-status translation-language-cache-status-${getTranslationJobStatusTone(job)}`}>
          {getTranslationJobStatusLabel(job)}
        </span>
      </div>

      {job?.mode === "source-versions" ? (
        <div className="translation-log-summary">
          <span>
            {job.result.uploadedPages}/{job.result.requestedPages} recorded
          </span>
          <span>{job.result.failedPages} failed</span>
        </div>
      ) : job ? (
        <div className="translation-log-summary">
          <span>
            {job.result.translatedPages}/{job.result.requestedPages} translated
          </span>
          <span>{job.result.uploadedPages} uploaded</span>
          <span>{job.result.cachedPages} current</span>
          <span>{job.result.failedPages} failed</span>
        </div>
      ) : null}

      <div className="translation-log-scroll" ref={logRef} aria-live="polite">
        {requestStatus ? (
          <div className={`translation-log-entry translation-log-entry-${requestStatus.tone}`}>
            <MaterialIcon name={requestStatus.tone === "error" ? "error" : "warning"} />
            <div className="translation-log-entry-body">
              <span className="translation-log-entry-message">{requestStatus.message}</span>
            </div>
          </div>
        ) : null}
        {logEntries.length > 0 ? (
          logEntries.map((entry) => (
            <div className={`translation-log-entry translation-log-entry-${entry.level}`} key={entry.id}>
              <MaterialIcon name={getTranslationLogIcon(entry.level)} />
              <div className="translation-log-entry-body">
                <span className="translation-log-entry-time">{formatStatusTimestamp(entry.createdAt)}</span>
                <span className="translation-log-entry-message">{entry.message}</span>
                {entry.details ? <span className="translation-log-entry-details">{entry.details}</span> : null}
              </div>
            </div>
          ))
        ) : !requestStatus ? (
          <p className="muted-text translation-log-empty">No translation activity yet.</p>
        ) : null}
      </div>
    </div>
  );
}
