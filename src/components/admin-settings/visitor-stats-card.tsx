"use client";

import { useState, type CSSProperties } from "react";

import { formatCount, formatEtaSeconds, formatStatusTimestamp, progressPercent } from "@/components/admin-settings/format";
import { useVisitorStatsContext } from "@/components/admin-settings/panel-context";
import { CardRefreshButton, ProgressPanel } from "@/components/admin-settings/panel-ui";
import { VisitorSparklineCard } from "@/components/admin-settings/visitor-sparkline";
import { MaterialIcon } from "@/components/material-icon";
import type { VisitorAnalyticsStatus, VisitorStatsScope } from "@/components/types";

const VISITOR_STATS_TABS: Array<{ icon: string; label: string; scope: VisitorStatsScope }> = [
  { icon: "all_inclusive", label: "All-time", scope: "allTime" },
  { icon: "today", label: "Day", scope: "daily" },
  { icon: "view_week", label: "Week", scope: "weekly" },
  { icon: "calendar_month", label: "Month", scope: "monthly" },
  { icon: "event_available", label: "Year", scope: "yearly" },
];
const VISITOR_STATS_TREND_LABELS: Record<VisitorStatsScope, string> = {
  allTime: "All-time trend",
  daily: "Trend of the last 24 hours",
  weekly: "Trend of the last 7 days",
  monthly: "Trend of the last 30 days",
  yearly: "Trend of the last 365 days",
};

const formatVisitorLabel = (value: number): string => `${formatCount(value)} visitor${value === 1 ? "" : "s"}`;

type VisitorCatchUpProgressProps = {
  progress: NonNullable<VisitorAnalyticsStatus["catchingUp"]>;
};

function VisitorCatchUpProgress({ progress }: VisitorCatchUpProgressProps) {
  return (
    <ProgressPanel
      ariaLabel="Earlier visits added"
      detail={`${formatCount(progress.processed)} of ${formatCount(progress.total)} visits, ${formatEtaSeconds(progress.etaSeconds)}. The numbers below fill in as it goes.`}
      percent={progressPercent(progress.processed, progress.total)}
      title="Catching up on earlier visits"
    />
  );
}

export function VisitorStatsCard() {
  const { error, loading, refreshVisitorStats, stats, status } = useVisitorStatsContext();
  const [activeScope, setActiveScope] = useState<VisitorStatsScope>("allTime");
  const scopeStats = stats?.scopes[activeScope] ?? null;
  const maxPageVisits = Math.max(1, ...(scopeStats?.pages.map((page) => page.visits) ?? [0]));
  const trendPeriods = scopeStats?.periods ?? [];
  const displayedError = error ?? status?.error ?? null;
  const waitingForNumbers = loading || Boolean(status?.refreshing);

  return (
    <section className="panel-card panel-card-visitors">
      <div className="panel-header">
        <div>
          <h2>Analytics</h2>
          <p className="panel-description">Visits and unique visitors over time.</p>
        </div>
        <CardRefreshButton
          disabled={loading}
          label="Refresh analytics"
          loading={loading}
          loadingLabel="Refreshing analytics"
          onClick={() => {
            void refreshVisitorStats({ refresh: true });
          }}
        />
      </div>

      <div className="visitor-tabs" role="tablist" aria-label="Analytics range">
        {VISITOR_STATS_TABS.map((tab) => (
          <button
            key={tab.scope}
            type="button"
            className={`btn visitor-tab${activeScope === tab.scope ? " visitor-tab-active" : ""}`}
            role="tab"
            aria-selected={activeScope === tab.scope}
            onClick={() => setActiveScope(tab.scope)}
          >
            <MaterialIcon name={tab.icon} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {displayedError ? <p className="error-text">{displayedError}</p> : null}
      {status?.catchingUp ? <VisitorCatchUpProgress progress={status.catchingUp} /> : null}

      <div className="visitor-stats-scroll">
        {!stats || !scopeStats ? (
          displayedError && !waitingForNumbers ? null : (
            <p className="muted-caption">{waitingForNumbers ? "Loading analytics..." : "No analytics recorded yet."}</p>
          )
        ) : (
          <>
            <div className="visitor-chart-wrap">
              <div className="visitor-section-heading">
                <h3>{VISITOR_STATS_TREND_LABELS[activeScope]}</h3>
                <span title={formatStatusTimestamp(stats.computedAt)}>
                  {loading ? "Refreshing..." : `Updated ${formatStatusTimestamp(stats.computedAt)}`}
                </span>
              </div>
              <div className="visitor-sparkline-grid">
                <VisitorSparklineCard
                  label="Unique visitors"
                  metric="visitors"
                  periods={trendPeriods}
                  value={scopeStats.totalVisitors}
                />
                <VisitorSparklineCard label="Visits" metric="visits" periods={trendPeriods} value={scopeStats.totalVisits} />
              </div>
            </div>

            <div className="visitor-page-section">
              <div className="visitor-section-heading">
                <h3>Pages</h3>
                <span>{formatCount(scopeStats.pages.length)}</span>
              </div>

              {scopeStats.pages.length > 0 ? (
                <div className="visitor-page-list">
                  {scopeStats.pages.map((page) => {
                    const size = page.visits > 0 ? Math.max(5, (page.visits / maxPageVisits) * 100) : 0;
                    const style = { "--visitor-bar-size": `${size}%` } as CSSProperties;

                    return (
                      <a className="visitor-page-row" href={`/docs/${page.slug}`} key={page.slug}>
                        <span className="visitor-page-main">
                          <strong>{page.title}</strong>
                          <span>{page.path} - {formatVisitorLabel(page.visitors)}</span>
                        </span>
                        <span className="visitor-page-count" title={formatVisitorLabel(page.visitors)}>
                          {formatCount(page.visits)}
                        </span>
                        <span className="visitor-page-meter" aria-hidden="true">
                          <span className="visitor-page-meter-fill" style={style} />
                        </span>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <p className="muted-caption">No visitors recorded for this range yet.</p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
