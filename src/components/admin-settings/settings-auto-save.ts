import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  INITIAL_SETTINGS,
  sameDraftValue,
  themeCustomizationFromSettings,
  type ClearSecretTarget,
  type SettingsStore,
} from "@/components/admin-settings/settings-store";
import { hasSettingsFieldErrors, normalizeSettingsForSave, validateSettingsFields } from "@/components/admin-settings/settings-validation";
import { clearAdminGitHubToken, clearAdminOpenRouterApiKey, formatApiError, saveAdminSettings } from "@/components/api";
import type { AdminSettings, ThemeCustomization } from "@/components/types";

const createSaveSnapshot = (draft: AdminSettings): string =>
  JSON.stringify({
    settings: draft,
  });

type SettingsAutoSaveOptions = {
  lifetimeSignal: () => AbortSignal;
  /** Called after every save with the saved settings, before the SSL status is refreshed. */
  onSaved: (saved: AdminSettings) => void;
  /** Awaited after a save that changed the custom domain or the Let's Encrypt email. */
  refreshSslStatus: () => Promise<void>;
  setThemeSettings: (settings: ThemeCustomization) => void;
  settingsStore: SettingsStore;
};

type SettingsAutoSave = {
  /** Shows the settings the panel loaded and lets the auto-save start. */
  applyLoadedSettings: (loaded: AdminSettings) => void;
  clearSavedSecret: (target: ClearSecretTarget) => Promise<void>;
  isAutoSaveReady: () => boolean;
  /**
   * Saves the draft when it differs from the saved settings and has no field errors. One save
   * runs at a time; a call meanwhile queues one follow-up save of the latest draft.
   */
  persistLatestSettings: () => Promise<void>;
  stopAutoSave: () => void;
};

/**
 * Saves the settings draft automatically after every change. Secret fields are cleared once
 * their value is saved, and the SSL status is refreshed after the domain settings changed.
 */
