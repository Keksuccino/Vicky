import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { EMPTY_SETTINGS_FIELD_ERRORS, type SettingsFieldErrors } from "@/components/admin-settings/settings-validation";
import type { AdminSettings, ThemeCustomization } from "@/components/types";
import {
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
} from "@/lib/ai-chat";
import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGES,
  DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCALIZATION_PATH,
} from "@/lib/auto-translate";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";
import { DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";

const THEME_DEFAULTS = DEFAULT_THEME_CUSTOMIZATION();

/** The draft before the saved settings are loaded; no card shows it. */
export const INITIAL_SETTINGS: AdminSettings = {
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

type ThemeSettingsFields = Pick<
  AdminSettings,
  "themeLightAccent" | "themeLightSurfaceAccent" | "themeDarkAccent" | "themeDarkSurfaceAccent" | "themeCustomCss"
>;

export const themeCustomizationFromSettings = (settings: ThemeSettingsFields): ThemeCustomization => ({
  lightAccent: settings.themeLightAccent,
  lightSurfaceAccent: settings.themeLightSurfaceAccent,
  darkAccent: settings.themeDarkAccent,
  darkSurfaceAccent: settings.themeDarkSurfaceAccent,
  customCss: settings.themeCustomCss,
});

export type ClearSecretTarget = "githubToken" | "openRouterApiKey";

/** Everything the settings cards share: the draft and the state of its auto-save. */
export type SettingsState = {
  /** The admin's working copy of the settings, saved automatically whenever it changes. */
  draft: AdminSettings;
  errors: SettingsFieldErrors;
  /** A save or the removal of a saved secret is in flight. */
  saving: boolean;
  clearingSecret: ClearSecretTarget | null;
  saveError: string | null;
};

/**
 * Holds the settings state outside React, so each card subscribes to the fields it shows
 * (`useDraftFields`) and typing in one card re-renders only that card. Subscribers re-render
 * synchronously on every change, so what a card shows is always what its handlers read.
 */
export type SettingsStore = {
  getState: () => SettingsState;
  setState: (patch: Partial<SettingsState>) => void;
  subscribe: (listener: () => void) => () => void;
  setDraftField: <K extends keyof AdminSettings>(field: K, value: AdminSettings[K]) => void;
  patchErrors: <G extends keyof SettingsFieldErrors>(group: G, patch: Partial<SettingsFieldErrors[G]>) => void;
};

export const createSettingsStore = (): SettingsStore => {
  let state: SettingsState = {
    draft: INITIAL_SETTINGS,
    errors: EMPTY_SETTINGS_FIELD_ERRORS,
    saving: false,
    clearingSecret: null,
    saveError: null,
  };
  const listeners = new Set<() => void>();
  const setState = (patch: Partial<SettingsState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  return {
    getState: () => state,
    setState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraftField: (field, value) => setState({ draft: { ...state.draft, [field]: value } }),
    patchErrors: (group, patch) => setState({ errors: { ...state.errors, [group]: { ...state.errors[group], ...patch } } }),
  };
};

/**
 * Same keys in the same order with the same values. Key order counts, so two flat objects that
 * pass also serialize to the same JSON, which the cards compare in places.
 */
const sameEntries = (left: object, right: object): boolean => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => key === rightEntries[index][0] && Object.is(value, rightEntries[index][1]))
  );
};

/** The language list arrives as a new array after every save; a list with the same entries counts as unchanged. */
const sameDraftValue = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) ||
  (Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((entry: object, index) => sameEntries(entry, right[index] as object)));

/** Reads `select` of the store's state, and keeps returning the previous value while `isEqual` accepts the new one. */
const createSelectionGetter = <T>(store: SettingsStore, select: (state: SettingsState) => T, isEqual: (left: T, right: T) => boolean): (() => T) => {
  let selection: { value: T } | null = null;

  return () => {
    const next = select(store.getState());
    if (selection && isEqual(selection.value, next)) {
      return selection.value;
    }
    selection = { value: next };
    return next;
  };
};

/**
 * Subscribes to one part of the settings state; the component re-renders only when `select`
 * returns a value `isEqual` rejects. Both must keep their identity across renders (module-level
 * functions or memoized callbacks): new ones on every render would read as a new value each time.
 */
export function useSettingsSelector<T>(select: (state: SettingsState) => T, isEqual: (left: T, right: T) => boolean = Object.is): T {
  const { settingsStore } = useAdminPanel();
  const getSelection = useMemo(() => createSelectionGetter(settingsStore, select, isEqual), [isEqual, select, settingsStore]);

  return useSyncExternalStore(settingsStore.subscribe, getSelection, getSelection);
}

/** Draft values of `fields`, which must be a module-level constant. */
export function useDraftFields<K extends keyof AdminSettings>(fields: readonly K[]): Pick<AdminSettings, K> {
  const select = useCallback(
    ({ draft }: SettingsState): Pick<AdminSettings, K> => {
      const picked = {} as Pick<AdminSettings, K>;
      for (const field of fields) {
        picked[field] = draft[field];
      }
      return picked;
    },
    [fields],
  );
  const isEqual = useCallback((left: Pick<AdminSettings, K>, right: Pick<AdminSettings, K>) => fields.every((field) => sameDraftValue(left[field], right[field])), [fields]);

  return useSettingsSelector(select, isEqual);
}

/** Field errors of one card. */
export function useFieldErrors<G extends keyof SettingsFieldErrors>(group: G): SettingsFieldErrors[G] {
  const select = useCallback(({ errors }: SettingsState) => errors[group], [group]);
  return useSettingsSelector(select, sameEntries);
}
