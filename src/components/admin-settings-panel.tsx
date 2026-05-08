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
  clearAdminGitHubToken,
  clearAdminOpenRouterApiKey,
  createAdminModerator,
  deleteAdminModerator,
  fetchAdminDomainSslStatus,
  fetchAdminModerators,
  fetchAdminSettings,
  fetchAdminVisitorStats,
  formatApiError,
  getCurrentUser,
  refreshAdminDocsCache,
  requestAdminLanguageTranslations,
  saveAdminSettings,
  testAdminConnection,
  updateAdminModerator,
} from "@/components/api";
import { CircleFlagIconPicker } from "@/components/circle-flag-icon-picker";
import { ColorPickerField } from "@/components/color-picker-field";
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
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import type {
  AdminSettings,
  AutoTranslateLanguage,
  DomainSslRuntimeStatus,
  ModeratorAccount,
  ThemeCustomization,
  VisitorStatsPeriod,
  VisitorStatsScope,
  VisitorStatsSummary,
} from "@/components/types";
import { isCircleFlagIconId, normalizeCircleFlagIconId } from "@/lib/circle-flags";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
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
  autoTranslateLanguages: DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language })),
  themeLightAccent: THEME_DEFAULTS.lightAccent,
  themeLightSurfaceAccent: THEME_DEFAULTS.lightSurfaceAccent,
  themeDarkAccent: THEME_DEFAULTS.darkAccent,
  themeDarkSurfaceAccent: THEME_DEFAULTS.darkSurfaceAccent,
  themeCustomCss: THEME_DEFAULTS.customCss,
};

type DomainFieldErrors = {
  customDomain: string | null;
  letsEncryptEmail: string | null;
};

const EMPTY_DOMAIN_FIELD_ERRORS: DomainFieldErrors = {
  customDomain: null,
  letsEncryptEmail: null,
};

type AiChatFieldErrors = {
  systemPrompt: string | null;
  openRouterModel: string | null;
};

const EMPTY_AI_CHAT_FIELD_ERRORS: AiChatFieldErrors = {
  systemPrompt: null,
  openRouterModel: null,
};

type OpenRouterFieldErrors = {
  apiKey: string | null;
};

const EMPTY_OPENROUTER_FIELD_ERRORS: OpenRouterFieldErrors = {
  apiKey: null,
};

type AutoTranslateFieldErrors = {
  openRouterModel: string | null;
  languages: string | null;
};

const EMPTY_AUTO_TRANSLATE_FIELD_ERRORS: AutoTranslateFieldErrors = {
  openRouterModel: null,
  languages: null,
};

const validateCustomDomainInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return normalizeCustomDomain(trimmed)
    ? null
    : "Enter a valid hostname only (example: docs.example.com, without protocol or path).";
};

const validateLetsEncryptEmailInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return normalizeLetsEncryptEmail(trimmed) ? null : "Enter a valid email address for Let's Encrypt notifications.";
};

const validateDomainFields = (domain: string, email: string): DomainFieldErrors => ({
  customDomain: validateCustomDomainInput(domain),
  letsEncryptEmail: validateLetsEncryptEmailInput(email),
});

const hasDomainFieldErrors = (errors: DomainFieldErrors): boolean => Boolean(errors.customDomain || errors.letsEncryptEmail);

const validateAiChatFields = (settings: AdminSettings): AiChatFieldErrors => {
  if (!settings.aiChatEnabled) {
    return EMPTY_AI_CHAT_FIELD_ERRORS;
  }

  return {
    systemPrompt: settings.aiChatSystemPrompt.includes(AI_CHAT_DOCS_PLACEHOLDER)
      ? null
      : `Include ${AI_CHAT_DOCS_PLACEHOLDER} in the system prompt so the /docs.txt export can be injected.`,
    openRouterModel: settings.openRouterModel.trim() ? null : "Enter an OpenRouter model identifier.",
  };
};

const hasAiChatFieldErrors = (errors: AiChatFieldErrors): boolean => Boolean(errors.systemPrompt || errors.openRouterModel);

const validateOpenRouterFields = (settings: AdminSettings): OpenRouterFieldErrors => ({
  apiKey:
    settings.aiChatEnabled || settings.autoTranslateEnabled
      ? settings.openRouterApiKey.trim() || settings.openRouterApiKeyConfigured
        ? null
        : "Enter an OpenRouter API key before enabling AI features."
      : null,
});

