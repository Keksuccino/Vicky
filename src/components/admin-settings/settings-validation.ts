import { AI_CHAT_DOCS_PLACEHOLDER } from "@/lib/ai-chat";
import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguages,
  normalizeAutoTranslateRequestTimeoutMs,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";
import { isCircleFlagIconId } from "@/lib/circle-flags";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import type { AdminSettings, AutoTranslateLanguage } from "@/components/types";

type DomainFieldErrors = {
  customDomain: string | null;
  letsEncryptEmail: string | null;
};

type AiChatFieldErrors = {
  systemPrompt: string | null;
  openRouterModel: string | null;
};

type OpenRouterFieldErrors = {
  apiKey: string | null;
};

type AutoTranslateFieldErrors = {
  openRouterModel: string | null;
  requestTimeout: string | null;
  localizationPath: string | null;
  languages: string | null;
};

/** Field errors of the settings draft, grouped by the card that shows them. */
export type SettingsFieldErrors = {
  domain: DomainFieldErrors;
  aiChat: AiChatFieldErrors;
  openRouter: OpenRouterFieldErrors;
  autoTranslate: AutoTranslateFieldErrors;
};

const EMPTY_AI_CHAT_FIELD_ERRORS: AiChatFieldErrors = {
  systemPrompt: null,
  openRouterModel: null,
};

export const EMPTY_SETTINGS_FIELD_ERRORS: SettingsFieldErrors = {
  domain: { customDomain: null, letsEncryptEmail: null },
  aiChat: EMPTY_AI_CHAT_FIELD_ERRORS,
  openRouter: { apiKey: null },
  autoTranslate: { openRouterModel: null, requestTimeout: null, localizationPath: null, languages: null },
};

export const validateCustomDomainInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return normalizeCustomDomain(trimmed)
    ? null
    : "Enter a valid hostname only (example: docs.example.com, without protocol or path).";
};

export const validateLetsEncryptEmailInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return normalizeLetsEncryptEmail(trimmed) ? null : "Enter a valid email address for Let's Encrypt notifications.";
};

/** `required` is whether the feature using the model is enabled. */
export const validateOpenRouterModelInput = (model: string, required: boolean): string | null =>
  !required || model.trim() ? null : "Enter an OpenRouter model identifier.";

/** `required` is whether AI chat is enabled. */
export const validateSystemPromptInput = (prompt: string, required: boolean): string | null =>
  !required || prompt.includes(AI_CHAT_DOCS_PLACEHOLDER)
    ? null
    : `Include ${AI_CHAT_DOCS_PLACEHOLDER} in the system prompt so the /docs.txt export can be injected.`;

/** `required` is whether an AI feature is enabled; a key saved earlier counts as entered. */
export const validateOpenRouterApiKeyInput = (apiKey: string, configured: boolean, required: boolean): string | null =>
  !required || apiKey.trim() || configured ? null : "Enter an OpenRouter API key before enabling AI features.";

export const validateLocalizationPathInput = (value: string): string | null => {
  const rawLocalizationPath = value.trim();
  const localizationPath = normalizeLocalizationPath(value);
  const normalizedRawLocalizationPath = rawLocalizationPath.replace(/^\/+/, "").replace(/\/+$/, "");

  return !rawLocalizationPath || localizationPath === normalizedRawLocalizationPath
    ? null
    : "Enter a repo-relative folder path without traversal segments.";
};

export const validateAutoTranslateLanguages = (languages: AutoTranslateLanguage[]): string | null => {
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

export const normalizeAutoTranslateRequestTimeoutSeconds = (value: number): number =>
  Math.round(normalizeAutoTranslateRequestTimeoutMs(value * 1_000) / 1_000);

export const validateAutoTranslateRequestTimeoutSeconds = (value: number): string | null => {
  if (!Number.isFinite(value)) {
    return "Enter a timeout in seconds.";
  }

  const minSeconds = MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000;
  return value >= minSeconds ? null : `Use at least ${minSeconds} seconds.`;
};

const validateAiChatFields = (settings: AdminSettings): AiChatFieldErrors => {
  if (!settings.aiChatEnabled) {
    return EMPTY_AI_CHAT_FIELD_ERRORS;
  }

  return {
    systemPrompt: validateSystemPromptInput(settings.aiChatSystemPrompt, true),
    openRouterModel: validateOpenRouterModelInput(settings.openRouterModel, true),
  };
};

/** Validates the whole draft; the auto-save only saves a draft without errors. */
export const validateSettingsFields = (settings: AdminSettings): SettingsFieldErrors => ({
  domain: {
    customDomain: validateCustomDomainInput(settings.customDomain),
    letsEncryptEmail: validateLetsEncryptEmailInput(settings.letsEncryptEmail),
  },
  aiChat: validateAiChatFields(settings),
  openRouter: {
    apiKey: validateOpenRouterApiKeyInput(
      settings.openRouterApiKey,
      settings.openRouterApiKeyConfigured,
      settings.aiChatEnabled || settings.autoTranslateEnabled,
    ),
  },
  autoTranslate: {
    openRouterModel: validateOpenRouterModelInput(settings.autoTranslateOpenRouterModel, settings.autoTranslateEnabled),
    requestTimeout: validateAutoTranslateRequestTimeoutSeconds(settings.autoTranslateRequestTimeoutSeconds),
    localizationPath: validateLocalizationPathInput(settings.autoTranslateLocalizationPath),
    languages: validateAutoTranslateLanguages(settings.autoTranslateLanguages),
  },
});

export const hasSettingsFieldErrors = (errors: SettingsFieldErrors): boolean =>
  Object.values(errors).some((groupErrors: Record<string, string | null>) => Object.values(groupErrors).some(Boolean));

/** The draft with every field normalized as the server expects it; languages as the server stores them. */
export const normalizeSettingsForSave = (settings: AdminSettings): AdminSettings => ({
  ...settings,
  customDomain: normalizeCustomDomain(settings.customDomain),
  letsEncryptEmail: normalizeLetsEncryptEmail(settings.letsEncryptEmail),
  autoTranslateLocalizationPath: normalizeLocalizationPath(settings.autoTranslateLocalizationPath),
  autoTranslateRequestTimeoutSeconds: normalizeAutoTranslateRequestTimeoutSeconds(
    settings.autoTranslateRequestTimeoutSeconds,
  ),
  autoTranslateLanguages: normalizeAutoTranslateLanguages(settings.autoTranslateLanguages),
});
