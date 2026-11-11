"use client";

import type { CSSProperties } from "react";

import { formatCount } from "@/components/admin-settings/format";
import { getTranslationStatusProgressPercent, isTranslationStatusPending } from "@/components/admin-settings/localization-status";
import { CircleFlagIconPicker } from "@/components/circle-flag-icon-picker";
import { MaterialIcon } from "@/components/material-icon";
import type { AdminLanguageTranslationCacheStatus, AutoTranslateLanguage } from "@/components/types";
import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { normalizeCircleFlagIconId } from "@/lib/circle-flags";

type TranslationCacheStatusTone = "loading" | "empty" | "partial" | "complete";

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

type LanguageRowProps = {
  index: number;
  language: AutoTranslateLanguage;
  /** The language's code as the server keys it. */
  normalizedCode: string;
  /** Its status for the localization directory shown, if one is known. */
  cacheStatus: AdminLanguageTranslationCacheStatus | undefined;
  overviewError: string | null;
  overviewLoading: boolean;
  /** A job runs or a request for this language is on its way. */
  requestBusy: boolean;
  onChange: (index: number, change: Partial<AutoTranslateLanguage>) => void;
  onRemove: (index: number) => void;
  onRequestTranslations: (language: AutoTranslateLanguage) => void;
};

/** One selectable language: visibility, name, ID, icon, its localization status, and its actions. */
export function LanguageRow({
  index,
  language,
  normalizedCode,
  cacheStatus,
  overviewError,
  overviewLoading,
  requestBusy,
  onChange,
  onRemove,
  onRequestTranslations,
}: LanguageRowProps) {
  const isDefaultLanguage = isDefaultAutoTranslateLanguageCode(language.code);
  const languageEnabled = isDefaultLanguage || language.enabled !== false;
  const languageIcon = isDefaultLanguage
    ? getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE)
    : normalizeCircleFlagIconId(language.icon) ||
      getDefaultAutoTranslateLanguageIcon(normalizedCode || language.code);
  const statusProgress = cacheStatus && isTranslationStatusPending(cacheStatus) ? getTranslationStatusProgressPercent(cacheStatus) : null;
  const statusTone = getTranslationCacheStatusTone(cacheStatus);
  const statusLabel = getTranslationCacheStatusLabel(cacheStatus);
  const statusTooltip =
    !cacheStatus && overviewError
      ? overviewError
      : !cacheStatus && overviewLoading
        ? "Checking localization status"
        : getTranslationCacheStatusTooltip(cacheStatus);

  return (
    <div className={`translation-language-item${isDefaultLanguage ? " translation-language-item-fixed" : ""}`}>
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
            onChange={(event) => onChange(index, { enabled: event.target.checked })}
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
            onChange={(event) => onChange(index, { name: event.target.value })}
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
            onChange={(event) => onChange(index, { code: event.target.value })}
            onBlur={(event) => {
              const code = normalizeAutoTranslateLanguageCode(event.target.value);
              if (code) {
                onChange(index, { code });
              }
            }}
          />
        </label>

        <CircleFlagIconPicker
          id={`auto-translate-language-icon-${index}`}
          value={languageIcon}
          disabled={isDefaultLanguage}
          selectedDisplay="icon"
          showLabel={false}
          onChange={(icon) => onChange(index, { icon })}
        />
      </div>

      <div className="translation-language-actions">
        <span
          className={`translation-language-cache-status translation-language-cache-status-${statusTone}${
            statusProgress === null ? "" : " translation-language-cache-status-progress"
          } ui-tooltip`}
          data-ui-tooltip={statusTooltip}
          aria-label={statusTooltip}
          {...(statusProgress === null
            ? {}
            : {
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": statusProgress,
                style: { "--translation-status-progress": statusProgress / 100 } as CSSProperties,
              })}
        >
          {statusLabel}
        </span>
        <span
          className="translation-language-action-tooltip ui-tooltip"
          data-ui-tooltip="Request Translations for All Pages"
        >
          <button
            type="button"
            className="btn btn-icon translation-language-request"
            aria-label="Request Translations for All Pages"
            disabled={isDefaultLanguage || requestBusy}
            onClick={() => onRequestTranslations(language)}
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
            onClick={() => onRemove(index)}
          >
            <MaterialIcon name={isDefaultLanguage ? "lock" : "delete"} />
          </button>
        </span>
      </div>
    </div>
  );
}
