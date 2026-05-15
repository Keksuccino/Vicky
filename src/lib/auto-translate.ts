import type { AutoTranslateLanguage, AutoTranslateSettings, OpenRouterSettings } from "@/lib/types";

export const DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE = "en-US";
export const DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME = "English (US)";
export const AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME = "vicky_docs_language";
export const AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT = "vicky:languagechange";
export const DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL = "openai/gpt-5.4-mini";
export const DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON = "xx";
export const DEFAULT_LOCALIZATION_PATH = "localizations";
export const DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;
export const MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS = 10 * 1_000;

const DEFAULT_AUTO_TRANSLATE_LANGUAGE_ICONS: Record<string, string> = {
  "en-US": "us",
  de: "de",
  pl: "pl",
  ru: "ru",
  uk: "ua",
  ja: "jp",
  ko: "kr",
  "zh-CN": "cn",
  th: "th",
  fr: "fr",
  "es-MX": "mx",
  "es-ES": "es",
  "pt-BR": "br",
};

const defaultAutoTranslateLanguage = (name: string, code: string, icon: string): AutoTranslateLanguage => ({
  name,
  code,
  icon,
  enabled: true,
});

export const DEFAULT_AUTO_TRANSLATE_LANGUAGES: AutoTranslateLanguage[] = [
  defaultAutoTranslateLanguage(DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE, "us"),
  defaultAutoTranslateLanguage("German", "de", "de"),
  defaultAutoTranslateLanguage("Polish", "pl", "pl"),
  defaultAutoTranslateLanguage("Russian", "ru", "ru"),
  defaultAutoTranslateLanguage("Ukrainian", "uk", "ua"),
  defaultAutoTranslateLanguage("Japanese", "ja", "jp"),
  defaultAutoTranslateLanguage("Korean", "ko", "kr"),
  defaultAutoTranslateLanguage("Chinese (Simplified)", "zh-CN", "cn"),
  defaultAutoTranslateLanguage("Thai", "th", "th"),
  defaultAutoTranslateLanguage("French", "fr", "fr"),
  defaultAutoTranslateLanguage("Spanish (Mexico)", "es-MX", "mx"),
  defaultAutoTranslateLanguage("Spanish (Spain)", "es-ES", "es"),
  defaultAutoTranslateLanguage("Portuguese (Brazil)", "pt-BR", "br"),
];

export const DEFAULT_OPENROUTER_SETTINGS = (): OpenRouterSettings => ({
  apiKeyEncrypted: null,
});

export const DEFAULT_AUTO_TRANSLATE_SETTINGS = (): AutoTranslateSettings => ({
  enabled: false,
  openRouterModel: DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  requestTimeoutMs: DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  languages: DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language })),
  localizationPath: DEFAULT_LOCALIZATION_PATH,
});

const LANGUAGE_CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

export const normalizeAutoTranslateLanguageCode = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim().replace(/_/g, "-");
  if (!trimmed || !LANGUAGE_CODE_PATTERN.test(trimmed)) {
    return "";
  }

  const parts = trimmed.split("-").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }

  return parts
    .map((part, index) => {
      if (index === 0) {
        return part.toLowerCase();
      }

      return part.length === 2 || part.length === 3 ? part.toUpperCase() : part;
    })
    .join("-");
};

export const languageCodesEqual = (left: string, right: string): boolean =>
  normalizeAutoTranslateLanguageCode(left).toLowerCase() === normalizeAutoTranslateLanguageCode(right).toLowerCase();

export const isDefaultAutoTranslateLanguageCode = (value: string): boolean =>
  languageCodesEqual(value, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE);

export const getDefaultAutoTranslateLanguageIcon = (code: string): string =>
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_ICONS[normalizeAutoTranslateLanguageCode(code)] ?? DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON;

const normalizeAutoTranslateLanguageName = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || fallback;
};

export const normalizeAutoTranslateLanguageIcon = (value: unknown, languageCode: string): string => {
  if (typeof value !== "string") {
    return getDefaultAutoTranslateLanguageIcon(languageCode);
  }

  const icon = value.trim().toLowerCase().replace(/^circle-flags:/, "").replace(/_/g, "-");
  return icon || getDefaultAutoTranslateLanguageIcon(languageCode);
};