const hasOpenRouterFieldErrors = (errors: OpenRouterFieldErrors): boolean => Boolean(errors.apiKey);

const validateAutoTranslateLanguages = (languages: AutoTranslateLanguage[]): string | null => {
  const seenCodes = new Set<string>();
  let hasDefaultLanguage = false;

  for (const language of languages) {
    const name = language.name.trim();
    const code = normalizeAutoTranslateLanguageCode(language.code);

    if (!name || !code) {
      return "Each language needs a display name and a language code.";
    }

    if (!isCircleFlagIconId(language.icon)) {
      return "Each language needs a Circle Flags icon.";
    }

    const codeKey = code.toLowerCase();
    if (seenCodes.has(codeKey)) {
      return "Language codes must be unique.";
    }

    seenCodes.add(codeKey);
    if (isDefaultAutoTranslateLanguageCode(code)) {
      hasDefaultLanguage = true;
    }
  }

  return hasDefaultLanguage ? null : `${DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME} must stay in the language list.`;
};

const validateAutoTranslateFields = (settings: AdminSettings): AutoTranslateFieldErrors => {
  if (!settings.autoTranslateEnabled) {
    return {
      openRouterModel: null,
      languages: validateAutoTranslateLanguages(settings.autoTranslateLanguages),
    };
  }

  return {
    openRouterModel: settings.autoTranslateOpenRouterModel.trim() ? null : "Enter an OpenRouter model identifier.",
    languages: validateAutoTranslateLanguages(settings.autoTranslateLanguages),
  };
};

const hasAutoTranslateFieldErrors = (errors: AutoTranslateFieldErrors): boolean =>
  Boolean(errors.openRouterModel || errors.languages);

const normalizeAutoTranslateLanguagesForSave = (languages: AutoTranslateLanguage[]): AutoTranslateLanguage[] => {
  const defaultLanguage = languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code));
  const output: AutoTranslateLanguage[] = [
    {
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
      icon:
        normalizeCircleFlagIconId(defaultLanguage?.icon) ||
        getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE),
    },
  ];
  const seenCodes = new Set([DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE.toLowerCase()]);

  for (const language of languages) {
    const code = normalizeAutoTranslateLanguageCode(language.code);
    const name = language.name.trim().replace(/\s+/g, " ");
    const icon = normalizeCircleFlagIconId(language.icon) || getDefaultAutoTranslateLanguageIcon(code);

    if (!code || !name || isDefaultAutoTranslateLanguageCode(code)) {
      continue;
    }

    const codeKey = code.toLowerCase();
    if (seenCodes.has(codeKey)) {
      continue;
    }

    seenCodes.add(codeKey);
    output.push({ name, code, icon });
  }

  return output;
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
  };
};

const normalizeDomainFieldsForSave = (settings: AdminSettings): AdminSettings => ({
  ...settings,
  customDomain: normalizeCustomDomain(settings.customDomain),
  letsEncryptEmail: normalizeLetsEncryptEmail(settings.letsEncryptEmail),
  autoTranslateLanguages: normalizeAutoTranslateLanguagesForSave(settings.autoTranslateLanguages),
});

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

type ResetToDefaultButtonProps = {
  disabled: boolean;
  onClick: () => void;
};

function ResetToDefaultButton({ disabled, onClick }: ResetToDefaultButtonProps) {
  return (
    <button type="button" className="btn field-control-action" disabled={disabled} onClick={onClick}>
      Reset To Default
    </button>
  );
}

type VisitorStatsLoadResult =
  | { error: null; stats: VisitorStatsSummary }
  | { error: string; stats: null };

const loadVisitorStatsResult = async (): Promise<VisitorStatsLoadResult> => {
  try {
    return {
      stats: await fetchAdminVisitorStats(),
      error: null,
    };
  } catch (error) {
    return {
      stats: null,
      error: formatApiError(error),
    };
  }
};

const visitorNumberFormatter = new Intl.NumberFormat();

const formatVisitorCount = (value: number): string => visitorNumberFormatter.format(value);