export function useSettingsAutoSave({ lifetimeSignal, onSaved, refreshSslStatus, setThemeSettings, settingsStore }: SettingsAutoSaveOptions): SettingsAutoSave {
  const autoSaveReadyRef = useRef(false);
  const autoSaveInFlightRef = useRef(false);
  const autoSaveQueuedRef = useRef(false);
  const lastSavedSnapshotRef = useRef<string | null>(null);
  const lastSavedDomainRef = useRef({
    customDomain: INITIAL_SETTINGS.customDomain,
    letsEncryptEmail: INITIAL_SETTINGS.letsEncryptEmail,
  });

  const getDraft = useCallback((): AdminSettings => settingsStore.getState().draft, [settingsStore]);
  const draft = useSyncExternalStore(settingsStore.subscribe, getDraft, getDraft);

  /** Remembers `settings` as the saved state that later saves compare against. */
  const markSaved = useCallback((settings: AdminSettings): void => {
    lastSavedSnapshotRef.current = createSaveSnapshot(settings);
    lastSavedDomainRef.current = {
      customDomain: settings.customDomain,
      letsEncryptEmail: settings.letsEncryptEmail,
    };
  }, []);

  /** Shows `settings` as the draft, with the theme and the field errors that follow from it. */
  const showSettings = useCallback((settings: AdminSettings): void => {
    settingsStore.setState({ draft: settings, errors: validateSettingsFields(settings) });
    setThemeSettings(themeCustomizationFromSettings(settings));
  }, [setThemeSettings, settingsStore]);

  const persistLatestSettings = useCallback(async () => {
    if (!autoSaveReadyRef.current) {
      return;
    }

    if (autoSaveInFlightRef.current) {
      autoSaveQueuedRef.current = true;
      return;
    }

    const draftToSave = getDraft();
    const snapshot = createSaveSnapshot(draftToSave);

    if (snapshot === lastSavedSnapshotRef.current) {
      return;
    }

    const errors = validateSettingsFields(draftToSave);
    if (hasSettingsFieldErrors(errors)) {
      settingsStore.setState({ errors, saveError: null });
      return;
    }

    const signal = lifetimeSignal();
    autoSaveInFlightRef.current = true;
    settingsStore.setState({ errors, saving: true, saveError: null });

    try {
      const shouldRefreshSslStatus =
        draftToSave.customDomain !== lastSavedDomainRef.current.customDomain ||
        draftToSave.letsEncryptEmail !== lastSavedDomainRef.current.letsEncryptEmail;
      const sentSettings = normalizeSettingsForSave(draftToSave);
      const saved = await saveAdminSettings(sentSettings);
      if (signal.aborted) {
        return;
      }
      const persistedSettings: AdminSettings = {
        ...saved,
        githubToken: "",
        openRouterApiKey: "",
      };
      const latestSettings = getDraft();
      const hasNewerLocalChanges = createSaveSnapshot(latestSettings) !== snapshot;

      if (hasNewerLocalChanges) {
        markSaved(persistedSettings);
        // Secrets the save sent are cleared unless they were edited since; the rest stays as typed.
        settingsStore.setState({
          draft: {
            ...latestSettings,
            openRouterApiKey:
              draftToSave.openRouterApiKey.trim() && latestSettings.openRouterApiKey === draftToSave.openRouterApiKey
                ? ""
                : latestSettings.openRouterApiKey,
            openRouterApiKeyConfigured: persistedSettings.openRouterApiKeyConfigured,
            githubToken:
              draftToSave.githubToken.trim() && latestSettings.githubToken === draftToSave.githubToken
                ? ""
                : latestSettings.githubToken,
            tokenConfigured: persistedSettings.tokenConfigured,
          },
        });
      } else {
        // Languages are saved normalized (canonical IDs, trimmed names). While the server stored
        // exactly the list that was sent, the panel keeps the list as typed, so a save never rewrites
        // an ID or a name under the caret; the ID field normalizes itself on blur. That list is also
        // what later saves compare against, or showing it would start the next save.
        const shownSettings = sameDraftValue(saved.autoTranslateLanguages, sentSettings.autoTranslateLanguages)
          ? { ...persistedSettings, autoTranslateLanguages: latestSettings.autoTranslateLanguages }
          : persistedSettings;
        markSaved(shownSettings);
        showSettings(shownSettings);
      }

      onSaved(persistedSettings);
      if (shouldRefreshSslStatus) {
        await refreshSslStatus();
      }
    } catch (error) {
      if (!signal.aborted) {
        settingsStore.setState({ saveError: formatApiError(error) });
      }
    } finally {
      autoSaveInFlightRef.current = false;
      if (!signal.aborted) {
        settingsStore.setState({ saving: false });
      }

      if (autoSaveQueuedRef.current) {
        autoSaveQueuedRef.current = false;
        void persistLatestSettings();
      }
    }
  }, [getDraft, lifetimeSignal, markSaved, onSaved, refreshSslStatus, settingsStore, showSettings]);

  const clearSavedSecret = useCallback(
    async (target: ClearSecretTarget) => {
      if (!autoSaveReadyRef.current || autoSaveInFlightRef.current) {
        return;
      }

      const currentSettings = getDraft();
      const hasSecret =
        target === "githubToken"
          ? Boolean(currentSettings.githubToken.trim() || currentSettings.tokenConfigured)
          : Boolean(currentSettings.openRouterApiKey.trim() || currentSettings.openRouterApiKeyConfigured);

      if (!hasSecret) {
        return;
      }

      const signal = lifetimeSignal();
      const snapshot = createSaveSnapshot(currentSettings);
      autoSaveInFlightRef.current = true;
      settingsStore.setState({ saving: true, clearingSecret: target, saveError: null });

      try {
        const saved =
          target === "githubToken" ? await clearAdminGitHubToken() : await clearAdminOpenRouterApiKey();
        if (signal.aborted) {
          return;
        }
        const latestSettings = getDraft();
        const hasNewerLocalChanges = createSaveSnapshot(latestSettings) !== snapshot;

        if (hasNewerLocalChanges) {
          // Only what clearing the secret changed is taken over; the rest stays as typed.
          settingsStore.setState({
            draft: {
              ...latestSettings,
              githubToken: target === "githubToken" ? "" : latestSettings.githubToken,
              tokenConfigured: target === "githubToken" ? saved.tokenConfigured : latestSettings.tokenConfigured,
              openRouterApiKey: target === "openRouterApiKey" ? "" : latestSettings.openRouterApiKey,
              aiChatEnabled: target === "openRouterApiKey" ? saved.aiChatEnabled : latestSettings.aiChatEnabled,
              autoTranslateEnabled:
                target === "openRouterApiKey" ? saved.autoTranslateEnabled : latestSettings.autoTranslateEnabled,
              openRouterApiKeyConfigured:
                target === "openRouterApiKey" ? saved.openRouterApiKeyConfigured : latestSettings.openRouterApiKeyConfigured,
            },
          });
        } else {
          const savedSettings: AdminSettings = {
            ...saved,
            githubToken: target === "githubToken" ? "" : latestSettings.githubToken,
            openRouterApiKey: target === "openRouterApiKey" ? "" : latestSettings.openRouterApiKey,
          };
          markSaved(savedSettings);
          showSettings(savedSettings);
        }
      } catch (error) {
        if (!signal.aborted) {
          settingsStore.setState({ saveError: formatApiError(error) });
        }
      } finally {
        autoSaveInFlightRef.current = false;
        if (!signal.aborted) {
          settingsStore.setState({ saving: false, clearingSecret: null });
        }

        if (autoSaveQueuedRef.current) {
          autoSaveQueuedRef.current = false;
          void persistLatestSettings();
        }
      }
    },
    [getDraft, lifetimeSignal, markSaved, persistLatestSettings, settingsStore, showSettings],
  );

  const applyLoadedSettings = useCallback((loaded: AdminSettings): void => {
    markSaved(loaded);
    showSettings(loaded);
    autoSaveReadyRef.current = true;
  }, [markSaved, showSettings]);

  const stopAutoSave = useCallback((): void => {
    autoSaveReadyRef.current = false;
  }, []);

  const isAutoSaveReady = useCallback((): boolean => autoSaveReadyRef.current, []);

  useEffect(() => {
    if (!autoSaveReadyRef.current) {
      return;
    }

    void persistLatestSettings();
  }, [draft, persistLatestSettings]);

  return useMemo(
    () => ({ applyLoadedSettings, clearSavedSecret, isAutoSaveReady, persistLatestSettings, stopAutoSave }),
    [applyLoadedSettings, clearSavedSecret, isAutoSaveReady, persistLatestSettings, stopAutoSave],
  );
}
