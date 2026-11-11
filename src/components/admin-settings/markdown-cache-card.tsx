"use client";

import { formatByteSize, formatCount, formatEtaSeconds, formatStatusTimestamp, progressPercent } from "@/components/admin-settings/format";
import { useMarkdownCacheActions } from "@/components/admin-settings/markdown-cache";
import { useAdminPanel, useMarkdownCacheContext } from "@/components/admin-settings/panel-context";
import { CardRefreshButton, ProgressPanel } from "@/components/admin-settings/panel-ui";
import { MaterialIcon } from "@/components/material-icon";
import type { AdminMarkdownCachePageStatus, AdminMarkdownCacheStatus, AdminMarkdownCacheWarmJob } from "@/components/types";

export function MarkdownCacheCard() {
  const { lifetimeSignal, persistLatestSettings } = useAdminPanel();
  const cache = useMarkdownCacheContext();
  const { actionMessage, error, loading, refreshMarkdownCacheStatus, status, warmJob } = cache;
  const { cacheMissingMarkdownHtml, clearMarkdownCache, clearingAll, clearingSlug, warmStarting } = useMarkdownCacheActions(
    cache,
    lifetimeSignal,
    persistLatestSettings,
  );
  const onRefresh = () => {
    void refreshMarkdownCacheStatus();
  };
  const warmJobRunning = warmJob?.status === "running";
  const warming = warmStarting || warmJobRunning;
  const clearing = clearingAll || Boolean(clearingSlug);
  const busy = loading || warming || clearing;

  return (
    <section className="panel-card panel-card-markdown-cache">
      <div className="panel-header">
        <div>
          <h2>Markdown HTML Cache</h2>
          <p className="panel-description">Persistent server-rendered HTML for current docs content.</p>
        </div>
        {status ? (
          <CardRefreshButton
            disabled={loading || clearing}
            label="Refresh Markdown cache"
            loading={loading}
            loadingLabel="Refreshing Markdown cache"
            onClick={onRefresh}
          />
        ) : null}
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {actionMessage ? <p className={`${actionMessage.tone}-text`}>{actionMessage.text}</p> : null}
      {warmJob && warmJobRunning ? <MarkdownCacheWarmProgress job={warmJob} /> : null}

      {status ? (
        <MarkdownCacheStatusDetails
          busy={busy}
          clearingAll={clearingAll}
          clearingSlug={clearingSlug}
          status={status}
          warming={warming}
          onClearAll={() => {
            void clearMarkdownCache(null);
          }}
          onClearPage={(page) => {
            void clearMarkdownCache(page);
          }}
          onWarmAll={() => {
            void cacheMissingMarkdownHtml();
          }}
        />
      ) : (
        <div className="markdown-cache-idle">
          <div className="markdown-cache-idle-text">
            <strong>Cache status loads on request</strong>
            <span>Check which pages and translations already have rendered HTML. It only loads when you ask, so the admin panel opens faster.</span>
          </div>
          <button type="button" className="btn btn-primary" disabled={loading || clearing} onClick={onRefresh}>
            <MaterialIcon name={loading ? "hourglass_top" : "query_stats"} />
            <span>{loading ? "Loading..." : "Show cache status"}</span>
          </button>
        </div>
      )}
    </section>
  );
}

type MarkdownCacheStatusDetailsProps = {
  busy: boolean;
  clearingAll: boolean;
  clearingSlug: string | null;
  status: AdminMarkdownCacheStatus;
  warming: boolean;
  onClearAll: () => void;
  onClearPage: (page: AdminMarkdownCachePageStatus) => void;
  onWarmAll: () => void;
};