const formatVisitorLabel = (value: number): string => `${formatVisitorCount(value)} visitor${value === 1 ? "" : "s"}`;

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

const formatSparklineCoordinate = (value: number): string => value.toFixed(2).replace(/\.?0+$/, "");

const clampNumber = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

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

  const move = `M ${formatSparklineCoordinate(firstPoint.x)} ${formatSparklineCoordinate(firstPoint.y)}`;
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index];
    const controlX = previous.x + (point.x - previous.x) / 2;

    return [
      "C",
      formatSparklineCoordinate(controlX),
      formatSparklineCoordinate(previous.y),
      formatSparklineCoordinate(controlX),
      formatSparklineCoordinate(point.y),
      formatSparklineCoordinate(point.x),
      formatSparklineCoordinate(point.y),
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
      ? `${linePath} L ${formatSparklineCoordinate(lastPoint.x)} ${formatSparklineCoordinate(
          baselineY,
        )} L ${formatSparklineCoordinate(firstPoint.x)} ${formatSparklineCoordinate(baselineY)} Z`
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
        <strong>{formatVisitorCount(value)}</strong>
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
          aria-label={`${label}: ${formatVisitorCount(value)}. Trend range: ${rangeLabel}.`}
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
              <dd>{formatVisitorCount(activePoint.period.visitors)}</dd>
            </div>
            <div>
              <dt>Visits</dt>
              <dd>{formatVisitorCount(activePoint.period.visits)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

type VisitorStatsCardProps = {
  activeScope: VisitorStatsScope;
  error: string | null;
  loading: boolean;
  stats: VisitorStatsSummary | null;
  onRefresh: () => void;
  onScopeChange: (scope: VisitorStatsScope) => void;
};

function VisitorStatsCard({
  activeScope,
  error,
  loading,
  stats,
  onRefresh,
  onScopeChange,
}: VisitorStatsCardProps) {
  const scopeStats = stats?.scopes[activeScope] ?? null;
  const maxPageVisits = Math.max(1, ...(scopeStats?.pages.map((page) => page.visits) ?? [0]));
  const trendPeriods = scopeStats?.periods ?? [];

  return (
    <section className="panel-card panel-card-visitors">
      <div className="panel-header">
        <div>
          <h2>Analytics</h2>
          <p className="panel-description">Visits and unique visitors over time.</p>
        </div>
        <span className="visitor-refresh-tooltip ui-tooltip" data-ui-tooltip={loading ? "Refreshing analytics" : "Refresh analytics"}>
          <button
            type="button"
            className="btn btn-icon visitor-refresh-button"
            disabled={loading}
            aria-label={loading ? "Refreshing analytics" : "Refresh analytics"}
            onClick={onRefresh}
          >
            <MaterialIcon name={loading ? "hourglass_top" : "refresh"} />
          </button>
        </span>
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

      {error ? <p className="error-text">{error}</p> : null}

      <div className="visitor-stats-scroll">
        {!stats || !scopeStats ? (
          <p className="muted-caption">{loading ? "Loading analytics..." : "No analytics recorded yet."}</p>
        ) : (
          <>
            <div className="visitor-chart-wrap">
              <div className="visitor-section-heading">
                <h3>{VISITOR_STATS_TREND_LABELS[activeScope]}</h3>
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
                <span>{formatVisitorCount(scopeStats.pages.length)}</span>
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
                          {formatVisitorCount(page.visits)}
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

type ClearSecretTarget = "githubToken" | "openRouterApiKey";
type TranslationRequestStatus = {
  tone: "success" | "warning" | "error";
  message: string;
};

const formatStatusTimestamp = (value: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  return parsed.toLocaleString();
};

export function AdminSettingsPanel() {
  const router = useRouter();
  const { setThemeSettings } = useTheme();

  const [settings, setSettings] = useState<AdminSettings>(INITIAL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [settingsSaving, setSettingsSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<ClearSecretTarget | null>(null);
  const [domainFieldErrors, setDomainFieldErrors] = useState<DomainFieldErrors>(EMPTY_DOMAIN_FIELD_ERRORS);
  const [aiChatFieldErrors, setAiChatFieldErrors] = useState<AiChatFieldErrors>(EMPTY_AI_CHAT_FIELD_ERRORS);
  const [openRouterFieldErrors, setOpenRouterFieldErrors] = useState<OpenRouterFieldErrors>(EMPTY_OPENROUTER_FIELD_ERRORS);
  const [autoTranslateFieldErrors, setAutoTranslateFieldErrors] =
    useState<AutoTranslateFieldErrors>(EMPTY_AUTO_TRANSLATE_FIELD_ERRORS);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [refreshingDocs, setRefreshingDocs] = useState(false);
  const [docsRefreshMessage, setDocsRefreshMessage] = useState<string | null>(null);
  const [docsRefreshError, setDocsRefreshError] = useState<string | null>(null);
  const [requestedTranslationLanguageCodes, setRequestedTranslationLanguageCodes] = useState<Set<string>>(
    () => new Set(),
  );
  const [translationRequestStatus, setTranslationRequestStatus] = useState<TranslationRequestStatus | null>(null);

  const [sslStatus, setSslStatus] = useState<DomainSslRuntimeStatus | null>(null);
  const [sslStatusLoading, setSslStatusLoading] = useState(true);
  const [sslStatusError, setSslStatusError] = useState<string | null>(null);

  const [visitorStats, setVisitorStats] = useState<VisitorStatsSummary | null>(null);
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

  const refreshSslStatus = useCallback(async () => {
    setSslStatusLoading(true);
    setSslStatusError(null);

    try {
      const status = await fetchAdminDomainSslStatus();
      setSslStatus(status);
    } catch (error) {
      setSslStatus(null);
      setSslStatusError(formatApiError(error));
    } finally {
      setSslStatusLoading(false);
    }
  }, []);

  const refreshVisitorStats = useCallback(async () => {
    setVisitorStatsLoading(true);
    setVisitorStatsError(null);

    const result = await loadVisitorStatsResult();
    setVisitorStats(result.stats);
    setVisitorStatsError(result.error);
    setVisitorStatsLoading(false);
  }, []);

  const resetModeratorEditor = useCallback(() => {
    setEditingModeratorId(null);
    setEditingModeratorUsername("");
    setEditingModeratorPassword("");
    setShowEditingModeratorPassword(false);
  }, []);

  const handleCreateModerator = useCallback(async () => {
    setModeratorSaving(true);
    setModeratorError(null);

    try {
      const created = await createAdminModerator({
        username: moderatorUsername,
        password: moderatorPassword,
      });
      setModerators((prev) => [...prev, created].sort((left, right) => left.username.localeCompare(right.username)));
      setModeratorUsername("");
      setModeratorPassword("");
      setShowModeratorPassword(false);
    } catch (error) {
      setModeratorError(formatApiError(error));
    } finally {
      setModeratorSaving(false);
    }
  }, [moderatorPassword, moderatorUsername]);

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

      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        const updated = await updateAdminModerator(account.id, payload);
        setModerators((prev) =>
          prev
            .map((moderator) => (moderator.id === account.id ? updated : moderator))
            .sort((left, right) => left.username.localeCompare(right.username)),
        );
        resetModeratorEditor();
      } catch (error) {
        setModeratorError(formatApiError(error));
      } finally {
        setModeratorActionId(null);
      }
    },
    [editingModeratorPassword, editingModeratorUsername, resetModeratorEditor],
  );

  const handleDeleteModerator = useCallback(
    async (account: ModeratorAccount) => {
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        await deleteAdminModerator(account.id);
        setModerators((prev) => prev.filter((moderator) => moderator.id !== account.id));
        if (editingModeratorId === account.id) {
          resetModeratorEditor();
        }
      } catch (error) {
        setModeratorError(formatApiError(error));
      } finally {
        setModeratorActionId(null);
      }
    },
    [editingModeratorId, resetModeratorEditor],
  );

  const createSaveSnapshot = useCallback(
    (draft: AdminSettings): string =>
      JSON.stringify({
        settings: draft,
      }),
    [],
  );

  const getLatestSaveSnapshot = useCallback((): string => createSaveSnapshot(latestSettingsRef.current), [createSaveSnapshot]);

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

    const domainErrors = validateDomainFields(draft.customDomain, draft.letsEncryptEmail);
    const aiErrors = validateAiChatFields(draft);
    const openRouterErrors = validateOpenRouterFields(draft);
    const autoTranslateErrors = validateAutoTranslateFields(draft);
    setDomainFieldErrors(domainErrors);
    setAiChatFieldErrors(aiErrors);
    setOpenRouterFieldErrors(openRouterErrors);
    setAutoTranslateFieldErrors(autoTranslateErrors);

    if (
      hasDomainFieldErrors(domainErrors) ||
      hasAiChatFieldErrors(aiErrors) ||
      hasOpenRouterFieldErrors(openRouterErrors) ||
      hasAutoTranslateFieldErrors(autoTranslateErrors)
    ) {
      setSaveError(null);
      return;
    }

    autoSaveInFlightRef.current = true;
    setSettingsSaving(true);
    setSaveError(null);

    try {
      const shouldRefreshSslStatus =
        draft.customDomain !== lastSavedDomainRef.current.customDomain ||
        draft.letsEncryptEmail !== lastSavedDomainRef.current.letsEncryptEmail;
      const saved = await saveAdminSettings(normalizeDomainFieldsForSave(draft));
      const nextSettings: AdminSettings = {
        ...saved,
          githubToken: draft.githubToken,
          openRouterApiKey: draft.openRouterApiKey,
        };
      const hasNewerLocalChanges = getLatestSaveSnapshot() !== snapshot;

      lastSavedSnapshotRef.current = createSaveSnapshot(nextSettings);
      lastSavedDomainRef.current = {
        customDomain: nextSettings.customDomain,
        letsEncryptEmail: nextSettings.letsEncryptEmail,
      };

      if (!hasNewerLocalChanges) {
        latestSettingsRef.current = nextSettings;
        setSettings(nextSettings);
        setThemeSettings(themeCustomizationFromSettings(saved));
        setDomainFieldErrors(validateDomainFields(saved.customDomain, saved.letsEncryptEmail));
        setAiChatFieldErrors(validateAiChatFields(saved));
        setOpenRouterFieldErrors(validateOpenRouterFields(saved));
        setAutoTranslateFieldErrors(validateAutoTranslateFields(saved));
      }

      if (shouldRefreshSslStatus) {
        await refreshSslStatus();
      }
    } catch (error) {
      setSaveError(formatApiError(error));
    } finally {
      autoSaveInFlightRef.current = false;
      setSettingsSaving(false);

      if (autoSaveQueuedRef.current) {
        autoSaveQueuedRef.current = false;
        void persistLatestSettings();
      }
    }
  }, [createSaveSnapshot, getLatestSaveSnapshot, refreshSslStatus, setThemeSettings]);

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

      const snapshot = getLatestSaveSnapshot();
      autoSaveInFlightRef.current = true;
      setSettingsSaving(true);
      setClearingSecret(target);
      setSaveError(null);

      try {
        const saved =
          target === "githubToken" ? await clearAdminGitHubToken() : await clearAdminOpenRouterApiKey();
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
          setDomainFieldErrors(validateDomainFields(nextSettings.customDomain, nextSettings.letsEncryptEmail));
          setAiChatFieldErrors(validateAiChatFields(nextSettings));
          setOpenRouterFieldErrors(validateOpenRouterFields(nextSettings));
          setAutoTranslateFieldErrors(validateAutoTranslateFields(nextSettings));
        }
      } catch (error) {
        setSaveError(formatApiError(error));
      } finally {
        autoSaveInFlightRef.current = false;
        setSettingsSaving(false);
        setClearingSecret(null);

        if (autoSaveQueuedRef.current) {
          autoSaveQueuedRef.current = false;
          void persistLatestSettings();
        }
      }
    },
    [createSaveSnapshot, getLatestSaveSnapshot, persistLatestSettings, setThemeSettings],
  );

  const refreshDocsCache = useCallback(async () => {
    setRefreshingDocs(true);
    setDocsRefreshMessage(null);
    setDocsRefreshError(null);

    try {
      await persistLatestSettings();
      const result = await refreshAdminDocsCache();
      setDocsRefreshMessage(
        `Fetched ${formatVisitorCount(result.pageCount)} page${result.pageCount === 1 ? "" : "s"}. Cache expires ${formatStatusTimestamp(result.expiresAt)}.`,
      );
    } catch (error) {
      setDocsRefreshError(formatApiError(error));
    } finally {
      setRefreshingDocs(false);
    }
  }, [persistLatestSettings]);

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
        `Request translations for all pages in ${name}? Only pages without a current cached translation will be sent.`,
      );

      if (!confirmed) {
        return;
      }

      setRequestedTranslationLanguageCodes((prev) => {
        const next = new Set(prev);
        next.add(code.toLowerCase());
        return next;
      });
      setTranslationRequestStatus({
        tone: "warning",
        message: `Requesting ${name} translations...`,
      });

      try {
        await persistLatestSettings();
        const icon = normalizeCircleFlagIconId(language.icon) || getDefaultAutoTranslateLanguageIcon(code);
        const result = await requestAdminLanguageTranslations({ name, code, icon });
        const pageLabel = result.totalPages === 1 ? "page" : "pages";

        if (result.failedPages > 0) {
          setTranslationRequestStatus({
            tone: "warning",
            message: `${result.translatedPages} ${name} translation${
              result.translatedPages === 1 ? "" : "s"
            } finished, ${result.cachedPages} ${pageLabel} already had current translations, and ${
              result.failedPages
            } failed.`,
          });
          return;
        }

        if (result.requestedPages === 0) {
          setTranslationRequestStatus({
            tone: "success",
            message: `All ${result.totalPages} ${pageLabel} already have current ${name} translations.`,
          });
          return;
        }

        setTranslationRequestStatus({
          tone: "success",
          message: `Finished ${result.translatedPages} ${name} translation${
            result.translatedPages === 1 ? "" : "s"
          }. ${result.cachedPages} ${pageLabel} already had current translations.`,
        });
      } catch (error) {
        setTranslationRequestStatus({
          tone: "error",
          message: formatApiError(error),
        });
      }
    },
    [persistLatestSettings],
  );

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!autoSaveReadyRef.current) {
      return;
    }

    void persistLatestSettings();
  }, [persistLatestSettings, settings]);

  useEffect(() => {
    let isActive = true;

    const run = async () => {
      setLoading(true);
      setLoadError(null);
      setVisitorStatsLoading(true);
      setVisitorStatsError(null);

      try {
        const currentUser = await getCurrentUser();
        if (!currentUser) {
          router.replace("/admin/login");
          return;
        }

        if (currentUser.role !== "admin") {
          router.replace("/editor");
          return;
        }

        const [loadedSettings, loadedModerators, loadedVisitorStats] = await Promise.all([
          fetchAdminSettings(),
          fetchAdminModerators(),
          loadVisitorStatsResult(),
        ]);
        if (!isActive) {
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
        setVisitorStats(loadedVisitorStats.stats);
        setVisitorStatsError(loadedVisitorStats.error);
        setVisitorStatsLoading(false);
        setThemeSettings(themeCustomizationFromSettings(loadedSettings));
        setDomainFieldErrors(validateDomainFields(loadedSettings.customDomain, loadedSettings.letsEncryptEmail));
        setAiChatFieldErrors(validateAiChatFields(loadedSettings));
        setOpenRouterFieldErrors(validateOpenRouterFields(loadedSettings));
        setAutoTranslateFieldErrors(validateAutoTranslateFields(loadedSettings));
        autoSaveReadyRef.current = true;
        await refreshSslStatus();
      } catch (error) {
        if (isActive) {
          setLoadError(formatApiError(error));
          setVisitorStatsLoading(false);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      isActive = false;
      autoSaveReadyRef.current = false;
    };
  }, [createSaveSnapshot, refreshSslStatus, router, setThemeSettings]);

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
          <section className="panel-card panel-card-repo">
          <div className="panel-header">
            <h1>Repository Settings</h1>
          </div>

          <p className="panel-description">
            Configure repository connectivity, write credentials, and docs refresh behavior.
          </p>

          <div className="form-grid">
            <label className="field-row" htmlFor="docs-refresh-interval-minutes">
              <span className="field-label">Docs refresh interval (minutes)</span>
              <input
                id="docs-refresh-interval-minutes"
                className="input"
                type="number"
                min={1}
                max={1440}
                step={1}
                value={settings.docsRefreshIntervalMinutes}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  const normalized = Number.isFinite(parsed) ? Math.min(1440, Math.max(1, parsed)) : 1;
                  setSettings((prev) => ({ ...prev, docsRefreshIntervalMinutes: normalized }));
                }}
                required
              />
              <span className="field-hint">
                Allowed range: 1-1440. Vicky fetches the full docs set once per interval.
              </span>
            </label>

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
                  setTestingConnection(true);
                  setConnectionMessage(null);
                  setConnectionError(null);

                  try {
                    const message = await testAdminConnection(settings);
                    setConnectionMessage(message);
                  } catch (error) {
                    setConnectionError(formatApiError(error));
                  } finally {
                    setTestingConnection(false);
                  }
                }}
              >
                <MaterialIcon name={testingConnection ? "hourglass_top" : "network_check"} />
                <span>{testingConnection ? "Testing..." : "Test connection"}</span>
              </button>
            </div>
          </div>

          {connectionMessage ? <p className="success-text">{connectionMessage}</p> : null}
          {connectionError ? <p className="error-text">{connectionError}</p> : null}
          {docsRefreshMessage ? <p className="success-text">{docsRefreshMessage}</p> : null}
          {docsRefreshError ? <p className="error-text">{docsRefreshError}</p> : null}
          </section>

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

              <div className="form-separator" role="separator" aria-hidden="true" />

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
          </section>

          <section className="panel-card panel-card-domain">
            <div className="panel-header">
              <h2>Domain Settings</h2>
            </div>

            <p className="panel-description">
              Configure your custom domain and Let&apos;s Encrypt contact email for automatic HTTPS certificate management.
            </p>

            <div className="form-grid">
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

              <div className="field-row">
                <span className="field-label">SSL runtime status</span>
                {sslStatusLoading ? <span className="field-hint">Checking certificate runtime status...</span> : null}
                {!sslStatusLoading && sslStatus ? (
                  <>
                    <p className={statusToneClassName(sslStatus)}>{sslStatus.message}</p>
                    <span className="field-hint">
                      Source:{" "}
                      {sslStatus.source === "runtime" ? "runtime status endpoint" : "best-effort check (settings + local cert files)"}.
                    </span>
                    {sslStatus.certificateExpiresAt ? (
                      <span className="field-hint">
                        Certificate expiry: {formatStatusTimestamp(sslStatus.certificateExpiresAt)}.
                      </span>
                    ) : null}
                    <span className="field-hint">Last checked: {formatStatusTimestamp(sslStatus.checkedAt)}.</span>
                  </>
                ) : null}
                {sslStatusError ? <p className="warning-text">Could not load SSL runtime status: {sslStatusError}</p> : null}
              </div>

              <p className="warning-text">
                Automatic SSL runs only when both values are set and DNS points this domain to your server.
              </p>

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
              <div className="field-row">
                <span className="field-label">Enable AI chat</span>
                <label className="toggle-row" htmlFor="ai-chat-enabled">
                  <input
                    id="ai-chat-enabled"
                    className="toggle-input"
                    type="checkbox"
                    checked={settings.aiChatEnabled}
                    onChange={(event) => setSettings((prev) => ({ ...prev, aiChatEnabled: event.target.checked }))}
                  />
                  <span className="toggle-control" aria-hidden="true">
                    <span className="toggle-thumb" />
                  </span>
                  <span>{settings.aiChatEnabled ? "Enabled" : "Disabled"}</span>
                </label>
                <span className="field-hint">
                  Shows the floating Ask Docs button on docs pages and enables the public chat API route.
                </span>
              </div>

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
                  Shown in the chat header, welcome message, and reply labels. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code>{" "}
                  in the system prompt to reference this value dynamically.
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
                  Shown below the assistant name in the chat header. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> if you
                  want the configured assistant name inserted automatically.
                </span>
              </div>

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
                  Shown as the first assistant message in new chats. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> if you
                  want the configured assistant name inserted automatically.
                </span>
              </div>

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
                        openRouterModel: value.trim() || !settings.aiChatEnabled ? null : "Enter an OpenRouter model identifier.",
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
                        systemPrompt:
                          !settings.aiChatEnabled || value.includes(AI_CHAT_DOCS_PLACEHOLDER)
                            ? null
                            : `Include ${AI_CHAT_DOCS_PLACEHOLDER} in the system prompt so the /docs.txt export can be injected.`,
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
          </section>
        </div>

        <div className="panel-stack-right">
          <VisitorStatsCard
            activeScope={visitorStatsScope}
            error={visitorStatsError}
            loading={visitorStatsLoading}
            stats={visitorStats}
            onRefresh={() => {
              void refreshVisitorStats();
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
          </section>

          <section className="panel-card panel-card-openrouter">
            <div className="panel-header">
              <h2>OpenRouter Settings</h2>
            </div>

            <p className="panel-description">
              Shared OpenRouter credentials for AI-powered docs features.
            </p>

            <div className="form-grid">
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
                        apiKey:
                          settings.aiChatEnabled || settings.autoTranslateEnabled
                            ? value.trim() || settings.openRouterApiKeyConfigured
                              ? null
                              : "Enter an OpenRouter API key before enabling AI features."
                            : null,
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
          </section>

          <section className="panel-card panel-card-auto-translate">
            <div className="panel-header">
              <h2>Auto Translate</h2>
            </div>

            <p className="panel-description">
              Translate docs pages for the languages visitors can select.
            </p>

            <div className="form-grid">
              <div className="field-row">
                <span className="field-label">Enable auto-translate</span>
                <label className="toggle-row" htmlFor="auto-translate-enabled">
                  <input
                    id="auto-translate-enabled"
                    className="toggle-input"
                    type="checkbox"
                    checked={settings.autoTranslateEnabled}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setSettings((prev) => ({ ...prev, autoTranslateEnabled: enabled }));
                      setOpenRouterFieldErrors((prev) => ({
                        ...prev,
                        apiKey:
                          enabled || settings.aiChatEnabled
                            ? settings.openRouterApiKey.trim() || settings.openRouterApiKeyConfigured
                              ? null
                              : "Enter an OpenRouter API key before enabling AI features."
                            : null,
                      }));
                    }}
                  />
                  <span className="toggle-control" aria-hidden="true">
                    <span className="toggle-thumb" />
                  </span>
                  <span>{settings.autoTranslateEnabled ? "Enabled" : "Disabled"}</span>
                </label>
                <span className="field-hint">
                  Shows the language selector in the docs header and translates selected non-English pages.
                </span>
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
                        openRouterModel: value.trim() || !settings.autoTranslateEnabled ? null : "Enter an OpenRouter model identifier.",
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
                <span className="field-label">Selectable languages</span>
                <div className="translation-language-list">
                  <div className="translation-language-item translation-language-label-row" aria-hidden="true">
                    <div className="field-inline translation-language-fields translation-language-label-fields">
                      <span className="field-label">Display name</span>
                      <span className="field-label">ID</span>
                      <span className="field-label">Icon</span>
                    </div>
                    <div className="translation-language-label-actions" />
                  </div>
                  {settings.autoTranslateLanguages.map((language, index) => {
                    const isDefaultLanguage = isDefaultAutoTranslateLanguageCode(language.code);
                    const normalizedLanguageCode = normalizeAutoTranslateLanguageCode(language.code);
                    const languageIcon =
                      normalizeCircleFlagIconId(language.icon) ||
                      getDefaultAutoTranslateLanguageIcon(normalizedLanguageCode || language.code);
                    const translationRequestDisabled =
                      isDefaultLanguage ||
                      (normalizedLanguageCode
                        ? requestedTranslationLanguageCodes.has(normalizedLanguageCode.toLowerCase())
                        : false);
                    const languageKey = `${language.code || "language"}-${index}`;

                    return (
                      <div
                        className={`translation-language-item${isDefaultLanguage ? " translation-language-item-fixed" : ""}`}
                        key={languageKey}
                      >
                        <div className="field-inline translation-language-fields">
                          <label className="field-row" htmlFor={`auto-translate-language-name-${index}`}>
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

                          <label className="field-row" htmlFor={`auto-translate-language-code-${index}`}>
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
                        </div>
                      </div>
                    );
                  })}
                </div>
                {translationRequestStatus ? (
                  <p className={`${translationRequestStatus.tone}-text`}>{translationRequestStatus.message}</p>
                ) : null}

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

                <span className="field-hint">
                  {DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME} is always the default source language and is never sent to the translation model.
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
