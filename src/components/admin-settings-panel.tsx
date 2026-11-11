"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import {
  clearAdminMarkdownCache,
  clearAdminGitHubToken,
  clearAdminOpenRouterApiKey,
  createAdminModerator,
  deleteAdminModerator,
  fetchAdminDomainSslStatus,
  fetchAdminLanguageTranslationOverview,
  fetchAdminLanguageTranslationStatus,
  fetchAdminMarkdownCacheStatus,
  fetchAdminMarkdownCacheWarmJob,
  fetchAdminModerators,
  fetchAdminPerformanceStats,
  fetchAdminSettings,
  fetchAdminVisitorStats,
  formatApiError,
  getCurrentUser,
  MAX_DOCS_REFRESH_INTERVAL_MINUTES,
  MIN_DOCS_REFRESH_INTERVAL_MINUTES,
  refreshAdminDocsCache,
  requestAdminLanguageTranslations,
  requestAdminSourceVersionRecording,
  saveAdminSettings,
  startAdminMarkdownCacheWarmJob,
  testAdminConnection,
  updateAdminModerator,
} from "@/components/api";
import { CardRefreshButton, ProgressPanel } from "@/components/admin-settings/panel-ui";
import {
  clampNumber,
  formatByteSize,
  formatChartCoordinate,
  formatCount,
  formatEtaSeconds,
  formatStatusTimestamp,
  formatUsagePercent,
  progressPercent,
} from "@/components/admin-settings/format";
import { useNewestRequest, usePanelLifetimeSignal } from "@/components/admin-settings/request-lifetime";
import { EnabledToggle, ResetToDefaultButton } from "@/components/admin-settings/settings-fields";
import {
  EMPTY_SETTINGS_FIELD_ERRORS,
  hasSettingsFieldErrors,
  normalizeAutoTranslateLanguagesForSave,
  normalizeAutoTranslateRequestTimeoutSeconds,
  normalizeSettingsForSave,
  validateAutoTranslateLanguages,
  validateAutoTranslateRequestTimeoutSeconds,
  validateCustomDomainInput,
  validateLetsEncryptEmailInput,
  validateLocalizationPathInput,
  validateOpenRouterApiKeyInput,
  validateOpenRouterModelInput,
  validateSettingsFields,
  validateSystemPromptInput,
  type AiChatFieldErrors,
  type AutoTranslateFieldErrors,
  type DomainFieldErrors,
  type OpenRouterFieldErrors,
  type SettingsFieldErrors,
} from "@/components/admin-settings/settings-validation";
import { CircleFlagIconPicker } from "@/components/circle-flag-icon-picker";
import { ColorPickerField } from "@/components/color-picker-field";
import { startJobStatusPolling } from "@/components/job-status-polling";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import {
  AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
  AI_CHAT_DOCS_PLACEHOLDER,
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
} from "@/lib/ai-chat";
import {
  DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGES,
  DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCALIZATION_PATH,
  MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";
import type {
  AdminLanguageTranslationCacheStatus,
  AdminMarkdownCachePageStatus,
  AdminMarkdownCacheStatus,
  AdminMarkdownCacheWarmJob,
  AdminSettings,
  AdminTranslationJobLogEntry,
  AdminTranslationJobSnapshot,
  AutoTranslateLanguage,
  DomainSslRuntimeStatus,
  ModeratorAccount,
  PerformanceStatsSnapshot,
  ThemeCustomization,
  VisitorAnalyticsStatus,
  VisitorStatsPeriod,
  VisitorStatsScope,
  VisitorStatsSummary,
} from "@/components/types";
import { normalizeCircleFlagIconId } from "@/lib/circle-flags";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";
import { buildThemeVariables, DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";

const THEME_DEFAULTS = DEFAULT_THEME_CUSTOMIZATION();
const DEFAULT_SITE_TITLE_GRADIENT_FROM = "#3b82f6";
const DEFAULT_SITE_TITLE_GRADIENT_TO = "#22d3ee";
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
/** How often the card asks again while earlier visits are still being added to the numbers. */
const VISITOR_STATS_CATCH_UP_POLL_MS = 2_000;
/** How soon the card asks again when the server was still computing the numbers. */
const VISITOR_STATS_PENDING_POLL_MS = 1_000;
const TRANSLATION_CACHE_STATUS_INITIAL_DELAY_MS = 650;
const TRANSLATION_CACHE_STATUS_POLL_MS = 4_000;
/** How often the card asks again while a language's translations are fetched for the first time. */
const TRANSLATION_OVERVIEW_POLL_MS = 1_500;
const MARKDOWN_CACHE_WARM_JOB_POLL_MS = 1_000;
const PERFORMANCE_REFRESH_INTERVAL_MS = 60_000;

const INITIAL_SETTINGS: AdminSettings = {
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  footerText: DEFAULT_FOOTER_TEXT,
  startPage: "/home",
  siteTitleGradientFrom: "",
  siteTitleGradientTo: "",
  docsIconPng16Url: "",
  docsIconPng32Url: "",
  docsIconPng180Url: "",
  docsRefreshIntervalMinutes: 60,
  customDomain: "",
  letsEncryptEmail: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  githubDocsPath: "docs",
  githubToken: "",
  tokenConfigured: false,
  aiChatEnabled: false,
  aiChatAssistantName: DEFAULT_AI_CHAT_ASSISTANT_NAME,
  aiChatAvatarUrl: "",
  aiChatHeaderSubtitle: DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  aiChatWelcomeMessage: DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  aiChatSystemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  openRouterModel: DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  openRouterApiKey: "",
  openRouterApiKeyConfigured: false,
  autoTranslateEnabled: false,
  autoTranslateOpenRouterModel: DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  autoTranslateRequestTimeoutSeconds: DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000,
  autoTranslateLanguages: DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language })),
  autoTranslateLocalizationPath: DEFAULT_LOCALIZATION_PATH,
  themeLightAccent: THEME_DEFAULTS.lightAccent,
  themeLightSurfaceAccent: THEME_DEFAULTS.lightSurfaceAccent,
  themeDarkAccent: THEME_DEFAULTS.darkAccent,
  themeDarkSurfaceAccent: THEME_DEFAULTS.darkSurfaceAccent,
  themeCustomCss: THEME_DEFAULTS.customCss,
};

const createCustomAutoTranslateLanguage = (languages: AutoTranslateLanguage[]): AutoTranslateLanguage => {
  let index = 1;
  let code = "custom";

  while (languages.some((language) => languageCodesEqual(language.code, code))) {
    index += 1;
    code = `custom-${index}`;
  }

  return {
    name: "Custom Language",
    code,
    icon: DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON,
    enabled: true,
  };
};

const themeCustomizationFromSettings = (settings: AdminSettings): ThemeCustomization => ({
  lightAccent: settings.themeLightAccent,
  lightSurfaceAccent: settings.themeLightSurfaceAccent,
  darkAccent: settings.themeDarkAccent,
  darkSurfaceAccent: settings.themeDarkSurfaceAccent,
  customCss: settings.themeCustomCss,
});

const createThemePreviewStyle = (
  mode: "light" | "dark",
  customization: ThemeCustomization,
): CSSProperties => {
  const variables = buildThemeVariables(mode, customization);

  return {
    "--theme-preview-surface": variables["--surface"],
    "--theme-preview-surface-muted": variables["--surface-muted"],
    "--theme-preview-text": variables["--text-primary"],
    "--theme-preview-text-secondary": variables["--text-secondary"],
    "--theme-preview-border": variables["--border"],
    "--theme-preview-page-gradient": variables["--page-gradient"],
    "--theme-preview-accent-primary": variables["--accent"],
    "--theme-preview-accent-primary-soft": variables["--accent-soft"],
    "--theme-preview-accent-primary-contrast": variables["--accent-contrast"],
    "--theme-preview-accent-surface": variables["--accent-surface"],
    "--theme-preview-accent-surface-soft": variables["--accent-surface-soft"],
    "--theme-preview-accent-surface-contrast": variables["--accent-surface-contrast"],
  } as CSSProperties;
};

const formatVisitorLabel = (value: number): string => `${formatCount(value)} visitor${value === 1 ? "" : "s"}`;

type VisitorSparklineMetric = "visitors" | "visits";

type VisitorSparklinePoint = {
  key: string;
  label: string;
  period: VisitorStatsPeriod;
  value: number;
  x: number;
  y: number;
};

type VisitorSparklineTooltipPosition = {
  left: number;
  top: number;
};

const VISITOR_SPARKLINE_WIDTH = 240;
const VISITOR_SPARKLINE_HEIGHT = 84;
const VISITOR_SPARKLINE_PADDING_X = 5;
const VISITOR_SPARKLINE_PADDING_Y = 7;
const VISITOR_SPARKLINE_TOOLTIP_GAP = 14;
const VISITOR_SPARKLINE_TOOLTIP_MARGIN_X = 14;
const VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y = 10;

type PerformanceMetricKind = "memory" | "cpu" | "drive";
type PerformanceUsageTone = "low" | "medium" | "high";

type PerformanceMetricCardProps = {
  detail: string;
  kind: PerformanceMetricKind;
  label: string;
  usagePercent: number;
};

const PERFORMANCE_CHART_WIDTH = 240;
const PERFORMANCE_CHART_HEIGHT = 84;
const PERFORMANCE_CHART_PADDING_X = 5;
const PERFORMANCE_CHART_PADDING_Y = 8;

const getPerformanceUsageTone = (usagePercent: number): PerformanceUsageTone => {
  if (usagePercent < 30) {
    return "low";
  }

  if (usagePercent < 65) {
    return "medium";
  }

  return "high";
};

const createPerformanceMeterGeometry = (usagePercent: number) => {
  const normalizedPercent = clampNumber(usagePercent, 0, 100);
  const baselineY = PERFORMANCE_CHART_HEIGHT - PERFORMANCE_CHART_PADDING_Y;
  const chartHeight = PERFORMANCE_CHART_HEIGHT - PERFORMANCE_CHART_PADDING_Y * 2;
  const startX = PERFORMANCE_CHART_PADDING_X;
  const endX = PERFORMANCE_CHART_WIDTH - PERFORMANCE_CHART_PADDING_X;
  const y = baselineY - (normalizedPercent / 100) * chartHeight;
  const linePath = `M ${formatChartCoordinate(startX)} ${formatChartCoordinate(
    y,
  )} L ${formatChartCoordinate(endX)} ${formatChartCoordinate(y)}`;
  const areaPath = [
    "M",
    formatChartCoordinate(startX),
    formatChartCoordinate(baselineY),
    "L",
    formatChartCoordinate(startX),
    formatChartCoordinate(y),
    "L",
    formatChartCoordinate(endX),
    formatChartCoordinate(y),
    "L",
    formatChartCoordinate(endX),
    formatChartCoordinate(baselineY),
    "Z",
  ].join(" ");

  return {
    areaPath,
    baselineY,
    endX,
    linePath,
    y,
  };
};

function PerformanceMetricCard({ detail, kind, label, usagePercent }: PerformanceMetricCardProps) {
  const percent = clampNumber(usagePercent, 0, 100);
  const percentLabel = formatUsagePercent(percent);
  const usageTone = getPerformanceUsageTone(percent);
  const geometry = createPerformanceMeterGeometry(percent);
  const tickLines = [25, 50, 75].map((tick) => {
    const chartHeight = PERFORMANCE_CHART_HEIGHT - PERFORMANCE_CHART_PADDING_Y * 2;
    const y = geometry.baselineY - (tick / 100) * chartHeight;

    return {
      key: tick,
      y,
    };
  });

  return (
    <div
      className={`visitor-sparkline-card performance-meter-card performance-meter-card-${kind} performance-meter-card-${usageTone}`}
    >
      <div className="visitor-sparkline-meta">
        <strong>{percentLabel}</strong>
        <span>{label}</span>
      </div>
      <span className="visitor-sparkline-range">{detail}</span>
      <div className="performance-meter-stage">
        <svg
          className="performance-meter"
          role="img"
          aria-label={`${label}: ${percentLabel} used. ${detail}.`}
          preserveAspectRatio="none"
          viewBox={`0 0 ${PERFORMANCE_CHART_WIDTH} ${PERFORMANCE_CHART_HEIGHT}`}
        >
          {tickLines.map((tick) => (
            <line
              key={tick.key}
              className="performance-meter-grid-line"
              x1={PERFORMANCE_CHART_PADDING_X}
              x2={PERFORMANCE_CHART_WIDTH - PERFORMANCE_CHART_PADDING_X}
              y1={tick.y}
              y2={tick.y}
            />
          ))}
          <path className="visitor-sparkline-area performance-meter-area" d={geometry.areaPath} />
          <path className="visitor-sparkline-glow performance-meter-glow" d={geometry.linePath} />
          <path className="visitor-sparkline-line performance-meter-line" d={geometry.linePath} />
        </svg>
      </div>
    </div>
  );
}

type PerformanceStatsCardProps = {
  error: string | null;
  loading: boolean;
  stats: PerformanceStatsSnapshot | null;
  onRefresh: () => void;
};