function MarkdownCacheStatusDetails({
  busy,
  clearingAll,
  clearingSlug,
  status,
  warming,
  onClearAll,
  onClearPage,
  onWarmAll,
}: MarkdownCacheStatusDetailsProps) {
  const cacheRatio = `${formatCount(status.cachedVariants)}/${formatCount(status.totalVariants)}`;
  const pageRatio = `${formatCount(status.sourcePagesCached)}/${formatCount(status.totalPages)}`;
  const lastMutationLabel = status.lastMutation
    ? `${formatCount(status.lastMutation.deletedEntries)} removed ${formatStatusTimestamp(status.lastMutation.at)}`
    : "No clear recorded";

  return (
    <>
      <div className="markdown-cache-summary-grid">
        <div className="markdown-cache-summary-item">
          <strong>{cacheRatio}</strong>
          <span>HTML variants</span>
        </div>
        <div className="markdown-cache-summary-item">
          <strong>{pageRatio}</strong>
          <span>Source pages</span>
        </div>
        <div className="markdown-cache-summary-item">
          <strong>{formatCount(status.translatedVariants)}</strong>
          <span>Translations</span>
        </div>
        <div className="markdown-cache-summary-item">
          <strong>{formatByteSize(status.totalHtmlBytes)}</strong>
          <span>Storage</span>
        </div>
      </div>

      <div className="markdown-cache-meta-row">
        <span>Renderer v{status.rendererVersion}</span>
        <span>{formatCount(status.staleEntries)} unused entr{status.staleEntries === 1 ? "y" : "ies"}</span>
        <span>{formatCount(status.globalEntries)} files globally</span>
        <span>{formatByteSize(status.globalHtmlBytes)} globally</span>
        <span>PID {status.processId}</span>
        <span>Updated {formatStatusTimestamp(status.updatedAt)}</span>
      </div>
      <div className="markdown-cache-meta-row markdown-cache-cache-path-row">
        <span className="markdown-cache-cache-path">{status.cacheDirectory}</span>
        <span>{lastMutationLabel}</span>
      </div>

      <div className="action-row">
        <button type="button" className="btn btn-primary" disabled={status.uncachedVariants === 0 || busy} onClick={onWarmAll}>
          <MaterialIcon name={warming ? "hourglass_top" : "cached"} />
          <span>{warming ? "Caching..." : "Cache missing HTML"}</span>
        </button>

        <button type="button" className="btn danger" disabled={busy} onClick={onClearAll}>
          <MaterialIcon name={clearingAll ? "hourglass_top" : "delete_sweep"} />
          <span>{clearingAll ? "Clearing..." : "Clear all"}</span>
        </button>
      </div>

      <div className="markdown-cache-page-list">
        {status.pages.length === 0 ? (
          <p className="muted-caption">No docs pages found.</p>
        ) : (
          status.pages.map((page) => {
            const isClearing = clearingSlug === page.slug;
            const pageRatio = `${formatCount(page.cachedVariants)}/${formatCount(page.totalVariants)}`;

            return (
              <div className="markdown-cache-page-row" key={page.slug || page.path}>
                <div className="markdown-cache-page-main">
                  <div className="markdown-cache-page-heading">
                    <strong>{page.title}</strong>
                    <span>{pageRatio}</span>
                  </div>
                  <span className="markdown-cache-page-path">{page.path || page.slug}</span>
                  <div className="markdown-cache-language-list">
                    {page.languages.map((language) => (
                      <span
                        className={`markdown-cache-language-chip${
                          language.cached ? " markdown-cache-language-cached" : " markdown-cache-language-missing"
                        }`}
                        key={`${page.slug}-${language.languageCode}-${language.contentHash}`}
                        title={
                          language.cached && language.savedAt
                            ? `${language.languageName} cached ${formatStatusTimestamp(language.savedAt)}`
                            : `${language.languageName} is not cached`
                        }
                      >
                        {language.sourceLanguage ? "Source" : language.languageCode}
                      </span>
                    ))}
                  </div>
                </div>

                <span className="markdown-cache-page-action-tooltip ui-tooltip" data-ui-tooltip="Clear page cache">
                  <button
                    type="button"
                    className="btn btn-icon danger markdown-cache-page-clear"
                    aria-label={`Clear rendered Markdown cache for ${page.title}`}
                    disabled={busy}
                    onClick={() => onClearPage(page)}
                  >
                    <MaterialIcon name={isClearing ? "hourglass_top" : "delete"} />
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function MarkdownCacheWarmProgress({ job }: { job: AdminMarkdownCacheWarmJob }) {
  const detail =
    job.phase === "planning"
      ? "Checking which pages and translations still need HTML."
      : `${formatCount(job.processedVariants)} of ${formatCount(job.missingVariants)} variants, ${formatEtaSeconds(job.etaSeconds)}. It keeps going if you leave this page.`;

  return <ProgressPanel ariaLabel="Missing HTML rendered" detail={detail} percent={progressPercent(job.processedVariants, job.missingVariants)} title="Rendering missing HTML" />;
}
