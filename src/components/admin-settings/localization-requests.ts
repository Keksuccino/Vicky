import { useCallback, useState } from "react";

import { formatCount } from "@/components/admin-settings/format";
import type { AdminPanelServices } from "@/components/admin-settings/panel-context";
import type { LocalizationStatus } from "@/components/admin-settings/localization-status";
import { formatApiError, requestAdminLanguageTranslations, requestAdminSourceVersionRecording } from "@/components/api";
import type { AdminTranslationJobSnapshot, AutoTranslateLanguage } from "@/components/types";
import {
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguages,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";
import { normalizeCircleFlagIconId } from "@/lib/circle-flags";

/**
 * The jobs the localization card starts, each after the admin confirmed it: translations for one
 * language or all of them, and recording source versions. The request values are read when the
 * admin clicks; pending settings are saved before the job starts.
 */
export function useLocalizationRequests(
  { lifetimeSignal, persistLatestSettings, settingsStore }: AdminPanelServices,
  { followStartedJob, setRequestStatus }: LocalizationStatus,
) {
  const [requestedLanguageCodes, setRequestedLanguageCodes] = useState<Set<string>>(() => new Set());
  const [bulkAction, setBulkAction] = useState<AdminTranslationJobSnapshot["mode"] | null>(null);

  /** Saves pending settings, starts a job with `start`, and follows it; `settle` ends the request's busy state. */
  const startJob = useCallback(
    async (start: () => Promise<AdminTranslationJobSnapshot>, settle: () => void) => {
      const signal = lifetimeSignal();
      setRequestStatus(null);

      try {
        await persistLatestSettings();
        const job = await start();
        if (signal.aborted) {
          return;
        }
        followStartedJob(job);
      } catch (error) {
        if (!signal.aborted) {
          setRequestStatus({
            tone: "error",
            message: formatApiError(error),
          });
        }
      } finally {
        if (!signal.aborted) {
          settle();
        }
      }
    },
    [followStartedJob, lifetimeSignal, persistLatestSettings, setRequestStatus],
  );

  const requestLanguageTranslations = useCallback(
    async (language: AutoTranslateLanguage) => {
      const code = normalizeAutoTranslateLanguageCode(language.code);
      const name = language.name.trim();

      if (!code || !name) {
        setRequestStatus({
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

      const localizationPath = normalizeLocalizationPath(settingsStore.getState().draft.autoTranslateLocalizationPath);
      setRequestedLanguageCodes((prev) => {
        const next = new Set(prev);
        next.add(code.toLowerCase());
        return next;
      });

      await startJob(
        () => {
          const icon = normalizeCircleFlagIconId(language.icon) || getDefaultAutoTranslateLanguageIcon(code);
          return requestAdminLanguageTranslations({
            mode: "missing-and-outdated",
            languages: [{ name, code, icon, enabled: language.enabled !== false }],
            localizationPath,
          });
        },
        () => {
          setRequestedLanguageCodes((prev) => {
            const next = new Set(prev);
            next.delete(code.toLowerCase());
            return next;
          });
        },
      );
    },
    [setRequestStatus, settingsStore, startJob],
  );

  const requestBulkTranslations = useCallback(
    async (mode: "outdated" | "missing-and-outdated") => {
      const { autoTranslateLanguages, autoTranslateLocalizationPath } = settingsStore.getState().draft;
      const targetLanguages = autoTranslateLanguages.filter((language) => !isDefaultAutoTranslateLanguageCode(language.code));
      if (targetLanguages.length === 0) {
        setRequestStatus({
          tone: "error",
          message: "Add at least one target language first.",
        });
        return;
      }

      const label = mode === "outdated" ? "Update all outdated translations" : "Translate all missing and outdated pages";
      if (!window.confirm(`${label}?`)) {
        return;
      }

      setBulkAction(mode);
      await startJob(
        () =>
          requestAdminLanguageTranslations({
            mode,
            languages: normalizeAutoTranslateLanguages(autoTranslateLanguages),
            localizationPath: normalizeLocalizationPath(autoTranslateLocalizationPath),
          }),
        () => setBulkAction(null),
      );
    },
    [setRequestStatus, settingsStore, startJob],
  );

  /** `count` is the number of current translations without a recorded source version, as the card shows it. */
  const recordSourceVersions = useCallback(
    async (count: number) => {
      if (count === 0) {
        return;
      }

      const { githubBranch, githubOwner, githubRepo } = settingsStore.getState().draft;
      const files = `${formatCount(count)} translation${count === 1 ? "" : "s"}`;
      const repository = `${githubOwner.trim()}/${githubRepo.trim()} (${githubBranch.trim() || "main"})`;
      if (
        !window.confirm(
          `Record the source version in ${files}?\n\nThis commits ${count === 1 ? "1 file" : `${formatCount(count)} files`} to ${repository} in a single commit. Only the front matter changes, so the pages stay exactly as they are. Outdated translations are left alone.`,
        )
      ) {
        return;
      }

      setBulkAction("source-versions");
      await startJob(() => requestAdminSourceVersionRecording(count), () => setBulkAction(null));
    },
    [settingsStore, startJob],
  );

  return { bulkAction, recordSourceVersions, requestBulkTranslations, requestLanguageTranslations, requestedLanguageCodes };
}