export const normalizeAutoTranslateLanguage = (value: unknown): AutoTranslateLanguage | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const code = normalizeAutoTranslateLanguageCode(source.code);
  const name = normalizeAutoTranslateLanguageName(source.name);
  const icon = normalizeAutoTranslateLanguageIcon(source.icon, code);
  const enabled = typeof source.enabled === "boolean" ? source.enabled : true;

  if (!code || !name) {
    return null;
  }

  if (isDefaultAutoTranslateLanguageCode(code)) {
    return {
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
      icon: getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE),
      enabled: true,
    };
  }

  return {
    name,
    code,
    icon,
    enabled,
  };
};

export const normalizeAutoTranslateLanguages = (value: unknown): AutoTranslateLanguage[] => {
  const source = Array.isArray(value) ? value : DEFAULT_AUTO_TRANSLATE_LANGUAGES;
  const normalizedLanguages = source
    .map((entry) => normalizeAutoTranslateLanguage(entry))
    .filter((language): language is AutoTranslateLanguage => language !== null);
  const languages: AutoTranslateLanguage[] = [
    {
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
      icon: getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE),
      enabled: true,
    },
  ];
  const seenCodes = new Set([DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE.toLowerCase()]);

  for (const language of normalizedLanguages) {
    if (isDefaultAutoTranslateLanguageCode(language.code)) {
      continue;
    }

    const normalizedCodeKey = language.code.toLowerCase();
    if (seenCodes.has(normalizedCodeKey)) {
      continue;
    }

    seenCodes.add(normalizedCodeKey);
    languages.push(language);
  }

  return languages;
};

export const isAutoTranslateLanguageUserVisible = (language: Pick<AutoTranslateLanguage, "code" | "enabled">): boolean =>
  isDefaultAutoTranslateLanguageCode(language.code) || language.enabled !== false;

export const getUserVisibleAutoTranslateLanguages = (languages: AutoTranslateLanguage[]): AutoTranslateLanguage[] => {
  const normalizedLanguages = normalizeAutoTranslateLanguages(languages);
  const visibleLanguages = normalizedLanguages.filter(isAutoTranslateLanguageUserVisible);

  return visibleLanguages.length > 0 ? visibleLanguages : normalizedLanguages.slice(0, 1);
};

export const normalizeAutoTranslateOpenRouterModel = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL;
  }

  const trimmed = value.trim();
  return trimmed || DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL;
};

export const normalizeAutoTranslateRequestTimeoutMs = (value: unknown): number => {
  let numeric = Number.NaN;

  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim()) {
    numeric = Number(value);
  }

  if (!Number.isFinite(numeric)) {
    return DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS;
  }

  return Math.max(MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS, Math.round(numeric));
};

export const normalizeLocalizationPath = (value: unknown): string => {
  const raw = typeof value === "string" ? value.trim() : DEFAULT_LOCALIZATION_PATH;
  const normalized = raw
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);

  if (!normalized || segments.some((segment) => segment === "." || segment === "..")) {
    return DEFAULT_LOCALIZATION_PATH;
  }

  return segments.join("/");
};

export const normalizeAutoTranslateSettings = (value: unknown): AutoTranslateSettings => {
  const defaults = DEFAULT_AUTO_TRANSLATE_SETTINGS();
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    openRouterModel: normalizeAutoTranslateOpenRouterModel(source.openRouterModel),
    requestTimeoutMs: normalizeAutoTranslateRequestTimeoutMs(source.requestTimeoutMs),
    languages: normalizeAutoTranslateLanguages(source.languages),
    localizationPath: normalizeLocalizationPath(source.localizationPath ?? source.directory),
  };
};

export const resolveAutoTranslateLanguage = (
  settings: AutoTranslateSettings,
  requestedCode: string | null | undefined,
): AutoTranslateLanguage => {
  const requested = normalizeAutoTranslateLanguageCode(requestedCode);
  const defaultLanguage =
    settings.languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code)) ?? DEFAULT_AUTO_TRANSLATE_LANGUAGES[0];
  if (!requested) {
    return defaultLanguage;
  }

  return (
    settings.languages.find(
      (language) => isAutoTranslateLanguageUserVisible(language) && languageCodesEqual(language.code, requested),
    ) ?? defaultLanguage
  );
};

export const shouldTranslateAutoTranslateLanguage = (
  settings: AutoTranslateSettings,
  language: AutoTranslateLanguage,
): boolean => settings.enabled && !isDefaultAutoTranslateLanguageCode(language.code);
