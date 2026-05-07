import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGES,
  DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  normalizeAutoTranslateLanguages,
  normalizeAutoTranslateSettings,
  resolveAutoTranslateLanguage,
  shouldTranslateAutoTranslateLanguage,
} from "../auto-translate";

describe("auto translate settings", () => {
  it("keeps English US fixed as the first fallback language", () => {
    const languages = normalizeAutoTranslateLanguages([
      { name: "German", code: "de" },
      { name: "Renamed English", code: "en-us" },
      { name: "Duplicate German", code: "DE" },
      { name: "Portuguese (Brazil)", code: "pt_br" },
    ]);

    expect(languages[0]).toEqual({
      name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
      code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
    });
    expect(languages).toContainEqual({ name: "German", code: "de" });
    expect(languages).toContainEqual({ name: "Portuguese (Brazil)", code: "pt-BR" });
    expect(languages.filter((language) => language.code.toLowerCase() === "de")).toHaveLength(1);
  });

  it("uses the translation default model and language list when settings are missing", () => {
    const settings = normalizeAutoTranslateSettings({});

    expect(settings.enabled).toBe(false);
    expect(settings.openRouterModel).toBe(DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL);
    expect(settings.languages).toEqual(DEFAULT_AUTO_TRANSLATE_LANGUAGES);
  });

  it("falls back to English US unless a configured non-default language is selected while enabled", () => {
    const settings = normalizeAutoTranslateSettings({
      enabled: true,
      languages: [
        { name: "English (US)", code: "en-US" },
        { name: "German", code: "de" },
      ],
    });

    const english = resolveAutoTranslateLanguage(settings, "missing");
    const german = resolveAutoTranslateLanguage(settings, "DE");

    expect(english.code).toBe(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE);
    expect(shouldTranslateAutoTranslateLanguage(settings, english)).toBe(false);
    expect(german).toEqual({ name: "German", code: "de" });
    expect(shouldTranslateAutoTranslateLanguage(settings, german)).toBe(true);
  });
});
