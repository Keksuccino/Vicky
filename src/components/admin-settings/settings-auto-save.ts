import { useEffect, useState } from "react";

import {
  INITIAL_SETTINGS,
  sameDraftValue,
  sameEntries,
  themeCustomizationFromSettings,
  type ClearSecretTarget,
  type DraftEdit,
  type SettingsStore,
} from "@/components/admin-settings/settings-store";
import { hasSettingsFieldErrors, normalizeSettingsForSave, validateSettingsFields } from "@/components/admin-settings/settings-validation";
import { clearAdminGitHubToken, clearAdminOpenRouterApiKey, formatApiError, saveAdminSettings } from "@/components/api";
import type { AdminSettings, ThemeCustomization } from "@/components/types";

/** How long typing has to pause before what was typed is saved. */
export const TYPING_SAVE_DELAY_MS = 800;

const SETTINGS_FIELDS = Object.keys(INITIAL_SETTINGS) as (keyof AdminSettings)[];

const sameSettings = (left: AdminSettings, right: AdminSettings): boolean => SETTINGS_FIELDS.every((field) => sameDraftValue(left[field], right[field]));

const withField = <K extends keyof AdminSettings>(settings: AdminSettings, field: K, value: AdminSettings[K]): AdminSettings => ({ ...settings, [field]: value });

const copyField = <K extends keyof AdminSettings>(target: AdminSettings, source: AdminSettings, field: K): void => {
  target[field] = source[field];
};

/** A saved secret is never shown: the field is empty once the server stores it. */
const withoutSecrets = (settings: AdminSettings): AdminSettings => ({ ...settings, githubToken: "", openRouterApiKey: "" });

/** The field the admin is typing in, from its first keystroke until the focus leaves it. */
type TypedField = { field: keyof AdminSettings; savesOnLeave: boolean };

type AutoSaveEffects = {
  /** Called after every save with the stored settings, before the SSL status is refreshed. */
  onSaved: (saved: AdminSettings) => void;
  /** Awaited after a save that changed the custom domain or the Let's Encrypt email. */
  refreshSslStatus: () => Promise<void>;
  setThemeSettings: (settings: ThemeCustomization) => void;
};

type SettingsAutoSaveOptions = AutoSaveEffects & { settingsStore: SettingsStore };

type SettingsAutoSave = {
  /** Shows the settings the panel loaded and lets the auto-save start. */
  applyLoadedSettings: (loaded: AdminSettings) => void;
  /** Removes a saved secret, after the save running now; a secret typed into its field is dropped. */
  clearSavedSecret: (target: ClearSecretTarget) => Promise<void>;
  isAutoSaveReady: () => boolean;
  /**
   * Saves everything changed so far now, the field being typed in included, and resolves once
   * the server stored it (or the save failed or is blocked by a field error).
   */
  persistLatestSettings: () => Promise<void>;
};

/**
 * The auto-save of the settings draft (see `DraftEdit` for when a change is saved).
 *
 * - One request runs at a time; saves asked for meanwhile become one follow-up of the latest draft.
 * - A field the admin is typing in is never changed by a save's answer: it keeps what was typed
 *   (the server may trim or normalize it) and shows the stored value once the focus leaves it.
 * - A field saved on leave keeps its stored value in the saves sent while it is typed in.
 * - Nothing typed is lost: leaving a field or pressing Enter saves it, so do an action that calls
 *   `persistLatestSettings`, the panel unmounting, and the page unloading. The window losing the
 *   focus or the tab being hidden saves what waits for a pause; a field saved on leave waits on.
 *   Saves never stop with the panel's lifetime signal; after it unmounted, their answers only
 *   update the theme.
 * - Secrets are cleared from their field once saved, the domain status is refreshed after the
 *   domain settings changed, and saved secrets can be removed.
 */
