import type { AutoTranslateLanguage, AutoTranslateSettings, OpenRouterSettings } from "@/lib/types";

export const DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE = "en-US";
export const DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME = "English (US)";
export const AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME = "vicky_docs_language";
export const AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT = "vicky:languagechange";
export const DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL = "openai/gpt-5.4-mini";

export const DEFAULT_AUTO_TRANSLATE_LANGUAGES: AutoTranslateLanguage[] = [
  { name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME, code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE },
  { name: "German", code: "de" },
  { name: "Polish", code: "pl" },
  { name: "Russian", code: "ru" },
  { name: "Ukrainian", code: "uk" },
  { name: "Japanese", code: "ja" },
  { name: "Korean", code: "ko" },
  { name: "Chinese (Simplified)", code: "zh-CN" },
  { name: "Thai", code: "th" },
  { name: "French", code: "fr" },
  { name: "Spanish (Mexico)", code: "es-MX" },
  { name: "Spanish (Spain)", code: "es-ES" },
  { name: "Portuguese (Brazil)", code: "pt-BR" },
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

const normalizeAutoTranslateLanguageName = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || fallback;
};

export const normalizeAutoTranslateLanguage = (value: unknown): AutoTranslateLanguage | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const code = normalizeAutoTranslateLanguageCode(source.code);
  const name = normalizeAutoTranslateLanguageName(source.name);

  if (!code || !name) {
    return null;
  }

  if (isDefaultAutoTranslateLanguageCode(code)) {
    return {
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
    };
  }

  return {
    name,
    code,
  };
};

export const normalizeAutoTranslateLanguages = (value: unknown): AutoTranslateLanguage[] => {
  const source = Array.isArray(value) ? value : DEFAULT_AUTO_TRANSLATE_LANGUAGES;
  const languages: AutoTranslateLanguage[] = [
    {
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
    },
  ];
  const seenCodes = new Set([DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE.toLowerCase()]);

  for (const entry of source) {
    const language = normalizeAutoTranslateLanguage(entry);
    if (!language || isDefaultAutoTranslateLanguageCode(language.code)) {
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
