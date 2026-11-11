"use client";

import { useMemo, useState } from "react";

import { formatCount } from "@/components/admin-settings/format";
import { LanguageRow } from "@/components/admin-settings/localization-language-row";
import { useLocalizationRequests } from "@/components/admin-settings/localization-requests";
import { translationCacheStatusKey } from "@/components/admin-settings/localization-status";
import { useAdminPanel, useLocalizationContext } from "@/components/admin-settings/panel-context";
import { useDraftFields, useSettingsSelector, type DraftEdit, type SettingsState } from "@/components/admin-settings/settings-store";
import { validateAutoTranslateLanguages } from "@/components/admin-settings/settings-validation";
import { TranslationLog } from "@/components/admin-settings/translation-log";
import { MaterialIcon } from "@/components/material-icon";
import type { AutoTranslateLanguage } from "@/components/types";
import {
  DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGES,
  isDefaultAutoTranslateLanguageCode,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";

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

let lastRowKey = 0;

const createRowKey = (): number => {
  lastRowKey += 1;
  return lastRowKey;
};

const LANGUAGE_LIST_FIELDS = ["autoTranslateLanguages", "autoTranslateLocalizationPath"] as const;

const selectLanguagesError = (state: SettingsState): string | null => state.errors.autoTranslate.languages;

/** The selectable languages with their localization status, the translation jobs, and the job log. */
export function LocalizationLanguages() {
  const services = useAdminPanel();
  const { settingsStore } = services;
  const localization = useLocalizationContext();
  const { job, requestStatus, statusError, statusLoading, statuses, statusesLocalizationPath } = localization;
  const { bulkAction, recordSourceVersions, requestBulkTranslations, requestLanguageTranslations, requestedLanguageCodes } = useLocalizationRequests(services, localization);
  const { autoTranslateLanguages: languages, autoTranslateLocalizationPath } = useDraftFields(LANGUAGE_LIST_FIELDS);
  const languagesError = useSettingsSelector(selectLanguagesError);
  // One key per row in list order, kept beside the list because the draft is sent to the server as
  // it is. Edits keep every key, and so does a save's answer (a list of the same length); removing,
  // adding, and resetting pass the keys they leave.
  const [storedRowKeys, setRowKeys] = useState(() => languages.map(createRowKey));
  let rowKeys = storedRowKeys;
  if (rowKeys.length !== languages.length) {
    // A list of another length arrived from outside the row actions: rows keep their keys by position.
    rowKeys = languages.map((_, index) => storedRowKeys[index] ?? createRowKey());
    setRowKeys(rowKeys);
  }
  const activeTranslationMode = job?.status === "running" ? job.mode : bulkAction;
  /** Statuses are shown only while they belong to the localization directory in the field. */
  const statusesShown = statusesLocalizationPath === normalizeLocalizationPath(autoTranslateLocalizationPath);
  /** Current translations that do not record their source version yet, as the overview or a running job reports them. */
  const unrecordedTranslationCount = useMemo(
    () =>
      languages.reduce(
        (total, language) =>
          isDefaultAutoTranslateLanguageCode(language.code) ? total : total + (statuses[translationCacheStatusKey(language.code)]?.unrecordedPages ?? 0),
        0,
      ),
    [languages, statuses],
  );

  // The list starts with the source language: the server stores it first, and the panel neither
  // moves rows nor removes that one. A later row typed with its ID is a duplicate the admin can
  // correct, never the locked source row.
  const sourceRowIndex = languages.findIndex((language) => isDefaultAutoTranslateLanguageCode(language.code));

  const changeLanguages = (nextLanguages: AutoTranslateLanguage[], nextRowKeys = rowKeys, edit: DraftEdit = "now") => {
    setRowKeys(nextRowKeys);
    settingsStore.setDraftField("autoTranslateLanguages", nextLanguages, edit);
    settingsStore.patchErrors("autoTranslate", { languages: validateAutoTranslateLanguages(nextLanguages) });
  };

  return (
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
              void recordSourceVersions(unrecordedTranslationCount);
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
        {languages.map((language, index) => {
          const normalizedCode = normalizeAutoTranslateLanguageCode(language.code);

          return (
            <LanguageRow
              // A row keeps its key while its ID is typed, so it stays mounted with its focus and caret,
              // and its state (an open icon picker) stays with its language when other rows change.
              key={rowKeys[index]}
              index={index}
              isSourceLanguage={index === sourceRowIndex}
              language={language}
              normalizedCode={normalizedCode}
              cacheStatus={normalizedCode && statusesShown ? statuses[translationCacheStatusKey(normalizedCode)] : undefined}
              overviewError={statusError}
              overviewLoading={statusLoading}
              requestBusy={activeTranslationMode !== null || (normalizedCode ? requestedLanguageCodes.has(normalizedCode.toLowerCase()) : false)}
              onChange={(changedIndex, change, edit) => {
                changeLanguages(
                  languages.map((entry, entryIndex) => (entryIndex === changedIndex ? { ...entry, ...change } : entry)),
                  rowKeys,
                  edit,
                );
              }}
              onRemove={(removedIndex) => {
                changeLanguages(
                  languages.filter((_, entryIndex) => entryIndex !== removedIndex),
                  rowKeys.filter((_, entryIndex) => entryIndex !== removedIndex),
                );
              }}
              onRequestTranslations={(requestedLanguage) => {
                void requestLanguageTranslations(requestedLanguage);
              }}
            />
          );
        })}
      </div>

      <div className="action-row">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            changeLanguages([...languages, createCustomAutoTranslateLanguage(languages)], [...rowKeys, createRowKey()]);
          }}
        >
          <MaterialIcon name="add" />
          <span>Add language</span>
        </button>

        <button
          type="button"
          className="btn btn-ghost"
          disabled={JSON.stringify(languages) === JSON.stringify(DEFAULT_AUTO_TRANSLATE_LANGUAGES)}
          onClick={() => {
            changeLanguages(
              DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language })),
              DEFAULT_AUTO_TRANSLATE_LANGUAGES.map(createRowKey),
            );
          }}
        >
          Reset languages
        </button>
      </div>

      <TranslationLog job={job} requestStatus={requestStatus} />

      <span className="field-hint">
        {DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME} is the source language. Other languages map to GitHub folders by language ID.
      </span>
      {languagesError ? (
        <span className="error-text">{languagesError}</span>
      ) : null}
    </div>
  );
}