function createSettingsAutoSave(store: SettingsStore, initialEffects: AutoSaveEffects) {
  let effects = initialEffects;
  let ready = false;
  let mounted = false;
  /** The settings as the server last stored them, without secrets. */
  let stored = INITIAL_SETTINGS;
  /**
   * Per field, the draft value the stored one was saved from: the stored value, or what was typed
   * while the field is still being typed in. A draft that differs from it has something to save.
   */
  let baseline = INITIAL_SETTINGS;
  let typed: TypedField | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let saveRequested = false;
  let clearRequested: ClearSecretTarget | null = null;
  let busy = false;
  let idle: Promise<void> = Promise.resolve();
  /** What the running save sent, compared against when the page unloads meanwhile. */
  let inFlight: AdminSettings | null = null;
  let appliedTheme: ThemeCustomization | null = null;

  const getDraft = (): AdminSettings => store.getState().draft;

  const cancelTypingTimer = (): void => {
    if (typingTimer !== null) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  };

  /** Applies the theme of `settings`, unless it is the one applied already (applying it animates the page). */
  const applyTheme = (settings: AdminSettings): void => {
    const theme = themeCustomizationFromSettings(settings);
    if (!appliedTheme || !sameEntries(theme, appliedTheme)) {
      appliedTheme = theme;
      effects.setThemeSettings(theme);
    }
  };

  /** Shows `settings` as the draft, with the field errors and the theme that follow from it. */
  const show = (settings: AdminSettings): void => {
    store.setState({ draft: settings, errors: validateSettingsFields(settings) });
    applyTheme(settings);
  };

  /** The draft as a save sends it: a field saved on leave keeps its stored value while it is typed in. */
  const valuesToSend = (draft: AdminSettings): AdminSettings =>
    typed?.savesOnLeave ? withField(draft, typed.field, baseline[typed.field]) : draft;

  /**
   * Takes over the answer to a request that sent `sent`: every field shows what the server stored,
   * except one changed since the request was sent (its follow-up saves it) and the field being
   * typed in (it keeps what was typed).
   */
  const applyAnswer = (sent: AdminSettings, answer: AdminSettings): void => {
    stored = withoutSecrets(answer);
    if (!mounted) {
      applyTheme(stored);
      return;
    }

    const draft = getDraft();
    const shown = { ...draft };
    const nextBaseline = { ...stored };
    for (const field of SETTINGS_FIELDS) {
      if (!sameDraftValue(draft[field], sent[field])) {
        continue;
      }
      if (field === typed?.field) {
        copyField(nextBaseline, draft, field);
      } else {
        copyField(shown, stored, field);
      }
    }
    baseline = nextBaseline;
    show(shown);
  };

  /**
   * Sends the draft once, when it holds something the server does not have and no field errors.
   * Drafts are compared as the save would send them, so an ID that only changed its letter case
   * as the field was left (and was saved in that form already) is not sent again.
   */
  const saveOnce = async (): Promise<void> => {
    const draft = getDraft();
    const sent = valuesToSend(draft);
    const payload = normalizeSettingsForSave(sent);
    if (sameSettings(payload, normalizeSettingsForSave(inFlight ?? baseline))) {
      return;
    }

    // Errors are shown for the draft; a field saved on leave sends its stored value meanwhile, so
    // what is typed there blocks no other save.
    const errors = validateSettingsFields(draft);
    if (mounted) {
      store.setState({ errors, saveError: null });
    }
    if (hasSettingsFieldErrors(sent === draft ? errors : validateSettingsFields(sent))) {
      return;
    }

    const domainChanged = payload.customDomain !== stored.customDomain || payload.letsEncryptEmail !== stored.letsEncryptEmail;
    inFlight = sent;
    try {
      const answer = await saveAdminSettings(payload);
      applyAnswer(sent, answer);
      if (mounted) {
        effects.onSaved(stored);
        if (domainChanged) {
          await effects.refreshSslStatus();
        }
      }
    } catch (error) {
      if (mounted) {
        store.setState({ saveError: formatApiError(error) });
      }
    } finally {
      inFlight = null;
    }
  };

  const clearOnce = async (target: ClearSecretTarget): Promise<void> => {
    try {
      const answer = target === "githubToken" ? await clearAdminGitHubToken() : await clearAdminOpenRouterApiKey();
      // The request sent none of the draft: what the server had stored stands in for it.
      applyAnswer(baseline, answer);
    } catch (error) {
      if (mounted) {
        store.setState({ saveError: formatApiError(error) });
      }
    } finally {
      if (mounted) {
        store.setState({ clearingSecret: null });
      }
    }
  };

  /**
   * Runs the requested clear and saves one at a time until nothing is requested any more. Callers
   * request something first, so the loop always awaits a request before it ends.
   */
  const drain = (): Promise<void> => {
    if (busy) {
      return idle;
    }

    busy = true;
    idle = (async () => {
      try {
        for (;;) {
          const clearTarget = clearRequested;
          if (clearTarget) {
            clearRequested = null;
            await clearOnce(clearTarget);
          } else if (saveRequested) {
            saveRequested = false;
            await saveOnce();
          } else {
            return;
          }
        }
      } finally {
        busy = false;
      }
    })();
    return idle;
  };

  const requestSave = (): Promise<void> => {
    if (!ready) {
      return Promise.resolve();
    }

    saveRequested = true;
    return drain();
  };

  const persistLatestSettings = (): Promise<void> => {
    if (typed?.savesOnLeave) {
      typed = { ...typed, savesOnLeave: false };
    }
    cancelTypingTimer();
    return requestSave();
  };

  const handleEdit = (field: keyof AdminSettings, edit: DraftEdit): void => {
    if (!ready) {
      return;
    }

    cancelTypingTimer();
    if (edit === "now") {
      void requestSave();
      return;
    }

    typed = { field, savesOnLeave: edit === "leave" };
    if (edit === "pause") {
      typingTimer = setTimeout(() => {
        typingTimer = null;
        void requestSave();
      }, TYPING_SAVE_DELAY_MS);
    }
  };

  /** Saves what waits for a pause in typing now; the field being typed in stays as typed. */
  const saveTypingNow = (): void => {
    cancelTypingTimer();
    void requestSave();
  };

  /** The focus left the field being typed in: it is saved now and shown as stored. */
  const finishTyping = (): void => {
    if (!typed) {
      return;
    }

    const { field } = typed;
    typed = null;
    cancelTypingTimer();
    const draft = getDraft();
    if (!sameDraftValue(draft[field], stored[field]) && sameDraftValue(normalizeSettingsForSave(draft)[field], normalizeSettingsForSave(baseline)[field])) {
      // Saved already, as typed; the server may have trimmed or normalized it.
      baseline = withField(baseline, field, stored[field]);
      show(withField(draft, field, stored[field]));
    }
    void requestSave();
  };

  /**
   * The page unloads, so a follow-up would never be sent: what a running request does not carry
   * yet is sent beside it at once. Every save is a keepalive request (see `saveAdminSettings`).
   */
  const saveBeforeUnload = (): void => {
    typed = null;
    cancelTypingTimer();
    if (!ready) {
      return;
    }

    if (busy) {
      void saveOnce();
    } else {
      void requestSave();
    }
  };

  const clearSavedSecret = (target: ClearSecretTarget): Promise<void> => {
    const draft = getDraft();
    const configured = target === "githubToken" ? draft.tokenConfigured : draft.openRouterApiKeyConfigured;
    if (!ready || store.getState().clearingSecret || !(draft[target].trim() || configured)) {
      return Promise.resolve();
    }

    // The admin asked for no secret: one typed into the field is dropped instead of saved.
    if (typed?.field === target) {
      typed = null;
    }
    store.setState({ draft: withField(draft, target, ""), clearingSecret: target, saveError: null });
    clearRequested = target;
    return drain();
  };

  const applyLoadedSettings = (loaded: AdminSettings): void => {
    stored = withoutSecrets(loaded);
    baseline = stored;
    typed = null;
    cancelTypingTimer();
    show(stored);
    ready = true;
  };

  /** Starts following the admin's edits and the page; the returned cleanup saves what is still waiting. */
  const attach = (): (() => void) => {
    mounted = true;
    const unsubscribeEdits = store.subscribeEdits(handleEdit);
    let focusCheck: ReturnType<typeof setTimeout> | null = null;
    const onFocusOut = (event: FocusEvent): void => {
      const field = event.target;
      if (!typed || focusCheck !== null) {
        return;
      }
      // Where the focus went is known once it moved. A field that keeps it only lost the window's
      // focus (another tab or app): the admin comes back to type on, so it stays as typed, and a
      // field saved on leave stays unsaved until it is really left or the page goes away.
      focusCheck = setTimeout(() => {
        focusCheck = null;
        if (document.activeElement === field) {
          saveTypingNow();
        } else {
          finishTyping();
        }
      }, 0);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // Enter confirms a single-line field: what is typed is saved, the field keeps it as typed.
      if (typed && event.key === "Enter" && !event.isComposing && event.target instanceof HTMLInputElement) {
        void persistLatestSettings();
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        saveTypingNow();
      }
    };
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", saveBeforeUnload);

    return () => {
      if (focusCheck !== null) {
        clearTimeout(focusCheck);
      }
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", saveBeforeUnload);
      unsubscribeEdits();
      // The panel unmounts while the app stays open: what waits is saved, and the running save
      // and its follow-up still run.
      mounted = false;
      typed = null;
      cancelTypingTimer();
      void requestSave();
      ready = false;
    };
  };

  return {
    attach,
    setEffects: (next: AutoSaveEffects): void => {
      effects = next;
    },
    api: {
      applyLoadedSettings,
      clearSavedSecret,
      isAutoSaveReady: () => ready,
      persistLatestSettings,
    } satisfies SettingsAutoSave,
  };
}

/** The panel's auto-save; its members keep their identity for the panel's lifetime. */
export function useSettingsAutoSave({ onSaved, refreshSslStatus, setThemeSettings, settingsStore }: SettingsAutoSaveOptions): SettingsAutoSave {
  const [autoSave] = useState(() => createSettingsAutoSave(settingsStore, { onSaved, refreshSslStatus, setThemeSettings }));

  useEffect(() => {
    autoSave.setEffects({ onSaved, refreshSslStatus, setThemeSettings });
  }, [autoSave, onSaved, refreshSslStatus, setThemeSettings]);

  useEffect(() => autoSave.attach(), [autoSave]);

  return autoSave.api;
}