function PerformanceStatsCard({ error, loading, stats, onRefresh }: PerformanceStatsCardProps) {
  const memoryDetail = stats
    ? `${formatByteSize(stats.memory.usedBytes)} of ${formatByteSize(stats.memory.totalBytes)}`
    : "";
  const cpuDetail = stats
    ? `Across ${formatCount(stats.cpu.logicalCores)} logical core${stats.cpu.logicalCores === 1 ? "" : "s"}`
    : "";
  const driveDetail = stats
    ? `${formatByteSize(stats.drive.usedBytes)} of ${formatByteSize(stats.drive.totalBytes)}`
    : "";

  return (
    <section className="panel-card panel-card-performance">
      <div className="panel-header">
        <div>
          <h2>Performance Overview</h2>
          <p className="panel-description">Live server resource usage.</p>
        </div>
        <CardRefreshButton disabled={loading} label="Refresh performance" loading={loading} loadingLabel="Refreshing performance" onClick={onRefresh} />
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="performance-stats-scroll">
        {!stats ? (
          <p className="muted-caption">{loading ? "Loading performance..." : "No performance data available."}</p>
        ) : (
          <>
            <div className="visitor-section-heading performance-section-heading">
              <span>{loading ? "Refreshing..." : `Updated ${formatStatusTimestamp(stats.updatedAt)}`}</span>
            </div>
            <div className="visitor-sparkline-grid performance-meter-grid">
              <PerformanceMetricCard
                detail={memoryDetail}
                kind="memory"
                label="Memory Usage"
                usagePercent={stats.memory.usagePercent}
              />
              <PerformanceMetricCard
                detail={cpuDetail}
                kind="cpu"
                label="CPU Usage"
                usagePercent={stats.cpu.usagePercent}
              />
              <PerformanceMetricCard
                detail={driveDetail}
                kind="drive"
                label="Drive Usage"
                usagePercent={stats.drive.usagePercent}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

type MarkdownCacheActionMessage = { tone: "success" | "warning" | "error"; text: string };

type MarkdownCacheCardProps = {
  actionMessage: MarkdownCacheActionMessage | null;
  clearingAll: boolean;
  clearingSlug: string | null;
  error: string | null;
  loading: boolean;
  status: AdminMarkdownCacheStatus | null;
  /** The latest warm job; while it runs, the card shows its progress. */
  warmJob: AdminMarkdownCacheWarmJob | null;
  /** The request that starts a warm job is on its way. */
  warmStarting: boolean;
  onClearAll: () => void;
  onClearPage: (page: AdminMarkdownCachePageStatus) => void;
  onRefresh: () => void;
  onWarmAll: () => void;
};

function MarkdownCacheCard({
  actionMessage,
  clearingAll,
  clearingSlug,
  error,
  loading,
  status,
  warmJob,
  warmStarting,
  onClearAll,
  onClearPage,
  onRefresh,
  onWarmAll,
}: MarkdownCacheCardProps) {
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
          <CardRefreshButton disabled={loading || clearing} label="Refresh Markdown cache" loading={loading} loadingLabel="Refreshing Markdown cache" onClick={onRefresh} />
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
          onClearAll={onClearAll}
          onClearPage={onClearPage}
          onWarmAll={onWarmAll}
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

type MarkdownCacheStatusDetailsProps = Pick<
  MarkdownCacheCardProps,
  "clearingAll" | "clearingSlug" | "onClearAll" | "onClearPage" | "onWarmAll"
> & {
  busy: boolean;
  status: AdminMarkdownCacheStatus;
  warming: boolean;
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

const getVisitorSparklineValue = (period: VisitorStatsPeriod, metric: VisitorSparklineMetric): number =>
  metric === "visitors" ? period.visitors : period.visits;

const formatVisitorTrendRange = (periods: VisitorStatsPeriod[]): string => {
  const first = periods[0];
  const last = periods.at(-1);

  if (!first || !last) {
    return "No activity";
  }

  return first.key === last.key ? first.label : `${first.label} - ${last.label}`;
};

const createVisitorSparklinePoints = (
  periods: VisitorStatsPeriod[],
  metric: VisitorSparklineMetric,
): VisitorSparklinePoint[] => {
  if (periods.length === 0) {
    return [];
  }

  const chartWidth = VISITOR_SPARKLINE_WIDTH - VISITOR_SPARKLINE_PADDING_X * 2;
  const chartHeight = VISITOR_SPARKLINE_HEIGHT - VISITOR_SPARKLINE_PADDING_Y * 2;
  const sourcePeriods = periods.length === 1 ? [periods[0], periods[0]] : periods;
  const sourceValues = periods.map((period) => getVisitorSparklineValue(period, metric));
  const minValue = Math.min(...sourceValues);
  const maxValue = Math.max(...sourceValues);
  const range = maxValue - minValue;

  return sourcePeriods.map((period, index) => {
    const value = getVisitorSparklineValue(period, metric);
    const normalized = range > 0 ? (value - minValue) / range : maxValue > 0 ? 0.56 : 0;
    const x =
      VISITOR_SPARKLINE_PADDING_X +
      (sourcePeriods.length === 1 ? chartWidth : (index / (sourcePeriods.length - 1)) * chartWidth);
    const y = VISITOR_SPARKLINE_HEIGHT - VISITOR_SPARKLINE_PADDING_Y - normalized * chartHeight;

    return {
      key: `${period.key}-${index}`,
      label: period.label,
      period,
      value,
      x,
      y,
    };
  });
};

const createVisitorSparklinePath = (points: VisitorSparklinePoint[]): string => {
  const firstPoint = points[0];
  if (!firstPoint) {
    return "";
  }

  const move = `M ${formatChartCoordinate(firstPoint.x)} ${formatChartCoordinate(firstPoint.y)}`;
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index];
    const controlX = previous.x + (point.x - previous.x) / 2;

    return [
      "C",
      formatChartCoordinate(controlX),
      formatChartCoordinate(previous.y),
      formatChartCoordinate(controlX),
      formatChartCoordinate(point.y),
      formatChartCoordinate(point.x),
      formatChartCoordinate(point.y),
    ].join(" ");
  });

  return [move, ...segments].join(" ");
};

type VisitorSparklineCardProps = {
  label: string;
  metric: VisitorSparklineMetric;
  periods: VisitorStatsPeriod[];
  value: number;
};

function VisitorSparklineCard({ label, metric, periods, value }: VisitorSparklineCardProps) {
  const chartId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `visitor-sparkline-fill-${chartId}`;
  const tooltipId = `visitor-sparkline-tooltip-${chartId}`;
  const chartCardRef = useRef<HTMLDivElement>(null);
  const chartStageRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<VisitorSparklineTooltipPosition | null>(null);
  const points = createVisitorSparklinePoints(periods, metric);
  const activePoint = activePointIndex === null ? null : points[activePointIndex] ?? null;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const linePath = createVisitorSparklinePath(points);
  const baselineY = VISITOR_SPARKLINE_HEIGHT - VISITOR_SPARKLINE_PADDING_Y;
  const areaPath =
    firstPoint && lastPoint && linePath
      ? `${linePath} L ${formatChartCoordinate(lastPoint.x)} ${formatChartCoordinate(
          baselineY,
        )} L ${formatChartCoordinate(firstPoint.x)} ${formatChartCoordinate(baselineY)} Z`
      : "";
  const rangeLabel = formatVisitorTrendRange(periods);
  const activePointStyle = activePoint
    ? ({
        "--visitor-active-x": `${(activePoint.x / VISITOR_SPARKLINE_WIDTH) * 100}%`,
        "--visitor-active-y": `${(activePoint.y / VISITOR_SPARKLINE_HEIGHT) * 100}%`,
      } as CSSProperties)
    : undefined;
  const tooltipStyle = activePoint
    ? ({
        left: tooltipPosition ? `${tooltipPosition.left}px` : 0,
        top: tooltipPosition ? `${tooltipPosition.top}px` : 0,
        visibility: tooltipPosition ? "visible" : "hidden",
      } as CSSProperties)
    : undefined;
  const activePointKey = activePoint?.key;
  const activePointX = activePoint?.x;
  const activePointY = activePoint?.y;

  useLayoutEffect(() => {
    if (!activePointKey || activePointX === undefined || activePointY === undefined) {
      return undefined;
    }

    const updateTooltipPosition = () => {
      const chartStage = chartStageRef.current;
      const chartCard = chartCardRef.current;
      const tooltip = tooltipRef.current;

      if (!chartStage || !chartCard || !tooltip) {
        return;
      }

      const stageBounds = chartStage.getBoundingClientRect();
      const cardBounds = chartCard.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();

      if (
        stageBounds.width <= 0 ||
        stageBounds.height <= 0 ||
        cardBounds.width <= 0 ||
        cardBounds.height <= 0 ||
        tooltipBounds.width <= 0 ||
        tooltipBounds.height <= 0
      ) {
        return;
      }

      const pointX = stageBounds.left - cardBounds.left + (activePointX / VISITOR_SPARKLINE_WIDTH) * stageBounds.width;
      const pointY = stageBounds.top - cardBounds.top + (activePointY / VISITOR_SPARKLINE_HEIGHT) * stageBounds.height;
      const maxLeft = Math.max(
        VISITOR_SPARKLINE_TOOLTIP_MARGIN_X,
        cardBounds.width - tooltipBounds.width - VISITOR_SPARKLINE_TOOLTIP_MARGIN_X,
      );
      const maxTop = Math.max(
        VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y,
        cardBounds.height - tooltipBounds.height - VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y,
      );
      const leftSide = pointX - tooltipBounds.width - VISITOR_SPARKLINE_TOOLTIP_GAP;
      const rightSide = pointX + VISITOR_SPARKLINE_TOOLTIP_GAP;
      const upperSide = pointY - tooltipBounds.height - VISITOR_SPARKLINE_TOOLTIP_GAP;
      const lowerSide = pointY + VISITOR_SPARKLINE_TOOLTIP_GAP;
      const horizontalPreference = pointX <= cardBounds.width / 2 ? "right" : "left";
      const verticalPreference = pointY <= cardBounds.height / 2 ? "lower" : "upper";
      const fallbackHorizontalPreference = horizontalPreference === "right" ? "left" : "right";
      const fallbackVerticalPreference = verticalPreference === "lower" ? "upper" : "lower";
      const candidates = [
        { horizontal: horizontalPreference, vertical: verticalPreference },
        { horizontal: fallbackHorizontalPreference, vertical: verticalPreference },
        { horizontal: horizontalPreference, vertical: fallbackVerticalPreference },
        { horizontal: fallbackHorizontalPreference, vertical: fallbackVerticalPreference },
      ].map((placement) => ({
        left: placement.horizontal === "right" ? rightSide : leftSide,
        top: placement.vertical === "lower" ? lowerSide : upperSide,
      }));
      const selectedPosition =
        candidates.find(
          (candidate) =>
            candidate.left >= VISITOR_SPARKLINE_TOOLTIP_MARGIN_X &&
            candidate.left <= maxLeft &&
            candidate.top >= VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y &&
            candidate.top <= maxTop,
        ) ?? candidates[0];
      const nextPosition = {
        left: Math.round(clampNumber(selectedPosition.left, VISITOR_SPARKLINE_TOOLTIP_MARGIN_X, maxLeft)),
        top: Math.round(clampNumber(selectedPosition.top, VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y, maxTop)),
      };

      setTooltipPosition((currentPosition) =>
        currentPosition?.left === nextPosition.left && currentPosition.top === nextPosition.top
          ? currentPosition
          : nextPosition,
      );
    };

    updateTooltipPosition();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateTooltipPosition);

    if (resizeObserver && chartCardRef.current && chartStageRef.current && tooltipRef.current) {
      resizeObserver.observe(chartCardRef.current);
      resizeObserver.observe(chartStageRef.current);
      resizeObserver.observe(tooltipRef.current);
    }

    window.addEventListener("resize", updateTooltipPosition);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateTooltipPosition);
    };
  }, [activePointKey, activePointX, activePointY]);

  const activateNearestPoint = (clientX: number) => {
    const chartStage = chartStageRef.current;

    if (!chartStage || points.length === 0) {
      return;
    }

    const bounds = chartStage.getBoundingClientRect();

    if (bounds.width <= 0) {
      return;
    }

    const chartX = ((clientX - bounds.left) / bounds.width) * VISITOR_SPARKLINE_WIDTH;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    points.forEach((point, index) => {
      const distance = Math.abs(point.x - chartX);

      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    });

    setActivePointIndex((currentIndex) => (currentIndex === nearestIndex ? currentIndex : nearestIndex));
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    activateNearestPoint(event.clientX);
  };

  const handlePointFocus = () => {
    if (points.length === 0) {
      return;
    }

    setActivePointIndex((currentIndex) => currentIndex ?? points.length - 1);
  };

  const handlePointKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) {
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;

      event.preventDefault();
      setActivePointIndex((currentIndex) => {
        if (currentIndex === null) {
          return direction > 0 ? 0 : points.length - 1;
        }

        return Math.max(0, Math.min(points.length - 1, currentIndex + direction));
      });
    }

    if (event.key === "Escape") {
      setActivePointIndex(null);
    }
  };

  return (
    <div ref={chartCardRef} className={`visitor-sparkline-card visitor-sparkline-card-${metric}`}>
      <div className="visitor-sparkline-meta">
        <strong>{formatCount(value)}</strong>
        <span>{label}</span>
      </div>
      <span className="visitor-sparkline-range">{rangeLabel}</span>
      <div
        ref={chartStageRef}
        className="visitor-sparkline-stage"
        tabIndex={points.length > 0 ? 0 : -1}
        aria-describedby={activePoint ? tooltipId : undefined}
        onBlur={() => setActivePointIndex(null)}
        onFocus={handlePointFocus}
        onKeyDown={handlePointKeyDown}
        onPointerLeave={() => setActivePointIndex(null)}
        onPointerMove={handlePointerMove}
      >
        <svg
          className="visitor-sparkline"
          role="img"
          aria-label={`${label}: ${formatCount(value)}. Trend range: ${rangeLabel}.`}
          preserveAspectRatio="none"
          viewBox={`0 0 ${VISITOR_SPARKLINE_WIDTH} ${VISITOR_SPARKLINE_HEIGHT}`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--visitor-chart-line)" stopOpacity="0.34" />
              <stop offset="100%" stopColor="var(--visitor-chart-line)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {areaPath ? <path className="visitor-sparkline-area" d={areaPath} fill={`url(#${gradientId})`} /> : null}
          {linePath ? (
            <>
              {activePoint ? (
                <line
                  className="visitor-sparkline-guide"
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={VISITOR_SPARKLINE_PADDING_Y}
                  y2={baselineY}
                />
              ) : null}
              <path className="visitor-sparkline-glow" d={linePath} />
              <path className="visitor-sparkline-line" d={linePath} />
            </>
          ) : null}
        </svg>
        {activePoint && activePointStyle ? (
          <span className="visitor-sparkline-active-dot" style={activePointStyle} aria-hidden="true" />
        ) : null}
      </div>
      {activePoint ? (
        <div
          ref={tooltipRef}
          id={tooltipId}
          className="visitor-sparkline-tooltip"
          role="tooltip"
          style={tooltipStyle}
        >
          <strong>{activePoint.label}</strong>
          <dl>
            <div>
              <dt>Visitors</dt>
              <dd>{formatCount(activePoint.period.visitors)}</dd>
            </div>
            <div>
              <dt>Visits</dt>
              <dd>{formatCount(activePoint.period.visits)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

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

function MarkdownCacheWarmProgress({ job }: { job: AdminMarkdownCacheWarmJob }) {
  const detail =
    job.phase === "planning"
      ? "Checking which pages and translations still need HTML."
      : `${formatCount(job.processedVariants)} of ${formatCount(job.missingVariants)} variants, ${formatEtaSeconds(job.etaSeconds)}. It keeps going if you leave this page.`;

  return <ProgressPanel ariaLabel="Missing HTML rendered" detail={detail} percent={progressPercent(job.processedVariants, job.missingVariants)} title="Rendering missing HTML" />;
}

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

type VisitorStatsCardProps = {
  activeScope: VisitorStatsScope;
  error: string | null;
  loading: boolean;
  stats: VisitorStatsSummary | null;
  status: VisitorAnalyticsStatus | null;
  onRefresh: () => void;
  onScopeChange: (scope: VisitorStatsScope) => void;
};

function VisitorStatsCard({
  activeScope,
  error,
  loading,
  stats,
  status,
  onRefresh,
  onScopeChange,
}: VisitorStatsCardProps) {
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
        <CardRefreshButton disabled={loading} label="Refresh analytics" loading={loading} loadingLabel="Refreshing analytics" onClick={onRefresh} />
      </div>

      <div className="visitor-tabs" role="tablist" aria-label="Analytics range">
        {VISITOR_STATS_TABS.map((tab) => (
          <button
            key={tab.scope}
            type="button"
            className={`btn visitor-tab${activeScope === tab.scope ? " visitor-tab-active" : ""}`}
            role="tab"
            aria-selected={activeScope === tab.scope}
            onClick={() => onScopeChange(tab.scope)}
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

const statusToneClassName = (status: DomainSslRuntimeStatus): "success-text" | "warning-text" | "error-text" => {
  if (status.configured && !status.httpsAvailable) {
    return "error-text";
  }

  switch (status.certificateState) {
    case "valid":
      return "success-text";
    case "expiring_soon":
    case "missing":
      return "warning-text";
    case "expired":
    case "domain_mismatch":
    case "invalid":
      return "error-text";
    default:
      return "warning-text";
  }
};

const formatCustomDomainHttpPolicy = (status: DomainSslRuntimeStatus): string => {
  switch (status.customDomainHttpPolicy) {
    case "redirect":
      return "redirect to HTTPS";
    case "maintenance":
      return "fail-closed maintenance response";
    default:
      return "serve application";
  }
};

type ClearSecretTarget = "githubToken" | "openRouterApiKey";
type TranslationRequestStatus = {
  tone: "success" | "warning" | "error";
  message: string;
};

type TranslationCacheStatusTone = "loading" | "empty" | "partial" | "complete";

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

const translationCacheStatusKey = (languageCode: string): string =>
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
const isTranslationStatusPending = (status: AdminLanguageTranslationCacheStatus | undefined): boolean =>
  Boolean(status && !status.sourceLanguage && (status.loading || status.pendingPages > 0));

/** Progress of that first fetch: its blob downloads, or null while only commit dates are being looked up. */
const getTranslationStatusProgressPercent = (status: AdminLanguageTranslationCacheStatus): number | null =>
  status.loading && status.loading.total > 0 ? progressPercent(status.loading.downloaded, status.loading.total) : null;

const getTranslationCacheStatusTone = (
  status: AdminLanguageTranslationCacheStatus | undefined,
): TranslationCacheStatusTone => {
  if (!status || isTranslationStatusPending(status)) {
    return "loading";
  }

  if (status.totalPages === 0 || status.currentPages >= status.totalPages) {
    return "complete";
  }

  return status.currentPages === 0 ? "empty" : "partial";
};

const getTranslationCacheStatusLabel = (status: AdminLanguageTranslationCacheStatus | undefined): string => {
  if (!status) {
    return "...";
  }

  if (isTranslationStatusPending(status)) {
    const percent = getTranslationStatusProgressPercent(status);
    return percent === null ? "..." : `${percent}%`;
  }

  return `${status.currentPages}/${status.totalPages}`;
};

const getTranslationCacheStatusTooltip = (status: AdminLanguageTranslationCacheStatus | undefined): string => {
  if (!status) {
    return "Checking localization status";
  }

  if (status.sourceLanguage) {
    return `Source language: all ${formatCount(status.totalPages)} page${status.totalPages === 1 ? "" : "s"} are written in it`;
  }

  if (isTranslationStatusPending(status)) {
    const loading = status.loading;
    if (loading && loading.total > 0 && loading.downloaded < loading.total) {
      return `Fetching this language's translations from GitHub for the first time: ${formatCount(loading.downloaded)} of ${formatCount(loading.total)} files`;
    }
    return "Checking on GitHub when this language's translations were last changed";
  }

  return `${status.currentPages}/${status.totalPages} current, ${status.missingPages} missing, ${status.outdatedPages} outdated`;
};

/** What the localization overview depends on: the localization directory and the language codes. */
const translationOverviewSignature = (settings: AdminSettings): string =>
  JSON.stringify([normalizeLocalizationPath(settings.autoTranslateLocalizationPath), settings.autoTranslateLanguages.map((language) => translationCacheStatusKey(language.code))]);

export function AdminSettingsPanel() {
  const router = useRouter();
  const { setThemeSettings } = useTheme();
  const lifetimeSignal = usePanelLifetimeSignal();
  const runPerformanceStatsRequest = useNewestRequest(lifetimeSignal);
  const runVisitorStatsRequest = useNewestRequest(lifetimeSignal);
  const runMarkdownCacheStatusRequest = useNewestRequest(lifetimeSignal);
  const runTranslationOverviewRequest = useNewestRequest(lifetimeSignal);

  const [settings, setSettings] = useState<AdminSettings>(INITIAL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [settingsSaving, setSettingsSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<ClearSecretTarget | null>(null);
  const [domainFieldErrors, setDomainFieldErrors] = useState<DomainFieldErrors>(EMPTY_SETTINGS_FIELD_ERRORS.domain);
  const [aiChatFieldErrors, setAiChatFieldErrors] = useState<AiChatFieldErrors>(EMPTY_SETTINGS_FIELD_ERRORS.aiChat);
  const [openRouterFieldErrors, setOpenRouterFieldErrors] = useState<OpenRouterFieldErrors>(EMPTY_SETTINGS_FIELD_ERRORS.openRouter);
  const [autoTranslateFieldErrors, setAutoTranslateFieldErrors] =
    useState<AutoTranslateFieldErrors>(EMPTY_SETTINGS_FIELD_ERRORS.autoTranslate);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [refreshingDocs, setRefreshingDocs] = useState(false);
  const [docsRefreshMessage, setDocsRefreshMessage] = useState<string | null>(null);
  const [docsRefreshError, setDocsRefreshError] = useState<string | null>(null);
  const [requestedTranslationLanguageCodes, setRequestedTranslationLanguageCodes] = useState<Set<string>>(
    () => new Set(),
  );
  const [translationBulkAction, setTranslationBulkAction] = useState<AdminTranslationJobSnapshot["mode"] | null>(null);
  const [translationRequestStatus, setTranslationRequestStatus] = useState<TranslationRequestStatus | null>(null);
  const [translationJob, setTranslationJob] = useState<AdminTranslationJobSnapshot | null>(null);
  const [translationCacheStatuses, setTranslationCacheStatuses] = useState<
    Record<string, AdminLanguageTranslationCacheStatus>
  >({});
  /** Localization directory the shown statuses belong to; they are hidden while the panel shows another one. */
  const [translationStatusesLocalizationPath, setTranslationStatusesLocalizationPath] = useState<string | null>(null);
  const [translationCacheStatusLoading, setTranslationCacheStatusLoading] = useState(false);
  const [translationCacheStatusError, setTranslationCacheStatusError] = useState<string | null>(null);

  const [markdownCacheStatus, setMarkdownCacheStatus] = useState<AdminMarkdownCacheStatus | null>(null);
  const [markdownCacheStatusLoading, setMarkdownCacheStatusLoading] = useState(false);
  const [markdownCacheStatusError, setMarkdownCacheStatusError] = useState<string | null>(null);
  const [markdownCacheActionMessage, setMarkdownCacheActionMessage] = useState<MarkdownCacheActionMessage | null>(null);
  const [markdownCacheWarmJob, setMarkdownCacheWarmJob] = useState<AdminMarkdownCacheWarmJob | null>(null);
  const [startingMarkdownCacheWarm, setStartingMarkdownCacheWarm] = useState(false);
  const [clearingMarkdownCacheAll, setClearingMarkdownCacheAll] = useState(false);
  const [clearingMarkdownCacheSlug, setClearingMarkdownCacheSlug] = useState<string | null>(null);

  const [sslStatus, setSslStatus] = useState<DomainSslRuntimeStatus | null>(null);
  const [sslStatusLoading, setSslStatusLoading] = useState(true);
  const [sslStatusError, setSslStatusError] = useState<string | null>(null);

  const [performanceStats, setPerformanceStats] = useState<PerformanceStatsSnapshot | null>(null);
  const [performanceStatsLoading, setPerformanceStatsLoading] = useState(true);
  const [performanceStatsError, setPerformanceStatsError] = useState<string | null>(null);

  const [visitorStats, setVisitorStats] = useState<VisitorStatsSummary | null>(null);
  const [visitorStatsStatus, setVisitorStatsStatus] = useState<VisitorAnalyticsStatus | null>(null);
  const [visitorStatsLoading, setVisitorStatsLoading] = useState(true);
  const [visitorStatsError, setVisitorStatsError] = useState<string | null>(null);
  const [visitorStatsScope, setVisitorStatsScope] = useState<VisitorStatsScope>("allTime");

  const [moderators, setModerators] = useState<ModeratorAccount[]>([]);
  const [moderatorUsername, setModeratorUsername] = useState("");
  const [moderatorPassword, setModeratorPassword] = useState("");
  const [showModeratorPassword, setShowModeratorPassword] = useState(false);
  const [moderatorError, setModeratorError] = useState<string | null>(null);
  const [moderatorSaving, setModeratorSaving] = useState(false);
  const [moderatorActionId, setModeratorActionId] = useState<string | null>(null);
  const [editingModeratorId, setEditingModeratorId] = useState<string | null>(null);
  const [editingModeratorUsername, setEditingModeratorUsername] = useState("");
  const [editingModeratorPassword, setEditingModeratorPassword] = useState("");
  const [showEditingModeratorPassword, setShowEditingModeratorPassword] = useState(false);

  const autoSaveReadyRef = useRef(false);
  const autoSaveInFlightRef = useRef(false);
  const autoSaveQueuedRef = useRef(false);
  const latestSettingsRef = useRef<AdminSettings>(INITIAL_SETTINGS);
  const lastSavedSnapshotRef = useRef<string | null>(null);
  const translationJobStatusInFlightRef = useRef(false);
  /** Translation settings of the latest overview request, to fetch it again after a save changes them. */
  const translationOverviewSignatureRef = useRef<string | null>(null);
  const translationStatusesPendingRef = useRef(false);
  const translationJobRef = useRef<AdminTranslationJobSnapshot | null>(null);
  const translationLogRef = useRef<HTMLDivElement | null>(null);
  const lastTranslationJobStatusRef = useRef<AdminTranslationJobSnapshot["status"] | null>(null);
  /** Set once the admin asks for the Markdown cache status; it is never loaded before that. */
  const markdownCacheStatusRequestedRef = useRef(false);
  const markdownCacheWarmJobRef = useRef<AdminMarkdownCacheWarmJob | null>(null);
  const lastMarkdownCacheWarmJobStatusRef = useRef<AdminMarkdownCacheWarmJob["status"] | null>(null);
  const lastSavedDomainRef = useRef({
    customDomain: INITIAL_SETTINGS.customDomain,
    letsEncryptEmail: INITIAL_SETTINGS.letsEncryptEmail,
  });

  const themeCustomization = useMemo(() => themeCustomizationFromSettings(settings), [settings]);
  const lightPreviewStyle = useMemo(
    () => createThemePreviewStyle("light", themeCustomization),
    [themeCustomization],
  );
  const darkPreviewStyle = useMemo(
    () => createThemePreviewStyle("dark", themeCustomization),
    [themeCustomization],
  );
  const activeTranslationMode = translationJob?.status === "running" ? translationJob.mode : translationBulkAction;
  const translationLogEntries = translationJob?.logs ?? [];
  /** Whether a language's translations are still being fetched for the first time; the overview is polled meanwhile. */
  const translationStatusesPending = useMemo(() => Object.values(translationCacheStatuses).some(isTranslationStatusPending), [translationCacheStatuses]);
  /** Current translations that do not record their source version yet, as the overview or a running job reports them. */
  const unrecordedTranslationCount = useMemo(
    () =>
      settings.autoTranslateLanguages.reduce(
        (total, language) =>
          isDefaultAutoTranslateLanguageCode(language.code) ? total : total + (translationCacheStatuses[translationCacheStatusKey(language.code)]?.unrecordedPages ?? 0),
        0,
      ),
    [settings.autoTranslateLanguages, translationCacheStatuses],
  );

  useEffect(() => {
    translationStatusesPendingRef.current = translationStatusesPending;
  }, [translationStatusesPending]);

  const trackTranslationJob = useCallback((job: AdminTranslationJobSnapshot | null): void => {
    translationJobRef.current = job;
    setTranslationJob(job);
  }, []);

  const refreshSslStatus = useCallback(async () => {
    const signal = lifetimeSignal();
    setSslStatusLoading(true);
    setSslStatusError(null);

    try {
      const status = await fetchAdminDomainSslStatus({ signal });
      if (!signal.aborted) {
        setSslStatus(status);
      }
    } catch (error) {
      if (!signal.aborted) {
        setSslStatus(null);
        setSslStatusError(formatApiError(error));
      }
    } finally {
      if (!signal.aborted) {
        setSslStatusLoading(false);
      }
    }
  }, [lifetimeSignal]);

  const refreshPerformanceStats = useCallback(async () => {
    setPerformanceStatsLoading(true);
    setPerformanceStatsError(null);

    const result = await runPerformanceStatsRequest((signal) => fetchAdminPerformanceStats({ signal }));
    if (!result) {
      return;
    }

    setPerformanceStats(result.value);
    setPerformanceStatsError(result.error);
    setPerformanceStatsLoading(false);
  }, [runPerformanceStatsRequest]);

  /**
   * Loads the analytics numbers. Only the newest request may update the card, so a slow older
   * response never replaces newer numbers. Background polls (`silent`) leave the refresh button
   * alone, and numbers already shown stay until newer ones arrive.
   */
  const refreshVisitorStats = useCallback(async ({ refresh = false, silent = false }: { refresh?: boolean; silent?: boolean } = {}) => {
    if (!silent) {
      setVisitorStatsLoading(true);
      setVisitorStatsError(null);
    }

    const result = await runVisitorStatsRequest((signal) => fetchAdminVisitorStats({ refresh, signal }));
    if (!result) {
      return;
    }

    if (result.value) {
      if (result.value.stats) {
        setVisitorStats(result.value.stats);
      }
      setVisitorStatsStatus(result.value.status);
    }
    setVisitorStatsError(result.error);
    setVisitorStatsLoading(false);
  }, [runVisitorStatsRequest]);

  const resetModeratorEditor = useCallback(() => {
    setEditingModeratorId(null);
    setEditingModeratorUsername("");
    setEditingModeratorPassword("");
    setShowEditingModeratorPassword(false);
  }, []);

  const handleCreateModerator = useCallback(async () => {
    const signal = lifetimeSignal();
    setModeratorSaving(true);
    setModeratorError(null);

    try {
      const created = await createAdminModerator({
        username: moderatorUsername,
        password: moderatorPassword,
      });
      if (signal.aborted) {
        return;
      }
      setModerators((prev) => [...prev, created].sort((left, right) => left.username.localeCompare(right.username)));
      setModeratorUsername("");
      setModeratorPassword("");
      setShowModeratorPassword(false);
    } catch (error) {
      if (!signal.aborted) {
        setModeratorError(formatApiError(error));
      }
    } finally {
      if (!signal.aborted) {
        setModeratorSaving(false);
      }
    }
  }, [lifetimeSignal, moderatorPassword, moderatorUsername]);

  const handleUpdateModerator = useCallback(
    async (account: ModeratorAccount) => {
      const username = editingModeratorUsername.trim();
      if (!username) {
        setModeratorError("Moderator username is required.");
        return;
      }

      const payload: { username?: string; password?: string } = {};
      if (username !== account.username) {
        payload.username = username;
      }

      if (editingModeratorPassword) {
        payload.password = editingModeratorPassword;
      }

      if (!payload.username && !payload.password) {
        resetModeratorEditor();
        return;
      }

      const signal = lifetimeSignal();
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        const updated = await updateAdminModerator(account.id, payload);
        if (signal.aborted) {
          return;
        }
        setModerators((prev) =>
          prev
            .map((moderator) => (moderator.id === account.id ? updated : moderator))
            .sort((left, right) => left.username.localeCompare(right.username)),
        );
        resetModeratorEditor();
      } catch (error) {
        if (!signal.aborted) {
          setModeratorError(formatApiError(error));
        }
      } finally {
        if (!signal.aborted) {
          setModeratorActionId(null);
        }
      }
    },
    [editingModeratorPassword, editingModeratorUsername, lifetimeSignal, resetModeratorEditor],
  );

  const handleDeleteModerator = useCallback(
    async (account: ModeratorAccount) => {
      const signal = lifetimeSignal();
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        await deleteAdminModerator(account.id);
        if (signal.aborted) {
          return;
        }
        setModerators((prev) => prev.filter((moderator) => moderator.id !== account.id));
        if (editingModeratorId === account.id) {
          resetModeratorEditor();
        }
      } catch (error) {
        if (!signal.aborted) {
          setModeratorError(formatApiError(error));
        }
      } finally {
        if (!signal.aborted) {
          setModeratorActionId(null);
        }
      }
    },
    [editingModeratorId, lifetimeSignal, resetModeratorEditor],
  );

  const createSaveSnapshot = useCallback(
    (draft: AdminSettings): string =>
      JSON.stringify({
        settings: draft,
      }),
    [],
  );

  const getLatestSaveSnapshot = useCallback((): string => createSaveSnapshot(latestSettingsRef.current), [createSaveSnapshot]);

  const showFieldErrors = useCallback((errors: SettingsFieldErrors): void => {
    setDomainFieldErrors(errors.domain);
    setAiChatFieldErrors(errors.aiChat);
    setOpenRouterFieldErrors(errors.openRouter);
    setAutoTranslateFieldErrors(errors.autoTranslate);
  }, []);

  /** Shows statuses computed for the localization directory the panel has saved; `merge` keeps the other languages. */
  const applyTranslationStatuses = useCallback((statuses: AdminLanguageTranslationCacheStatus[], localizationPath: string, merge: boolean) => {
    const currentSettings = latestSettingsRef.current;
    const path = normalizeLocalizationPath(localizationPath);
    if (path !== normalizeLocalizationPath(currentSettings.autoTranslateLocalizationPath)) {
      return;
    }

    const currentLanguageCodes = new Set(currentSettings.autoTranslateLanguages.map((language) => translationCacheStatusKey(language.code)));
    const applicable = createTranslationCacheStatusMap(statuses.filter((status) => currentLanguageCodes.has(translationCacheStatusKey(status.languageCode))));
    setTranslationCacheStatuses((current) => (merge ? { ...current, ...applicable } : applicable));
    setTranslationStatusesLocalizationPath(path);
  }, []);

  /**
   * Loads the status of every saved language without a job, from the server's repository index
   * and stored summaries. Only the newest request may update the card, and a running job keeps
   * the floor: it reports its languages live and the overview is loaded again once it finished.
   */
  const refreshTranslationOverview = useCallback(async () => {
    translationOverviewSignatureRef.current = translationOverviewSignature(latestSettingsRef.current);
    setTranslationCacheStatusLoading(true);
    setTranslationCacheStatusError(null);

    const result = await runTranslationOverviewRequest((signal) => fetchAdminLanguageTranslationOverview({ signal }));
    if (!result) {
      return;
    }

    if (result.value) {
      if (translationJobRef.current?.status !== "running") {
        applyTranslationStatuses(result.value.statuses, result.value.localizationPath, false);
      }
    } else {
      setTranslationCacheStatusError(result.error);
    }
    setTranslationCacheStatusLoading(false);
  }, [applyTranslationStatuses, runTranslationOverviewRequest]);

  /** Reads the latest translation job of the server; while it runs, its statuses follow its uploads. */
  const refreshTranslationJobStatus = useCallback(async () => {
    if (translationJobStatusInFlightRef.current) {
      return;
    }

    const signal = lifetimeSignal();
    translationJobStatusInFlightRef.current = true;
    try {
      const runtimeStatus = await fetchAdminLanguageTranslationStatus(translationJobRef.current?.id, { signal });
      if (signal.aborted) {
        return;
      }

      if (runtimeStatus.job?.status === "running") {
        applyTranslationStatuses(runtimeStatus.statuses, runtimeStatus.job.localizationPath, true);
      }
      if (runtimeStatus.jobState === "unknown") {
        trackTranslationJob(null);
        setTranslationRequestStatus({ tone: "warning", message: "Translation job status is no longer available. The server may have restarted or replaced its in-process job snapshot." });
      } else {
        trackTranslationJob(runtimeStatus.job);
      }
    } catch {
      // The next poll asks again; without a running job nothing waits for this answer.
    } finally {
      translationJobStatusInFlightRef.current = false;
    }
  }, [applyTranslationStatuses, lifetimeSignal, trackTranslationJob]);

  const persistLatestSettings = useCallback(async () => {
    if (!autoSaveReadyRef.current) {
      return;
    }

    if (autoSaveInFlightRef.current) {
      autoSaveQueuedRef.current = true;
      return;
    }

    const draft = latestSettingsRef.current;
    const snapshot = createSaveSnapshot(draft);

    if (snapshot === lastSavedSnapshotRef.current) {
      return;
    }

    const fieldErrors = validateSettingsFields(draft);
    showFieldErrors(fieldErrors);

    if (hasSettingsFieldErrors(fieldErrors)) {
      setSaveError(null);
      return;
    }

    const signal = lifetimeSignal();
    autoSaveInFlightRef.current = true;
    setSettingsSaving(true);
    setSaveError(null);

    try {
      const shouldRefreshSslStatus =
        draft.customDomain !== lastSavedDomainRef.current.customDomain ||
        draft.letsEncryptEmail !== lastSavedDomainRef.current.letsEncryptEmail;
      const saved = await saveAdminSettings(normalizeSettingsForSave(draft));
      if (signal.aborted) {
        return;
      }
      const persistedSettings: AdminSettings = {
        ...saved,
        githubToken: "",
        openRouterApiKey: "",
      };
      const hasNewerLocalChanges = getLatestSaveSnapshot() !== snapshot;

      lastSavedSnapshotRef.current = createSaveSnapshot(persistedSettings);
      lastSavedDomainRef.current = {
        customDomain: persistedSettings.customDomain,
        letsEncryptEmail: persistedSettings.letsEncryptEmail,
      };

      if (hasNewerLocalChanges) {
        const latestSettings = latestSettingsRef.current;
        const nextSettings: AdminSettings = {
          ...latestSettings,
          openRouterApiKey:
            draft.openRouterApiKey.trim() && latestSettings.openRouterApiKey === draft.openRouterApiKey
              ? ""
              : latestSettings.openRouterApiKey,
          openRouterApiKeyConfigured: persistedSettings.openRouterApiKeyConfigured,
          githubToken:
            draft.githubToken.trim() && latestSettings.githubToken === draft.githubToken
              ? ""
              : latestSettings.githubToken,
          tokenConfigured: persistedSettings.tokenConfigured,
        };
        latestSettingsRef.current = nextSettings;
        setSettings(nextSettings);
      } else {
        latestSettingsRef.current = persistedSettings;
        setSettings(persistedSettings);
        setThemeSettings(themeCustomizationFromSettings(persistedSettings));
        showFieldErrors(validateSettingsFields(persistedSettings));
      }

      // The overview reads the saved languages and directory, so it is loaded again once they changed.
      if (translationOverviewSignatureRef.current !== null && translationOverviewSignature(persistedSettings) !== translationOverviewSignatureRef.current) {
        void refreshTranslationOverview();
      }
      if (shouldRefreshSslStatus) {
        await refreshSslStatus();
      }
    } catch (error) {
      if (!signal.aborted) {
        setSaveError(formatApiError(error));
      }
    } finally {
      autoSaveInFlightRef.current = false;
      if (!signal.aborted) {
        setSettingsSaving(false);
      }

      if (autoSaveQueuedRef.current) {
        autoSaveQueuedRef.current = false;
        void persistLatestSettings();
      }
    }
  }, [createSaveSnapshot, getLatestSaveSnapshot, lifetimeSignal, refreshSslStatus, refreshTranslationOverview, setThemeSettings, showFieldErrors]);

  const clearSavedSecret = useCallback(
    async (target: ClearSecretTarget) => {
      if (!autoSaveReadyRef.current || autoSaveInFlightRef.current) {
        return;
      }

      const currentSettings = latestSettingsRef.current;
      const hasSecret =
        target === "githubToken"
          ? Boolean(currentSettings.githubToken.trim() || currentSettings.tokenConfigured)
          : Boolean(currentSettings.openRouterApiKey.trim() || currentSettings.openRouterApiKeyConfigured);

      if (!hasSecret) {
        return;
      }

      const signal = lifetimeSignal();
      const snapshot = getLatestSaveSnapshot();
      autoSaveInFlightRef.current = true;
      setSettingsSaving(true);
      setClearingSecret(target);
      setSaveError(null);

      try {
        const saved =
          target === "githubToken" ? await clearAdminGitHubToken() : await clearAdminOpenRouterApiKey();
        if (signal.aborted) {
          return;
        }
        const hasNewerLocalChanges = getLatestSaveSnapshot() !== snapshot;
        const latestSettings = latestSettingsRef.current;
        const nextSettings: AdminSettings = hasNewerLocalChanges
          ? {
              ...latestSettings,
              githubToken: target === "githubToken" ? "" : latestSettings.githubToken,
              tokenConfigured: target === "githubToken" ? saved.tokenConfigured : latestSettings.tokenConfigured,
              openRouterApiKey: target === "openRouterApiKey" ? "" : latestSettings.openRouterApiKey,
              aiChatEnabled: target === "openRouterApiKey" ? saved.aiChatEnabled : latestSettings.aiChatEnabled,
              autoTranslateEnabled:
                target === "openRouterApiKey" ? saved.autoTranslateEnabled : latestSettings.autoTranslateEnabled,
              openRouterApiKeyConfigured:
                target === "openRouterApiKey" ? saved.openRouterApiKeyConfigured : latestSettings.openRouterApiKeyConfigured,
            }
          : {
              ...saved,
              githubToken: target === "githubToken" ? "" : latestSettings.githubToken,
              openRouterApiKey: target === "openRouterApiKey" ? "" : latestSettings.openRouterApiKey,
            };

        latestSettingsRef.current = nextSettings;
        setSettings(nextSettings);

        if (!hasNewerLocalChanges) {
          lastSavedSnapshotRef.current = createSaveSnapshot(nextSettings);
          lastSavedDomainRef.current = {
            customDomain: nextSettings.customDomain,
            letsEncryptEmail: nextSettings.letsEncryptEmail,
          };
          setThemeSettings(themeCustomizationFromSettings(nextSettings));
          showFieldErrors(validateSettingsFields(nextSettings));
        }
      } catch (error) {
        if (!signal.aborted) {
          setSaveError(formatApiError(error));
        }
      } finally {
        autoSaveInFlightRef.current = false;
        if (!signal.aborted) {
          setSettingsSaving(false);
          setClearingSecret(null);
        }

        if (autoSaveQueuedRef.current) {
          autoSaveQueuedRef.current = false;
          void persistLatestSettings();
        }
      }
    },
    [createSaveSnapshot, getLatestSaveSnapshot, lifetimeSignal, persistLatestSettings, setThemeSettings, showFieldErrors],
  );

  const refreshMarkdownCacheStatus = useCallback(async () => {
    markdownCacheStatusRequestedRef.current = true;
    setMarkdownCacheStatusLoading(true);
    setMarkdownCacheStatusError(null);

    const result = await runMarkdownCacheStatusRequest((signal) => fetchAdminMarkdownCacheStatus({ signal }));
    if (!result) {
      return;
    }

    // A failed refresh keeps the last status on screen next to the error.
    setMarkdownCacheStatus((current) => result.value ?? current);
    setMarkdownCacheStatusError(result.error);
    setMarkdownCacheStatusLoading(false);
  }, [runMarkdownCacheStatusRequest]);

  /** Keeps a Markdown cache status the admin has opened up to date after changes that affect it. */
  const refreshRequestedMarkdownCacheStatus = useCallback(() => {
    if (markdownCacheStatusRequestedRef.current) {
      void refreshMarkdownCacheStatus();
    }
  }, [refreshMarkdownCacheStatus]);

  useEffect(() => {
    const nextStatus = translationJob?.status ?? null;
    const previousStatus = lastTranslationJobStatusRef.current;
    lastTranslationJobStatusRef.current = nextStatus;

    if (previousStatus === "running" && nextStatus && nextStatus !== "running") {
      refreshRequestedMarkdownCacheStatus();
      void refreshTranslationOverview();
    }
  }, [refreshRequestedMarkdownCacheStatus, refreshTranslationOverview, translationJob?.status]);

  useEffect(() => {
    const logElement = translationLogRef.current;
    if (!logElement) {
      return;
    }

    logElement.scrollTop = logElement.scrollHeight;
  }, [translationLogEntries.length, translationJob?.id]);

  const trackMarkdownCacheWarmJob = useCallback((job: AdminMarkdownCacheWarmJob | null): void => {
    markdownCacheWarmJobRef.current = job;
    setMarkdownCacheWarmJob(job);
  }, []);

  /** Reads the latest warm job; the server answers from memory, so the card can poll it while it runs. */
  const refreshMarkdownCacheWarmJob = useCallback(async () => {
    const signal = lifetimeSignal();
    try {
      const job = await fetchAdminMarkdownCacheWarmJob({ signal });
      if (!signal.aborted) {
        trackMarkdownCacheWarmJob(job);
      }
    } catch {
      // The next poll tries again; a job that is gone for good is no longer shown once polling stops.
    }
  }, [lifetimeSignal, trackMarkdownCacheWarmJob]);

  const cacheMissingMarkdownHtml = useCallback(async () => {
    const signal = lifetimeSignal();
    setStartingMarkdownCacheWarm(true);
    setMarkdownCacheActionMessage(null);
    setMarkdownCacheStatusError(null);

    try {
      await persistLatestSettings();
      const job = await startAdminMarkdownCacheWarmJob();
      if (!signal.aborted) {
        trackMarkdownCacheWarmJob(job);
      }
    } catch (error) {
      if (!signal.aborted) {
        setMarkdownCacheActionMessage({
          tone: "error",
          text: formatApiError(error),
        });
      }
    } finally {
      if (!signal.aborted) {
        setStartingMarkdownCacheWarm(false);
      }
    }
  }, [lifetimeSignal, persistLatestSettings, trackMarkdownCacheWarmJob]);

  useEffect(() => {
    const job = markdownCacheWarmJob;
    const previousStatus = lastMarkdownCacheWarmJobStatusRef.current;
    lastMarkdownCacheWarmJobStatusRef.current = job?.status ?? null;

    if (previousStatus === "running" && job && job.status !== "running") {
      setMarkdownCacheActionMessage(markdownCacheWarmOutcome(job));
      refreshRequestedMarkdownCacheStatus();
    }
  }, [markdownCacheWarmJob, refreshRequestedMarkdownCacheStatus]);

  const clearMarkdownCacheForAllPages = useCallback(async () => {
    if (!window.confirm("Clear rendered Markdown HTML for all pages?")) {
      return;
    }

    const signal = lifetimeSignal();
    setClearingMarkdownCacheAll(true);
    setMarkdownCacheActionMessage(null);
    setMarkdownCacheStatusError(null);

    try {
      await persistLatestSettings();
      const { result, status } = await clearAdminMarkdownCache();
      if (signal.aborted) {
        return;
      }
      setMarkdownCacheStatus(status);
      setMarkdownCacheActionMessage({
        tone: "success",
        text: `Cleared ${formatCount(result.clearedEntries)} Markdown HTML cache entr${
          result.clearedEntries === 1 ? "y" : "ies"
        }.`,
      });
    } catch (error) {
      if (!signal.aborted) {
        setMarkdownCacheActionMessage({
          tone: "error",
          text: formatApiError(error),
        });
      }
    } finally {
      if (!signal.aborted) {
        setClearingMarkdownCacheAll(false);
      }
    }
  }, [lifetimeSignal, persistLatestSettings]);

  const clearMarkdownCacheForPage = useCallback(
    async (page: AdminMarkdownCachePageStatus) => {
      if (!window.confirm(`Clear rendered Markdown HTML for "${page.title}"?`)) {
        return;
      }

      const signal = lifetimeSignal();
      setClearingMarkdownCacheSlug(page.slug);
      setMarkdownCacheActionMessage(null);
      setMarkdownCacheStatusError(null);

      try {
        await persistLatestSettings();
        const { result, status } = await clearAdminMarkdownCache(page.slug);
        if (signal.aborted) {
          return;
        }
        setMarkdownCacheStatus(status);
        setMarkdownCacheActionMessage({
          tone: "success",
          text: `Cleared ${formatCount(result.clearedEntries)} Markdown HTML cache entr${
            result.clearedEntries === 1 ? "y" : "ies"
          } for ${page.title}.`,
        });
      } catch (error) {
        if (!signal.aborted) {
          setMarkdownCacheActionMessage({
            tone: "error",
            text: formatApiError(error),
          });
        }
      } finally {
        if (!signal.aborted) {
          setClearingMarkdownCacheSlug(null);
        }
      }
    },
    [lifetimeSignal, persistLatestSettings],
  );

  const refreshDocsCache = useCallback(async () => {
    const signal = lifetimeSignal();
    setRefreshingDocs(true);
    setDocsRefreshMessage(null);
    setDocsRefreshError(null);

    try {
      await persistLatestSettings();
      const result = await refreshAdminDocsCache();
      if (signal.aborted) {
        return;
      }
      setDocsRefreshMessage(
        `Fetched ${formatCount(result.pageCount)} page${result.pageCount === 1 ? "" : "s"}. Cache expires ${formatStatusTimestamp(result.expiresAt)}.`,
      );
      void refreshTranslationOverview();
      refreshRequestedMarkdownCacheStatus();
    } catch (error) {
      if (!signal.aborted) {
        setDocsRefreshError(formatApiError(error));
      }
    } finally {
      if (!signal.aborted) {
        setRefreshingDocs(false);
      }
    }
  }, [lifetimeSignal, persistLatestSettings, refreshRequestedMarkdownCacheStatus, refreshTranslationOverview]);

  const requestLanguageTranslations = useCallback(
    async (language: AutoTranslateLanguage) => {
      const code = normalizeAutoTranslateLanguageCode(language.code);
      const name = language.name.trim();

      if (!code || !name) {
        setTranslationRequestStatus({
          tone: "error",
          message: "Enter a valid language name and code before requesting translations.",
        });
        return;
      }

      const confirmed = window.confirm(
        `Request translations for all missing or outdated ${name} pages? Current localization files will be kept.`,
      );

      if (!confirmed) {
        return;
      }

      const signal = lifetimeSignal();
      setRequestedTranslationLanguageCodes((prev) => {
        const next = new Set(prev);
        next.add(code.toLowerCase());
        return next;
      });
      setTranslationRequestStatus(null);

      try {
        await persistLatestSettings();
        const icon = normalizeCircleFlagIconId(language.icon) || getDefaultAutoTranslateLanguageIcon(code);
        const job = await requestAdminLanguageTranslations({
          mode: "missing-and-outdated",
          languages: [{ name, code, icon, enabled: language.enabled !== false }],
          localizationPath: normalizeLocalizationPath(settings.autoTranslateLocalizationPath),
        });
        if (signal.aborted) {
          return;
        }
        trackTranslationJob(job);
        lastTranslationJobStatusRef.current = job.status;
        void refreshTranslationJobStatus();
      } catch (error) {
        if (!signal.aborted) {
          setTranslationRequestStatus({
            tone: "error",
            message: formatApiError(error),
          });
        }
      } finally {
        if (!signal.aborted) {
          setRequestedTranslationLanguageCodes((prev) => {
            const next = new Set(prev);
            next.delete(code.toLowerCase());
            return next;
          });
        }
      }
    },
    [lifetimeSignal, persistLatestSettings, refreshTranslationJobStatus, settings.autoTranslateLocalizationPath, trackTranslationJob],
  );

  const requestBulkTranslations = useCallback(
    async (mode: "outdated" | "missing-and-outdated") => {
      const targetLanguages = settings.autoTranslateLanguages.filter(
        (language) => !isDefaultAutoTranslateLanguageCode(language.code),
      );
      if (targetLanguages.length === 0) {
        setTranslationRequestStatus({
          tone: "error",
          message: "Add at least one target language first.",
        });
        return;
      }

      const label = mode === "outdated" ? "Update all outdated translations" : "Translate all missing and outdated pages";
      if (!window.confirm(`${label}?`)) {
        return;
      }

      const signal = lifetimeSignal();
      setTranslationBulkAction(mode);
      setTranslationRequestStatus(null);

      try {
        await persistLatestSettings();
        const job = await requestAdminLanguageTranslations({
          mode,
          languages: normalizeAutoTranslateLanguagesForSave(settings.autoTranslateLanguages),
          localizationPath: normalizeLocalizationPath(settings.autoTranslateLocalizationPath),
        });
        if (signal.aborted) {
          return;
        }
        trackTranslationJob(job);
        lastTranslationJobStatusRef.current = job.status;
        void refreshTranslationJobStatus();
      } catch (error) {
        if (!signal.aborted) {
          setTranslationRequestStatus({
            tone: "error",
            message: formatApiError(error),
          });
        }
      } finally {
        if (!signal.aborted) {
          setTranslationBulkAction(null);
        }
      }
    },
    [
      lifetimeSignal,
      persistLatestSettings,
      refreshTranslationJobStatus,
      settings.autoTranslateLanguages,
      settings.autoTranslateLocalizationPath,
      trackTranslationJob,
    ],
  );

  const recordSourceVersions = useCallback(async () => {
    const count = unrecordedTranslationCount;
    if (count === 0) {
      return;
    }

    const files = `${formatCount(count)} translation${count === 1 ? "" : "s"}`;
    const repository = `${settings.githubOwner.trim()}/${settings.githubRepo.trim()} (${settings.githubBranch.trim() || "main"})`;
    if (
      !window.confirm(
        `Record the source version in ${files}?\n\nThis commits ${count === 1 ? "1 file" : `${formatCount(count)} files`} to ${repository} in a single commit. Only the front matter changes, so the pages stay exactly as they are. Outdated translations are left alone.`,
      )
    ) {
      return;
    }

    const signal = lifetimeSignal();
    setTranslationBulkAction("source-versions");
    setTranslationRequestStatus(null);

    try {
      await persistLatestSettings();
      const job = await requestAdminSourceVersionRecording(count);
      if (signal.aborted) {
        return;
      }
      trackTranslationJob(job);
      lastTranslationJobStatusRef.current = job.status;
      void refreshTranslationJobStatus();
    } catch (error) {
      if (!signal.aborted) {
        setTranslationRequestStatus({
          tone: "error",
          message: formatApiError(error),
        });
      }
    } finally {
      if (!signal.aborted) {
        setTranslationBulkAction(null);
      }
    }
  }, [
    lifetimeSignal,
    persistLatestSettings,
    refreshTranslationJobStatus,
    settings.githubBranch,
    settings.githubOwner,
    settings.githubRepo,
    trackTranslationJob,
    unrecordedTranslationCount,
  ]);

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (loading || loadError || !autoSaveReadyRef.current) {
      return;
    }

    let requested = false;
    const refreshOnceVisible = () => {
      if (requested || document.visibilityState === "hidden") {
        return;
      }

      requested = true;
      void refreshTranslationJobStatus();
      void refreshTranslationOverview();
    };

    const timeoutId = window.setTimeout(refreshOnceVisible, TRANSLATION_CACHE_STATUS_INITIAL_DELAY_MS);
    document.addEventListener("visibilitychange", refreshOnceVisible);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", refreshOnceVisible);
    };
  }, [loadError, loading, refreshTranslationJobStatus, refreshTranslationOverview]);

  useEffect(() => {
    if (loading || loadError || translationJob?.status !== "running") {
      return;
    }

    return startJobStatusPolling({ documentTarget: document, intervalMs: TRANSLATION_CACHE_STATUS_POLL_MS, isJobRunning: () => translationJobRef.current?.status === "running", onPoll: refreshTranslationJobStatus, windowTarget: window });
  }, [loadError, loading, refreshTranslationJobStatus, translationJob?.id, translationJob?.status]);

  useEffect(() => {
    if (loading || loadError || !translationStatusesPending) {
      return;
    }

    return startJobStatusPolling({ documentTarget: document, intervalMs: TRANSLATION_OVERVIEW_POLL_MS, isJobRunning: () => translationStatusesPendingRef.current, onPoll: refreshTranslationOverview, windowTarget: window });
  }, [loadError, loading, refreshTranslationOverview, translationStatusesPending]);

  useEffect(() => {
    if (loading || loadError || markdownCacheWarmJob?.status !== "running") {
      return;
    }

    return startJobStatusPolling({ documentTarget: document, intervalMs: MARKDOWN_CACHE_WARM_JOB_POLL_MS, isJobRunning: () => markdownCacheWarmJobRef.current?.status === "running", onPoll: refreshMarkdownCacheWarmJob, windowTarget: window });
  }, [loadError, loading, markdownCacheWarmJob?.id, markdownCacheWarmJob?.status, refreshMarkdownCacheWarmJob]);

  useEffect(() => {
    if (loading || loadError) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshPerformanceStats();
    }, PERFORMANCE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadError, loading, refreshPerformanceStats]);

  useEffect(() => {
    const catchingUp = Boolean(visitorStatsStatus?.catchingUp);
    if (!catchingUp && !visitorStatsStatus?.refreshing) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshVisitorStats({ silent: true });
    }, catchingUp ? VISITOR_STATS_CATCH_UP_POLL_MS : VISITOR_STATS_PENDING_POLL_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [refreshVisitorStats, visitorStatsStatus]);

  useEffect(() => {
    if (!autoSaveReadyRef.current) {
      return;
    }

    void persistLatestSettings();
  }, [persistLatestSettings, settings]);

  useEffect(() => {
    let isActive = true;
    const signal = lifetimeSignal();
    const isCurrent = (): boolean => isActive && !signal.aborted;

    const run = async () => {
      setLoading(true);
      setLoadError(null);
      setPerformanceStatsLoading(true);
      setPerformanceStatsError(null);
      setVisitorStatsLoading(true);
      setVisitorStatsError(null);

      try {
        const currentUser = await getCurrentUser({ signal });
        if (!isCurrent()) {
          return;
        }
        if (!currentUser) {
          router.replace("/admin/login");
          return;
        }

        if (currentUser.role !== "admin") {
          router.replace("/editor");
          return;
        }

        const [loadedSettings, loadedModerators] = await Promise.all([
          fetchAdminSettings({ signal }),
          fetchAdminModerators({ signal }),
        ]);
        if (!isCurrent()) {
          return;
        }

        latestSettingsRef.current = loadedSettings;
        lastSavedSnapshotRef.current = createSaveSnapshot(loadedSettings);
        lastSavedDomainRef.current = {
          customDomain: loadedSettings.customDomain,
          letsEncryptEmail: loadedSettings.letsEncryptEmail,
        };

        setSettings(loadedSettings);
        setModerators(loadedModerators);
        setThemeSettings(themeCustomizationFromSettings(loadedSettings));
        showFieldErrors(validateSettingsFields(loadedSettings));
        autoSaveReadyRef.current = true;
        void refreshSslStatus();
        void refreshPerformanceStats();
        void refreshVisitorStats();
        // A warm job keeps running while the admin is away; show its progress again.
        void refreshMarkdownCacheWarmJob();
      } catch (error) {
        if (isCurrent()) {
          setLoadError(formatApiError(error));
          setPerformanceStatsLoading(false);
          setVisitorStatsLoading(false);
        }
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      isActive = false;
      autoSaveReadyRef.current = false;
    };
  }, [createSaveSnapshot, lifetimeSignal, refreshMarkdownCacheWarmJob, refreshPerformanceStats, refreshSslStatus, refreshVisitorStats, router, setThemeSettings, showFieldErrors]);

  if (loading) {
    return <LoadingState label="Loading admin settings..." />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Unable to load admin settings"
        message={loadError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
      />
    );
  }

  return (
    <section className="admin-page">
      {saveError ? <p className="error-text">{saveError}</p> : null}

      <div className="panel-grid">
        <div className="panel-stack-left">
          <PerformanceStatsCard
            error={performanceStatsError}
            loading={performanceStatsLoading}
            stats={performanceStats}
            onRefresh={() => {
              void refreshPerformanceStats();
            }}
          />

          <section className="panel-card panel-card-repo">
          <div className="panel-header">
            <h1>Repository Settings</h1>
          </div>

          <p className="panel-description">
            Configure repository connectivity, write credentials, and docs refresh behavior.
          </p>

          <div className="form-grid">
            <div className="settings-subcard">
              <div className="settings-subcard-fields">
                <label className="field-row" htmlFor="docs-refresh-interval-minutes">
                  <span className="field-label">Docs refresh interval (minutes)</span>
                  <input
                    id="docs-refresh-interval-minutes"
                    className="input"
                    type="number"
                    min={MIN_DOCS_REFRESH_INTERVAL_MINUTES}
                    max={MAX_DOCS_REFRESH_INTERVAL_MINUTES}
                    step={1}
                    value={settings.docsRefreshIntervalMinutes}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      const normalized = Number.isFinite(parsed) ? Math.min(MAX_DOCS_REFRESH_INTERVAL_MINUTES, Math.max(MIN_DOCS_REFRESH_INTERVAL_MINUTES, parsed)) : MIN_DOCS_REFRESH_INTERVAL_MINUTES;
                      setSettings((prev) => ({ ...prev, docsRefreshIntervalMinutes: normalized }));
                    }}
                    required
                  />
                  <span className="field-hint">
                    {MIN_DOCS_REFRESH_INTERVAL_MINUTES} to {MAX_DOCS_REFRESH_INTERVAL_MINUTES} minutes (24 hours). Vicky checks GitHub for changes once per interval and only downloads pages that changed.
                  </span>
                </label>
              </div>
            </div>

            <div className="settings-subcard">
              <div className="settings-subcard-fields">
                <div className="field-row">
                  <label className="field-label" htmlFor="github-token">
                    GitHub token
                  </label>
                  <div className="secret-input-row">
                    <input
                      id="github-token"
                      className="input"
                      type="text"
                      autoComplete="off"
                      value={settings.githubToken}
                      onChange={(event) => {
                        setSettings((prev) => ({ ...prev, githubToken: event.target.value }));
                      }}
                      placeholder={
                        settings.tokenConfigured ? "Saved token configured (leave blank to keep)" : "github_pat_... or ghp_..."
                      }
                    />
                    <button
                      type="button"
                      className="btn secret-clear-button"
                      disabled={
                        settingsSaving ||
                        clearingSecret !== null ||
                        (!settings.githubToken.trim() && !settings.tokenConfigured)
                      }
                      onClick={() => {
                        void clearSavedSecret("githubToken");
                      }}
                    >
                      {clearingSecret === "githubToken" ? "Clearing..." : "Clear"}
                    </button>
                  </div>
                  <span className="field-hint">
                    Use a PAT for this repo. Minimum permissions: Contents (read/write) and Metadata (read-only).
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-subcard">
              <div className="settings-subcard-fields">
                <div className="field-inline">
                  <label className="field-row" htmlFor="repo-owner">
                    <span className="field-label">Owner</span>
                    <input
                      id="repo-owner"
                      className="input"
                      value={settings.githubOwner}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubOwner: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      GitHub user or org name only. Example: <code>Keksuccino</code>.
                    </span>
                  </label>
                  <label className="field-row" htmlFor="repo-name">
                    <span className="field-label">Repository</span>
                    <input
                      id="repo-name"
                      className="input"
                      value={settings.githubRepo}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubRepo: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      Repository name only. Example: <code>Vicky</code> (no owner, no <code>.git</code>).
                    </span>
                  </label>
                </div>

                <div className="field-inline">
                  <label className="field-row" htmlFor="repo-branch">
                    <span className="field-label">Branch</span>
                    <input
                      id="repo-branch"
                      className="input"
                      value={settings.githubBranch}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubBranch: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      Existing branch name. Example: <code>main</code>.
                    </span>
                  </label>
                  <label className="field-row" htmlFor="docs-path">
                    <span className="field-label">Docs path</span>
                    <input
                      id="docs-path"
                      className="input"
                      value={settings.githubDocsPath}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubDocsPath: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      Folder inside the repo where markdown files live. Example: <code>docs</code>.
                    </span>
                  </label>
                </div>

                <div className="action-row">
                  <button type="button" className="btn" disabled={refreshingDocs} onClick={refreshDocsCache}>
                    <MaterialIcon name={refreshingDocs ? "sync" : "cloud_sync"} />
                    <span>{refreshingDocs ? "Fetching..." : "Fetch pages now"}</span>
                  </button>

                  <button
                    type="button"
                    className="btn"
                    disabled={testingConnection}
                    onClick={async () => {
                      const signal = lifetimeSignal();
                      setTestingConnection(true);
                      setConnectionMessage(null);
                      setConnectionError(null);

                      try {
                        const message = await testAdminConnection(settings, { signal });
                        if (!signal.aborted) {
                          setConnectionMessage(message);
                        }
                      } catch (error) {
                        if (!signal.aborted) {
                          setConnectionError(formatApiError(error));
                        }
                      } finally {
                        if (!signal.aborted) {
                          setTestingConnection(false);
                        }
                      }
                    }}
                  >
                    <MaterialIcon name={testingConnection ? "hourglass_top" : "network_check"} />
                    <span>{testingConnection ? "Testing..." : "Test connection"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {connectionMessage ? <p className="success-text">{connectionMessage}</p> : null}
          {connectionError ? <p className="error-text">{connectionError}</p> : null}
          {docsRefreshMessage ? <p className="success-text">{docsRefreshMessage}</p> : null}
          {docsRefreshError ? <p className="error-text">{docsRefreshError}</p> : null}
          </section>

          <MarkdownCacheCard
            actionMessage={markdownCacheActionMessage}
            clearingAll={clearingMarkdownCacheAll}
            clearingSlug={clearingMarkdownCacheSlug}
            error={markdownCacheStatusError}
            loading={markdownCacheStatusLoading}
            status={markdownCacheStatus}
            warmJob={markdownCacheWarmJob}
            warmStarting={startingMarkdownCacheWarm}
            onClearAll={clearMarkdownCacheForAllPages}
            onClearPage={clearMarkdownCacheForPage}
            onRefresh={() => {
              void refreshMarkdownCacheStatus();
            }}
            onWarmAll={() => {
              void cacheMissingMarkdownHtml();
            }}
          />

          <section className="panel-card panel-card-moderators">
            <div className="panel-header">
              <h2>Moderator Accounts</h2>
            </div>

            <p className="panel-description">
              Create Moderator accounts. Moderators only have access to the editor, not the admin panel.
            </p>

            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateModerator();
              }}
            >
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <label className="field-row" htmlFor="moderator-username">
                      <span className="field-label">Username</span>
                      <input
                        id="moderator-username"
                        className="input"
                        value={moderatorUsername}
                        onChange={(event) => setModeratorUsername(event.target.value)}
                        placeholder="docs-editor"
                        autoComplete="off"
                        required
                      />
                    </label>

                    <div className="field-row">
                      <label className="field-label" htmlFor="moderator-password">
                        Password
                      </label>
                      <div className="password-input-row">
                        <input
                          id="moderator-password"
                          className="input"
                          type={showModeratorPassword ? "text" : "password"}
                          value={moderatorPassword}
                          onChange={(event) => setModeratorPassword(event.target.value)}
                          autoComplete="new-password"
                          required
                        />
                        <button
                          type="button"
                          className="btn btn-icon password-toggle-button"
                          aria-label={showModeratorPassword ? "Hide password" : "Show password"}
                          aria-pressed={showModeratorPassword}
                          onClick={() => setShowModeratorPassword((current) => !current)}
                        >
                          <MaterialIcon name={showModeratorPassword ? "visibility_off" : "visibility"} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="action-row">
                    <button type="submit" className="btn" disabled={moderatorSaving}>
                      <MaterialIcon name={moderatorSaving ? "hourglass_top" : "person_add"} />
                      <span>{moderatorSaving ? "Adding..." : "Add moderator"}</span>
                    </button>
                  </div>
                </div>
              </div>
            </form>

            {moderatorError ? <p className="error-text">{moderatorError}</p> : null}

            <div className="moderator-list">
              {moderators.length > 0 ? (
                moderators.map((moderator) => {
                  const isEditing = editingModeratorId === moderator.id;
                  const isBusy = moderatorActionId === moderator.id;

                  return (
                    <div className="moderator-item" key={moderator.id}>
                      {isEditing ? (
                        <form
                          className="moderator-edit-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleUpdateModerator(moderator);
                          }}
                        >
                          <div className="field-inline">
                            <label className="field-row" htmlFor={`moderator-edit-username-${moderator.id}`}>
                              <span className="field-label">Username</span>
                              <input
                                id={`moderator-edit-username-${moderator.id}`}
                                className="input"
                                value={editingModeratorUsername}
                                onChange={(event) => setEditingModeratorUsername(event.target.value)}
                                autoComplete="off"
                                required
                              />
                            </label>

                            <div className="field-row">
                              <label className="field-label" htmlFor={`moderator-edit-password-${moderator.id}`}>
                                New password
                              </label>
                              <div className="password-input-row">
                                <input
                                  id={`moderator-edit-password-${moderator.id}`}
                                  className="input"
                                  type={showEditingModeratorPassword ? "text" : "password"}
                                  value={editingModeratorPassword}
                                  onChange={(event) => setEditingModeratorPassword(event.target.value)}
                                  autoComplete="new-password"
                                  placeholder="Leave blank to keep"
                                />
                                <button
                                  type="button"
                                  className="btn btn-icon password-toggle-button"
                                  aria-label={showEditingModeratorPassword ? "Hide password" : "Show password"}
                                  aria-pressed={showEditingModeratorPassword}
                                  onClick={() => setShowEditingModeratorPassword((current) => !current)}
                                >
                                  <MaterialIcon name={showEditingModeratorPassword ? "visibility_off" : "visibility"} />
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="action-row">
                            <button type="submit" className="btn btn-primary" disabled={isBusy}>
                              <MaterialIcon name={isBusy ? "hourglass_top" : "save"} />
                              <span>{isBusy ? "Saving..." : "Save moderator"}</span>
                            </button>
                            <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={resetModeratorEditor}>
                              <MaterialIcon name="close" />
                              <span>Cancel</span>
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="moderator-item-main">
                            <strong>{moderator.username}</strong>
                            <span>Updated {formatStatusTimestamp(moderator.updatedAt)}</span>
                          </div>

                          <div className="moderator-actions">
                            <span className="moderator-action-tooltip ui-tooltip" data-ui-tooltip="Edit">
                              <button
                                type="button"
                                className="btn btn-icon moderator-action-button"
                                aria-label="Edit"
                                disabled={Boolean(moderatorActionId)}
                                onClick={() => {
                                  setModeratorError(null);
                                  setEditingModeratorId(moderator.id);
                                  setEditingModeratorUsername(moderator.username);
                                  setEditingModeratorPassword("");
                                  setShowEditingModeratorPassword(false);
                                }}
                              >
                                <MaterialIcon name="edit" />
                              </button>
                            </span>
                            <span
                              className="moderator-action-tooltip ui-tooltip"
                              data-ui-tooltip="Remove"
                            >
                              <button
                                type="button"
                                className="btn btn-icon danger moderator-action-button"
                                aria-label="Remove"
                                disabled={Boolean(moderatorActionId)}
                                onClick={() => {
                                  if (window.confirm(`Remove moderator "${moderator.username}"?`)) {
                                    void handleDeleteModerator(moderator);
                                  }
                                }}
                              >
                                <MaterialIcon name={isBusy ? "hourglass_top" : "delete"} />
                              </button>
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="muted-caption">No moderator accounts yet.</p>
              )}
            </div>
          </section>

          <section className="panel-card panel-card-site">
            <div className="panel-header">
              <h2>Site Settings</h2>
            </div>

            <p className="panel-description">Configure site branding, footer text, start page behavior, and icon assets.</p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <label className="field-row" htmlFor="site-title">
                      <span className="field-label">Site title</span>
                      <input
                        id="site-title"
                        className="input"
                        value={settings.siteTitle}
                        onChange={(event) => setSettings((prev) => ({ ...prev, siteTitle: event.target.value }))}
                        required
                      />
                      <span className="field-hint">Shown in the header and browser metadata.</span>
                    </label>

                    <label className="field-row" htmlFor="site-description">
                      <span className="field-label">Site description</span>
                      <input
                        id="site-description"
                        className="input"
                        value={settings.siteDescription}
                        onChange={(event) => setSettings((prev) => ({ ...prev, siteDescription: event.target.value }))}
                        required
                      />
                      <span className="field-hint">Short summary used in metadata and previews.</span>
                    </label>
                  </div>

                  <label className="field-row" htmlFor="site-footer-text">
                    <span className="field-label">
                      Footer Text
                    </span>
                    <input
                      id="site-footer-text"
                      className="input"
                      value={settings.footerText}
                      onChange={(event) => setSettings((prev) => ({ ...prev, footerText: event.target.value }))}
                      placeholder={DEFAULT_FOOTER_TEXT}
                      required
                    />
                    <span className="field-hint">
                      <code>{`{{year}}`}</code>, <code>{`{{owner}}`}</code>, and <code>{`{{vicky}}`}</code> are replaced
                      automatically. <code>{`{{vicky}}`}</code> becomes a clickable link to the Vicky repository.
                    </span>
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <ColorPickerField
                      id="site-title-gradient-from"
                      label="Site title gradient from (optional)"
                      value={settings.siteTitleGradientFrom}
                      allowEmpty
                      fallbackColor={DEFAULT_SITE_TITLE_GRADIENT_FROM}
                      hint="Pick the start color for the site title gradient. Clear both gradient colors to disable it."
                      onChange={(value) => setSettings((prev) => ({ ...prev, siteTitleGradientFrom: value }))}
                    />

                    <ColorPickerField
                      id="site-title-gradient-to"
                      label="Site title gradient to (optional)"
                      value={settings.siteTitleGradientTo}
                      allowEmpty
                      fallbackColor={DEFAULT_SITE_TITLE_GRADIENT_TO}
                      hint="Pick the end color for the site title gradient. Clear both gradient colors to disable it."
                      onChange={(value) => setSettings((prev) => ({ ...prev, siteTitleGradientTo: value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <label className="field-row" htmlFor="site-start-page">
                    <span className="field-label">Start page (docs path)</span>
                    <input
                      id="site-start-page"
                      className="input"
                      value={settings.startPage}
                      onChange={(event) => setSettings((prev) => ({ ...prev, startPage: event.target.value }))}
                      placeholder="/home"
                      required
                    />
                    <span className="field-hint">
                      Preferred format: <code>/home</code>. <code>/docs/home</code> and full docs URLs are normalized
                      automatically.
                    </span>
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <label className="field-row" htmlFor="docs-icon-png-16">
                      <span className="field-label">Docs icon 16x16 PNG URL</span>
                      <input
                        id="docs-icon-png-16"
                        className="input"
                        value={settings.docsIconPng16Url}
                        onChange={(event) => setSettings((prev) => ({ ...prev, docsIconPng16Url: event.target.value }))}
                        placeholder="https://example.com/docs-icon-16.png"
                      />
                      <span className="field-hint">Public absolute URL to a PNG file, exactly 16x16 recommended.</span>
                    </label>

                    <label className="field-row" htmlFor="docs-icon-png-32">
                      <span className="field-label">Docs icon 32x32 PNG URL</span>
                      <input
                        id="docs-icon-png-32"
                        className="input"
                        value={settings.docsIconPng32Url}
                        onChange={(event) => setSettings((prev) => ({ ...prev, docsIconPng32Url: event.target.value }))}
                        placeholder="https://example.com/docs-icon-32.png"
                      />
                      <span className="field-hint">Public absolute URL to a PNG file, exactly 32x32 recommended.</span>
                    </label>
                  </div>

                  <label className="field-row" htmlFor="docs-icon-png-180">
                    <span className="field-label">Docs icon 180x180 PNG URL</span>
                    <input
                      id="docs-icon-png-180"
                      className="input"
                      value={settings.docsIconPng180Url}
                      onChange={(event) => setSettings((prev) => ({ ...prev, docsIconPng180Url: event.target.value }))}
                      placeholder="https://example.com/docs-icon-180.png"
                    />
                    <span className="field-hint">
                      Public absolute URL to a PNG file, exactly 180x180 recommended (Apple touch icon).
                    </span>
                  </label>
                </div>
              </div>

            </div>
          </section>

          <section className="panel-card panel-card-domain">
            <div className="panel-header">
              <h2>Domain Settings</h2>
            </div>

            <p className="panel-description">
              Configure your custom domain and Let&apos;s Encrypt contact email for automatic HTTPS certificate management.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <label className="field-row" htmlFor="domain-custom-domain">
                    <span className="field-label">Custom domain</span>
                    <input
                      id="domain-custom-domain"
                      className="input"
                      value={settings.customDomain}
                      aria-invalid={Boolean(domainFieldErrors.customDomain)}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSettings((prev) => ({ ...prev, customDomain: value }));
                        setDomainFieldErrors((prev) => ({
                          ...prev,
                          customDomain: validateCustomDomainInput(value),
                        }));
                      }}
                      placeholder="docs.example.com"
                    />
                    <span className="field-hint">
                      Hostname only (no protocol or path). Example: <code>example.com</code> or{" "}
                      <code>docs.example.com</code>.
                    </span>
                    {domainFieldErrors.customDomain ? <span className="error-text">{domainFieldErrors.customDomain}</span> : null}
                  </label>

                  <label className="field-row" htmlFor="domain-letsencrypt-email">
                    <span className="field-label">Let&apos;s Encrypt email</span>
                    <input
                      id="domain-letsencrypt-email"
                      className="input"
                      type="email"
                      value={settings.letsEncryptEmail}
                      aria-invalid={Boolean(domainFieldErrors.letsEncryptEmail)}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSettings((prev) => ({ ...prev, letsEncryptEmail: value }));
                        setDomainFieldErrors((prev) => ({
                          ...prev,
                          letsEncryptEmail: validateLetsEncryptEmailInput(value),
                        }));
                      }}
                      placeholder="admin@example.com"
                    />
                    <span className="field-hint">
                      Required for automatic certificate registration and renewal notifications.
                    </span>
                    {domainFieldErrors.letsEncryptEmail ? (
                      <span className="error-text">{domainFieldErrors.letsEncryptEmail}</span>
                    ) : null}
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <span className="field-label">SSL runtime status</span>
                    {sslStatusLoading ? <span className="field-hint">Checking certificate runtime status...</span> : null}
                    {!sslStatusLoading && sslStatus ? (
                      <>
                        <p className={statusToneClassName(sslStatus)}>{sslStatus.message}</p>
                        <span className="field-hint">
                          Source:{" "}
                          {sslStatus.source === "runtime"
                            ? "private runtime status snapshot."
                            : "best-effort check (settings + local cert files)."}
                        </span>
                        {sslStatus.certificateExpiresAt ? (
                          <span className="field-hint">
                            Certificate expiry: {formatStatusTimestamp(sslStatus.certificateExpiresAt)}.
                          </span>
                        ) : null}
                        <span className="field-hint">
                          Custom-domain HTTP policy: {formatCustomDomainHttpPolicy(sslStatus)}.
                        </span>
                        <span className="field-hint">Last checked: {formatStatusTimestamp(sslStatus.checkedAt)}.</span>
                      </>
                    ) : null}
                    {sslStatusError ? <p className="warning-text">Could not load SSL runtime status: {sslStatusError}</p> : null}
                  </div>

                  <p className="warning-text">
                    Automatic SSL runs only when both values are set and DNS points this domain to your server.
                  </p>
                </div>
              </div>

            </div>
          </section>

          <section className="panel-card panel-card-ai-chat">
            <div className="panel-header">
              <h2>AI Chat</h2>
            </div>

            <p className="panel-description">
              Configure the AI chat assistant shown in docs pages.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <span className="field-label">Enable AI chat</span>
                    <EnabledToggle
                      id="ai-chat-enabled"
                      checked={settings.aiChatEnabled}
                      onChange={(enabled) => setSettings((prev) => ({ ...prev, aiChatEnabled: enabled }))}
                    />
                    <span className="field-hint">
                      Shows the floating Ask Docs button on docs pages and enables the public chat API route.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-assistant-name">
                      Assistant name
                    </label>
                    <div className="field-control-row">
                      <input
                        id="ai-chat-assistant-name"
                        className="input"
                        value={settings.aiChatAssistantName}
                        onChange={(event) => setSettings((prev) => ({ ...prev, aiChatAssistantName: event.target.value }))}
                        placeholder={DEFAULT_AI_CHAT_ASSISTANT_NAME}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatAssistantName === DEFAULT_AI_CHAT_ASSISTANT_NAME}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, aiChatAssistantName: DEFAULT_AI_CHAT_ASSISTANT_NAME }))
                        }
                      />
                    </div>
                    <span className="field-hint">
                      Shown in the chat header, welcome message, and reply labels. Use{" "}
                      <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> in the system prompt to reference this value dynamically.
                    </span>
                  </div>

                  <label className="field-row" htmlFor="ai-chat-avatar-url">
                    <span className="field-label">Assistant profile image URL</span>
                    <input
                      id="ai-chat-avatar-url"
                      className="input"
                      value={settings.aiChatAvatarUrl}
                      onChange={(event) => setSettings((prev) => ({ ...prev, aiChatAvatarUrl: event.target.value }))}
                      placeholder="https://example.com/assistant-avatar.png"
                    />
                    <span className="field-hint">
                      Optional image shown in the top-left chat header badge. Leave blank to use the default assistant icon.
                    </span>
                  </label>

                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-header-subtitle">
                      Header subtitle
                    </label>
                    <div className="field-control-row">
                      <input
                        id="ai-chat-header-subtitle"
                        className="input"
                        value={settings.aiChatHeaderSubtitle}
                        onChange={(event) => setSettings((prev) => ({ ...prev, aiChatHeaderSubtitle: event.target.value }))}
                        placeholder={DEFAULT_AI_CHAT_HEADER_SUBTITLE}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatHeaderSubtitle === DEFAULT_AI_CHAT_HEADER_SUBTITLE}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, aiChatHeaderSubtitle: DEFAULT_AI_CHAT_HEADER_SUBTITLE }))
                        }
                      />
                    </div>
                    <span className="field-hint">
                      Shown below the assistant name in the chat header. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> if
                      you want the configured assistant name inserted automatically.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-welcome-message">
                      Welcome message
                    </label>
                    <div className="field-control-stack">
                      <textarea
                        id="ai-chat-welcome-message"
                        className="input textarea"
                        rows={4}
                        value={settings.aiChatWelcomeMessage}
                        onChange={(event) => setSettings((prev) => ({ ...prev, aiChatWelcomeMessage: event.target.value }))}
                        placeholder={DEFAULT_AI_CHAT_WELCOME_MESSAGE}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatWelcomeMessage === DEFAULT_AI_CHAT_WELCOME_MESSAGE}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, aiChatWelcomeMessage: DEFAULT_AI_CHAT_WELCOME_MESSAGE }))
                        }
                      />
                    </div>
                    <span className="field-hint">
                      Shown as the first assistant message in new chats. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> if
                      you want the configured assistant name inserted automatically.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="openrouter-model">
                      OpenRouter model
                    </label>
                    <div className="field-control-row">
                      <input
                        id="openrouter-model"
                        className="input"
                        value={settings.openRouterModel}
                        aria-invalid={Boolean(aiChatFieldErrors.openRouterModel)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, openRouterModel: value }));
                          setAiChatFieldErrors((prev) => ({
                            ...prev,
                            openRouterModel: validateOpenRouterModelInput(value, settings.aiChatEnabled),
                          }));
                        }}
                        placeholder={DEFAULT_AI_CHAT_OPENROUTER_MODEL}
                      />
                      <ResetToDefaultButton
                        disabled={settings.openRouterModel === DEFAULT_AI_CHAT_OPENROUTER_MODEL}
                        onClick={() => {
                          setSettings((prev) => ({ ...prev, openRouterModel: DEFAULT_AI_CHAT_OPENROUTER_MODEL }));
                          setAiChatFieldErrors((prev) => ({ ...prev, openRouterModel: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Example: <code>openai/gpt-5.4-mini</code>. Use a vision-capable model if you want image uploads.
                    </span>
                    {aiChatFieldErrors.openRouterModel ? <span className="error-text">{aiChatFieldErrors.openRouterModel}</span> : null}
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-system-prompt">
                      System prompt template
                    </label>
                    <div className="field-control-stack">
                      <textarea
                        id="ai-chat-system-prompt"
                        className="input textarea"
                        rows={10}
                        value={settings.aiChatSystemPrompt}
                        aria-invalid={Boolean(aiChatFieldErrors.systemPrompt)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, aiChatSystemPrompt: value }));
                          setAiChatFieldErrors((prev) => ({
                            ...prev,
                            systemPrompt: validateSystemPromptInput(value, settings.aiChatEnabled),
                          }));
                        }}
                        placeholder={DEFAULT_AI_CHAT_SYSTEM_PROMPT}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatSystemPrompt === DEFAULT_AI_CHAT_SYSTEM_PROMPT}
                        onClick={() => {
                          setSettings((prev) => ({ ...prev, aiChatSystemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT }));
                          setAiChatFieldErrors((prev) => ({ ...prev, systemPrompt: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> for the configured assistant name and keep{" "}
                      <code>{AI_CHAT_DOCS_PLACEHOLDER}</code> exactly where the live <code>/docs.txt</code> export should be injected.
                    </span>
                    {aiChatFieldErrors.systemPrompt ? <span className="error-text">{aiChatFieldErrors.systemPrompt}</span> : null}
                  </div>
                </div>
              </div>

            </div>
          </section>
        </div>

        <div className="panel-stack-right">
          <VisitorStatsCard
            activeScope={visitorStatsScope}
            error={visitorStatsError}
            loading={visitorStatsLoading}
            stats={visitorStats}
            status={visitorStatsStatus}
            onRefresh={() => {
              void refreshVisitorStats({ refresh: true });
            }}
            onScopeChange={setVisitorStatsScope}
          />

          <section className="panel-card panel-card-theme">
            <div className="panel-header">
              <h2>Theme Management</h2>
            </div>

            <p className="panel-description">Customize the Light and Dark mode emphasis and interface accent colors.</p>

            <div className="theme-editor">
              <div className="theme-color-grid">
                <div className="theme-color-section">
                  <strong className="theme-color-section-title">Light mode</strong>
                  <div className="theme-accent-fields">
                    <ColorPickerField
                      id="theme-light-surface-accent"
                      label="Interface accent"
                      value={settings.themeLightSurfaceAccent}
                      fallbackColor={THEME_DEFAULTS.lightSurfaceAccent}
                      showReset
                      hint="Used for default buttons, controls, subtle hover states, panels, page headers, and navigation surfaces in Light mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeLightSurfaceAccent: value }))}
                    />
                    <ColorPickerField
                      id="theme-light-accent"
                      label="Emphasis accent"
                      value={settings.themeLightAccent}
                      fallbackColor={THEME_DEFAULTS.lightAccent}
                      showReset
                      hint="Used for links, primary actions, active states, focus borders, and strong highlights in Light mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeLightAccent: value }))}
                    />
                  </div>
                </div>

                <div className="theme-color-section">
                  <strong className="theme-color-section-title">Dark mode</strong>
                  <div className="theme-accent-fields">
                    <ColorPickerField
                      id="theme-dark-surface-accent"
                      label="Interface accent"
                      value={settings.themeDarkSurfaceAccent}
                      fallbackColor={THEME_DEFAULTS.darkSurfaceAccent}
                      showReset
                      hint="Used for default buttons, controls, subtle hover states, panels, page headers, and navigation surfaces in Dark mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeDarkSurfaceAccent: value }))}
                    />
                    <ColorPickerField
                      id="theme-dark-accent"
                      label="Emphasis accent"
                      value={settings.themeDarkAccent}
                      fallbackColor={THEME_DEFAULTS.darkAccent}
                      showReset
                      hint="Used for links, primary actions, active states, focus borders, and strong highlights in Dark mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeDarkAccent: value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="theme-preview-grid">
                <div className="theme-preview-card" style={lightPreviewStyle}>
                  <div className="theme-preview-header">
                    <strong>Light mode</strong>
                    <span className="theme-preview-chip">Preview</span>
                  </div>
                  <p className="theme-preview-copy">
                    Emphasis accent drives links, primary actions, active states, and strong highlights. Interface accent drives controls and navigation surfaces.
                  </p>
                  <div className="theme-preview-actions">
                    <span className="theme-preview-link">Example link</span>
                    <span className="theme-preview-surface-chip">Interface control</span>
                    <button type="button" className="theme-preview-button">
                      Emphasis action
                    </button>
                  </div>
                </div>

                <div className="theme-preview-card" style={darkPreviewStyle}>
                  <div className="theme-preview-header">
                    <strong>Dark mode</strong>
                    <span className="theme-preview-chip">Preview</span>
                  </div>
                  <p className="theme-preview-copy">
                    Emphasis accent drives links, primary actions, active states, and strong highlights. Interface accent drives controls and navigation surfaces.
                  </p>
                  <div className="theme-preview-actions">
                    <span className="theme-preview-link">Example link</span>
                    <span className="theme-preview-surface-chip">Interface control</span>
                    <button type="button" className="theme-preview-button">
                      Emphasis action
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <label className="field-row" htmlFor="theme-custom-css">
                    <span className="field-label">Custom CSS</span>
                    <textarea
                      id="theme-custom-css"
                      className="input textarea"
                      rows={6}
                      value={settings.themeCustomCss}
                      onChange={(event) => setSettings((prev) => ({ ...prev, themeCustomCss: event.target.value }))}
                      placeholder=".markdown-body a { text-decoration-thickness: 2px; }"
                    />
                    <span className="field-hint">
                      Optional advanced overrides applied on top of the built-in Light and Dark themes.
                    </span>
                  </label>
                </div>
              </div>

            </div>
          </section>

          <section className="panel-card panel-card-openrouter">
            <div className="panel-header">
              <h2>OpenRouter Settings</h2>
            </div>

            <p className="panel-description">
              Shared OpenRouter credentials for AI-powered docs features.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="openrouter-api-key">
                      OpenRouter API key
                    </label>
                    <div className="secret-input-row">
                      <input
                        id="openrouter-api-key"
                        className="input"
                        type="text"
                        autoComplete="off"
                        value={settings.openRouterApiKey}
                        aria-invalid={Boolean(openRouterFieldErrors.apiKey)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, openRouterApiKey: value }));
                          setOpenRouterFieldErrors((prev) => ({
                            ...prev,
                            apiKey: validateOpenRouterApiKeyInput(
                              value,
                              settings.openRouterApiKeyConfigured,
                              settings.aiChatEnabled || settings.autoTranslateEnabled,
                            ),
                          }));
                        }}
                        placeholder={
                          settings.openRouterApiKeyConfigured
                            ? "Saved OpenRouter key configured (leave blank to keep)"
                            : "sk-or-v1-..."
                        }
                      />
                      <button
                        type="button"
                        className="btn secret-clear-button"
                        disabled={
                          settingsSaving ||
                          clearingSecret !== null ||
                          (!settings.openRouterApiKey.trim() && !settings.openRouterApiKeyConfigured)
                        }
                        onClick={() => {
                          void clearSavedSecret("openRouterApiKey");
                        }}
                      >
                        {clearingSecret === "openRouterApiKey" ? "Clearing..." : "Clear"}
                      </button>
                    </div>
                    <span className="field-hint">
                      Stored encrypted in the local app settings file. Leave blank to keep the existing saved key.
                    </span>
                    {openRouterFieldErrors.apiKey ? <span className="error-text">{openRouterFieldErrors.apiKey}</span> : null}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel-card panel-card-auto-translate">
            <div className="panel-header">
              <h2>Page Localization</h2>
            </div>

            <p className="panel-description">
              Serve manually maintained GitHub localization files and optionally update outdated translations with OpenRouter.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <span className="field-label">Automatic translation updates</span>
                    <EnabledToggle
                      id="auto-translate-enabled"
                      checked={settings.autoTranslateEnabled}
                      onChange={(enabled) => {
                        setSettings((prev) => ({ ...prev, autoTranslateEnabled: enabled }));
                        setOpenRouterFieldErrors((prev) => ({
                          ...prev,
                          apiKey: validateOpenRouterApiKeyInput(
                            settings.openRouterApiKey,
                            settings.openRouterApiKeyConfigured,
                            enabled || settings.aiChatEnabled,
                          ),
                        }));
                      }}
                    />
                    <span className="field-hint">
                      When enabled, requested outdated existing localization files are updated automatically. Missing files are only created by admin actions.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="auto-translate-localization-path">
                      Localization directory
                    </label>
                    <div className="field-control-row">
                      <input
                        id="auto-translate-localization-path"
                        className="input"
                        value={settings.autoTranslateLocalizationPath}
                        aria-invalid={Boolean(autoTranslateFieldErrors.localizationPath)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, autoTranslateLocalizationPath: value }));
                          setAutoTranslateFieldErrors((prev) => ({
                            ...prev,
                            localizationPath: validateLocalizationPathInput(value),
                          }));
                        }}
                        onBlur={(event) => {
                          const normalized = normalizeLocalizationPath(event.target.value);
                          setSettings((prev) => ({ ...prev, autoTranslateLocalizationPath: normalized }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, localizationPath: null }));
                        }}
                        placeholder={DEFAULT_LOCALIZATION_PATH}
                      />
                      <ResetToDefaultButton
                        disabled={settings.autoTranslateLocalizationPath === DEFAULT_LOCALIZATION_PATH}
                        onClick={() => {
                          setSettings((prev) => ({
                            ...prev,
                            autoTranslateLocalizationPath: DEFAULT_LOCALIZATION_PATH,
                          }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, localizationPath: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Repo-root directory. Files live at <code>{settings.autoTranslateLocalizationPath || DEFAULT_LOCALIZATION_PATH}/&lt;lang&gt;/page.md</code>.
                    </span>
                    {autoTranslateFieldErrors.localizationPath ? (
                      <span className="error-text">{autoTranslateFieldErrors.localizationPath}</span>
                    ) : null}
                  </div>

                  <div className="field-row">
                    <label className="field-label" htmlFor="auto-translate-openrouter-model">
                      Translation model
                    </label>
                    <div className="field-control-row">
                      <input
                        id="auto-translate-openrouter-model"
                        className="input"
                        value={settings.autoTranslateOpenRouterModel}
                        aria-invalid={Boolean(autoTranslateFieldErrors.openRouterModel)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, autoTranslateOpenRouterModel: value }));
                          setAutoTranslateFieldErrors((prev) => ({
                            ...prev,
                            openRouterModel: validateOpenRouterModelInput(value, settings.autoTranslateEnabled),
                          }));
                        }}
                        placeholder={DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}
                      />
                      <ResetToDefaultButton
                        disabled={settings.autoTranslateOpenRouterModel === DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}
                        onClick={() => {
                          setSettings((prev) => ({
                            ...prev,
                            autoTranslateOpenRouterModel: DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
                          }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, openRouterModel: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Default: <code>{DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}</code>.
                    </span>
                    {autoTranslateFieldErrors.openRouterModel ? (
                      <span className="error-text">{autoTranslateFieldErrors.openRouterModel}</span>
                    ) : null}
                  </div>

                  <div className="field-row">
                    <label className="field-label" htmlFor="auto-translate-request-timeout">
                      Request timeout
                    </label>
                    <div className="field-control-row">
                      <input
                        id="auto-translate-request-timeout"
                        className="input"
                        type="number"
                        min={MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000}
                        step={1}
                        value={settings.autoTranslateRequestTimeoutSeconds}
                        aria-invalid={Boolean(autoTranslateFieldErrors.requestTimeout)}
                        onChange={(event) => {
                          const rawValue = Number(event.target.value);
                          const value = Number.isFinite(rawValue)
                            ? rawValue
                            : MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000;
                          setSettings((prev) => ({ ...prev, autoTranslateRequestTimeoutSeconds: value }));
                          setAutoTranslateFieldErrors((prev) => ({
                            ...prev,
                            requestTimeout: validateAutoTranslateRequestTimeoutSeconds(value),
                          }));
                        }}
                        onBlur={(event) => {
                          const normalized = normalizeAutoTranslateRequestTimeoutSeconds(
                            Number(event.currentTarget.value),
                          );
                          setSettings((prev) => ({ ...prev, autoTranslateRequestTimeoutSeconds: normalized }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, requestTimeout: null }));
                        }}
                      />
                      <ResetToDefaultButton
                        disabled={
                          settings.autoTranslateRequestTimeoutSeconds ===
                          DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000
                        }
                        onClick={() => {
                          setSettings((prev) => ({
                            ...prev,
                            autoTranslateRequestTimeoutSeconds: DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000,
                          }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, requestTimeout: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Seconds per OpenRouter translation request. Default:{" "}
                      <code>{DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000}</code>.
                    </span>
                    {autoTranslateFieldErrors.requestTimeout ? (
                      <span className="error-text">{autoTranslateFieldErrors.requestTimeout}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="field-row">
                <span className="field-label">Selectable languages</span>
                <div className="action-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={activeTranslationMode !== null}
                    onClick={() => {
                      void requestBulkTranslations("outdated");
                    }}
                  >
                    <MaterialIcon name={activeTranslationMode === "outdated" ? "hourglass_top" : "sync"} />
                    <span>{activeTranslationMode === "outdated" ? "Updating..." : "Update All Outdated"}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={activeTranslationMode !== null}
                    onClick={() => {
                      void requestBulkTranslations("missing-and-outdated");
                    }}
                  >
                    <MaterialIcon name={activeTranslationMode === "missing-and-outdated" ? "hourglass_top" : "translate"} />
                    <span>
                      {activeTranslationMode === "missing-and-outdated" ? "Translating..." : "Translate All Missing/Outdated"}
                    </span>
                  </button>

                  {unrecordedTranslationCount > 0 || activeTranslationMode === "source-versions" ? (
                    <button
                      type="button"
                      className="btn btn-secondary translation-record-source-versions"
                      disabled={activeTranslationMode !== null}
                      onClick={() => {
                        void recordSourceVersions();
                      }}
                    >
                      <MaterialIcon name={activeTranslationMode === "source-versions" ? "hourglass_top" : "fact_check"} />
                      <span>{activeTranslationMode === "source-versions" ? "Recording..." : "Record Source Versions"}</span>
                    </button>
                  ) : null}
                </div>
                {unrecordedTranslationCount > 0 && activeTranslationMode !== "source-versions" ? (
                  <span className="field-hint">
                    {formatCount(unrecordedTranslationCount)} current translation{unrecordedTranslationCount === 1 ? " doesn't" : "s don't"} say
                    which version of {unrecordedTranslationCount === 1 ? "its" : "their"} page {unrecordedTranslationCount === 1 ? "it was" : "they were"} translated from yet.
                    Record it once and outdated checks become exact. Outdated translations get it the next time they&apos;re translated.
                  </span>
                ) : null}
                <div className="translation-language-list">
                  <div className="translation-language-item translation-language-label-row" aria-hidden="true">
                    <div className="field-inline translation-language-fields translation-language-label-fields">
                      <span className="field-label">Visible</span>
                      <span className="field-label">Display name</span>
                      <span className="field-label">ID</span>
                      <span className="field-label">Icon</span>
                    </div>
                    <div className="translation-language-label-actions" />
                  </div>
                  {settings.autoTranslateLanguages.map((language, index) => {
                    const isDefaultLanguage = isDefaultAutoTranslateLanguageCode(language.code);
                    const languageEnabled = isDefaultLanguage || language.enabled !== false;
                    const normalizedLanguageCode = normalizeAutoTranslateLanguageCode(language.code);
                    const languageIcon = isDefaultLanguage
                      ? getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE)
                      : normalizeCircleFlagIconId(language.icon) ||
                        getDefaultAutoTranslateLanguageIcon(normalizedLanguageCode || language.code);
                    const translationRequestDisabled =
                      isDefaultLanguage ||
                      activeTranslationMode !== null ||
                      (normalizedLanguageCode
                        ? requestedTranslationLanguageCodes.has(normalizedLanguageCode.toLowerCase())
                        : false);
                    const translationCacheStatus =
                      normalizedLanguageCode && translationStatusesLocalizationPath === normalizeLocalizationPath(settings.autoTranslateLocalizationPath)
                        ? translationCacheStatuses[translationCacheStatusKey(normalizedLanguageCode)]
                        : undefined;
                    const translationStatusProgress =
                      translationCacheStatus && isTranslationStatusPending(translationCacheStatus) ? getTranslationStatusProgressPercent(translationCacheStatus) : null;
                    const translationCacheStatusTone = getTranslationCacheStatusTone(translationCacheStatus);
                    const translationCacheStatusLabel = getTranslationCacheStatusLabel(translationCacheStatus);
                    const translationCacheStatusTooltip =
                      !translationCacheStatus && translationCacheStatusError
                        ? translationCacheStatusError
                        : !translationCacheStatus && translationCacheStatusLoading
                          ? "Checking localization status"
                        : getTranslationCacheStatusTooltip(translationCacheStatus);
                    const languageKey = `${language.code || "language"}-${index}`;

                    return (
                      <div
                        className={`translation-language-item${isDefaultLanguage ? " translation-language-item-fixed" : ""}`}
                        key={languageKey}
                      >
                        <div className="field-inline translation-language-fields">
                          <label
                            className={`toggle-row translation-language-visibility-toggle${
                              isDefaultLanguage ? " translation-language-visibility-toggle-disabled" : ""
                            } ui-tooltip`}
                            data-ui-tooltip={isDefaultLanguage ? "Source language is always visible" : languageEnabled ? "Visible to visitors" : "Hidden from visitors"}
                            htmlFor={`auto-translate-language-enabled-${index}`}
                          >
                            <input
                              id={`auto-translate-language-enabled-${index}`}
                              className="toggle-input"
                              type="checkbox"
                              checked={languageEnabled}
                              disabled={isDefaultLanguage}
                              aria-label={`${languageEnabled ? "Hide" : "Show"} ${isDefaultLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME : language.name || "language"} in the public language selector`}
                              onChange={(event) => {
                                const nextEnabled = event.target.checked;
                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, enabled: nextEnabled } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            />
                            <span className="toggle-control" aria-hidden="true">
                              <span className="toggle-thumb" />
                            </span>
                          </label>

                          <label
                            className="field-row translation-language-name-field"
                            htmlFor={`auto-translate-language-name-${index}`}
                          >
                            <input
                              id={`auto-translate-language-name-${index}`}
                              className="input"
                              aria-label="Display name"
                              value={isDefaultLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME : language.name}
                              disabled={isDefaultLanguage}
                              onChange={(event) => {
                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, name: event.target.value } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            />
                          </label>

                          <label
                            className="field-row translation-language-code-field"
                            htmlFor={`auto-translate-language-code-${index}`}
                          >
                            <input
                              id={`auto-translate-language-code-${index}`}
                              className="input"
                              aria-label="ID"
                              value={isDefaultLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE : language.code}
                              disabled={isDefaultLanguage}
                              onChange={(event) => {
                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, code: event.target.value } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                              onBlur={(event) => {
                                const normalizedCode = normalizeAutoTranslateLanguageCode(event.target.value);
                                if (!normalizedCode) {
                                  return;
                                }

                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, code: normalizedCode } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            />
                          </label>

                          <CircleFlagIconPicker
                            id={`auto-translate-language-icon-${index}`}
                            value={languageIcon}
                            disabled={isDefaultLanguage}
                            selectedDisplay="icon"
                            showLabel={false}
                            onChange={(icon) => {
                              const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                entryIndex === index ? { ...entry, icon } : entry,
                              );
                              setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                              setAutoTranslateFieldErrors((prev) => ({
                                ...prev,
                                languages: validateAutoTranslateLanguages(nextLanguages),
                              }));
                            }}
                          />
                        </div>

                        <div className="translation-language-actions">
                          <span
                            className={`translation-language-cache-status translation-language-cache-status-${translationCacheStatusTone}${
                              translationStatusProgress === null ? "" : " translation-language-cache-status-progress"
                            } ui-tooltip`}
                            data-ui-tooltip={translationCacheStatusTooltip}
                            aria-label={translationCacheStatusTooltip}
                            {...(translationStatusProgress === null
                              ? {}
                              : {
                                  role: "progressbar",
                                  "aria-valuemin": 0,
                                  "aria-valuemax": 100,
                                  "aria-valuenow": translationStatusProgress,
                                  style: { "--translation-status-progress": translationStatusProgress / 100 } as CSSProperties,
                                })}
                          >
                            {translationCacheStatusLabel}
                          </span>
                          <span
                            className="translation-language-action-tooltip ui-tooltip"
                            data-ui-tooltip="Request Translations for All Pages"
                          >
                            <button
                              type="button"
                              className="btn btn-icon translation-language-request"
                              aria-label="Request Translations for All Pages"
                              disabled={translationRequestDisabled}
                              onClick={() => {
                                void requestLanguageTranslations(language);
                              }}
                            >
                              <MaterialIcon name="download" />
                            </button>
                          </span>
                          <span
                            className="translation-language-action-tooltip ui-tooltip"
                            data-ui-tooltip="Remove"
                          >
                            <button
                              type="button"
                              className="btn btn-icon danger translation-language-remove"
                              aria-label="Remove"
                              disabled={isDefaultLanguage}
                              onClick={() => {
                                const nextLanguages = settings.autoTranslateLanguages.filter((_, entryIndex) => entryIndex !== index);
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            >
                              <MaterialIcon name={isDefaultLanguage ? "lock" : "delete"} />
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      const nextLanguages = [
                        ...settings.autoTranslateLanguages,
                        createCustomAutoTranslateLanguage(settings.autoTranslateLanguages),
                      ];
                      setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                      setAutoTranslateFieldErrors((prev) => ({
                        ...prev,
                        languages: validateAutoTranslateLanguages(nextLanguages),
                      }));
                    }}
                  >
                    <MaterialIcon name="add" />
                    <span>Add language</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={
                      JSON.stringify(settings.autoTranslateLanguages) ===
                      JSON.stringify(DEFAULT_AUTO_TRANSLATE_LANGUAGES)
                    }
                    onClick={() => {
                      const nextLanguages = DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language }));
                      setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                      setAutoTranslateFieldErrors((prev) => ({
                        ...prev,
                        languages: validateAutoTranslateLanguages(nextLanguages),
                      }));
                    }}
                  >
                    Reset languages
                  </button>
                </div>

                <div className="translation-log-panel">
                  <div className="translation-log-header">
                    <span className="field-label">Translation log</span>
                    <span
                      className={`translation-language-cache-status translation-language-cache-status-${getTranslationJobStatusTone(
                        translationJob,
                      )}`}
                    >
                      {getTranslationJobStatusLabel(translationJob)}
                    </span>
                  </div>

                  {translationJob?.mode === "source-versions" ? (
                    <div className="translation-log-summary">
                      <span>
                        {translationJob.result.uploadedPages}/{translationJob.result.requestedPages} recorded
                      </span>
                      <span>{translationJob.result.failedPages} failed</span>
                    </div>
                  ) : translationJob ? (
                    <div className="translation-log-summary">
                      <span>
                        {translationJob.result.translatedPages}/{translationJob.result.requestedPages} translated
                      </span>
                      <span>{translationJob.result.uploadedPages} uploaded</span>
                      <span>{translationJob.result.cachedPages} current</span>
                      <span>{translationJob.result.failedPages} failed</span>
                    </div>
                  ) : null}

                  <div className="translation-log-scroll" ref={translationLogRef} aria-live="polite">
                    {translationRequestStatus ? (
                      <div className={`translation-log-entry translation-log-entry-${translationRequestStatus.tone}`}>
                        <MaterialIcon name={translationRequestStatus.tone === "error" ? "error" : "warning"} />
                        <div className="translation-log-entry-body">
                          <span className="translation-log-entry-message">{translationRequestStatus.message}</span>
                        </div>
                      </div>
                    ) : null}
                    {translationLogEntries.length > 0 ? (
                      translationLogEntries.map((entry) => (
                        <div className={`translation-log-entry translation-log-entry-${entry.level}`} key={entry.id}>
                          <MaterialIcon name={getTranslationLogIcon(entry.level)} />
                          <div className="translation-log-entry-body">
                            <span className="translation-log-entry-time">{formatStatusTimestamp(entry.createdAt)}</span>
                            <span className="translation-log-entry-message">{entry.message}</span>
                            {entry.details ? <span className="translation-log-entry-details">{entry.details}</span> : null}
                          </div>
                        </div>
                      ))
                    ) : !translationRequestStatus ? (
                      <p className="muted-text translation-log-empty">No translation activity yet.</p>
                    ) : null}
                  </div>
                </div>

                <span className="field-hint">
                  {DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME} is the source language. Other languages map to GitHub folders by language ID.
                </span>
                {autoTranslateFieldErrors.languages ? (
                  <span className="error-text">{autoTranslateFieldErrors.languages}</span>
                ) : null}
              </div>
            </div>
          </section>

        </div>
      </div>
    </section>
  );
}
