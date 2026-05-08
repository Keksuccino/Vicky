import type { AutoTranslateLanguage, AutoTranslateSettings, OpenRouterSettings } from "@/lib/types";

export const DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE = "en-US";
export const DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME = "English (US)";
export const AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME = "vicky_docs_language";
export const AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT = "vicky:languagechange";
export const DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL = "openai/gpt-5.4-mini";
export const DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON = "xx";

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

export const DEFAULT_AUTO_TRANSLATE_LANGUAGES: AutoTranslateLanguage[] = [
  { name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME, code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE, icon: "us" },
  { name: "German", code: "de", icon: "de" },
  { name: "Polish", code: "pl", icon: "pl" },
  { name: "Russian", code: "ru", icon: "ru" },
  { name: "Ukrainian", code: "uk", icon: "ua" },
  { name: "Japanese", code: "ja", icon: "jp" },
  { name: "Korean", code: "ko", icon: "kr" },
  { name: "Chinese (Simplified)", code: "zh-CN", icon: "cn" },
  { name: "Thai", code: "th", icon: "th" },
  { name: "French", code: "fr", icon: "fr" },
  { name: "Spanish (Mexico)", code: "es-MX", icon: "mx" },
  { name: "Spanish (Spain)", code: "es-ES", icon: "es" },
  { name: "Portuguese (Brazil)", code: "pt-BR", icon: "br" },
];

export const DEFAULT_OPENROUTER_SETTINGS = (): OpenRouterSettings => ({
  apiKeyEncrypted: null,
});

export const DEFAULT_AUTO_TRANSLATE_SETTINGS = (): AutoTranslateSettings => ({
  enabled: false,
  openRouterModel: DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  languages: DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language })),
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

  if (!code || !name) {
    return null;
  }

  if (isDefaultAutoTranslateLanguageCode(code)) {
    return {
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
      icon: getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE),
    };
  }

  return {
    name,
    code,
    icon,
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

export const normalizeAutoTranslateOpenRouterModel = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL;
  }

  const trimmed = value.trim();
  return trimmed || DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL;
};

export const normalizeAutoTranslateSettings = (value: unknown): AutoTranslateSettings => {
  const defaults = DEFAULT_AUTO_TRANSLATE_SETTINGS();
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    openRouterModel: normalizeAutoTranslateOpenRouterModel(source.openRouterModel),
    languages: normalizeAutoTranslateLanguages(source.languages),
  };
};

export const resolveAutoTranslateLanguage = (
  settings: AutoTranslateSettings,
  requestedCode: string | null | undefined,
): AutoTranslateLanguage => {
  const requested = normalizeAutoTranslateLanguageCode(requestedCode);
  if (!settings.enabled || !requested) {
    return settings.languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code)) ?? DEFAULT_AUTO_TRANSLATE_LANGUAGES[0];
  }

  return (
    settings.languages.find((language) => languageCodesEqual(language.code, requested)) ??
    settings.languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code)) ??
    DEFAULT_AUTO_TRANSLATE_LANGUAGES[0]
  );
};

export const shouldTranslateAutoTranslateLanguage = (
  settings: AutoTranslateSettings,
  language: AutoTranslateLanguage,
): boolean => settings.enabled && !isDefaultAutoTranslateLanguageCode(language.code);
