"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { MaterialIcon } from "@/components/material-icon";
import type { AutoTranslateLanguage } from "@/components/types";
import {
  AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT,
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  isDefaultAutoTranslateLanguageCode,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";

const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

type LanguageSelectorProps = {
  enabled: boolean;
  languages: AutoTranslateLanguage[];
};

const readCookie = (name: string): string => {
  if (typeof document === "undefined") {
    return "";
  }

  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
};

const writeCookie = (name: string, value: string): void => {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
};

const dispatchLanguageChange = (languageCode: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT, {
      detail: {
        languageCode,
      },
    }),
  );
};

const resolveLanguageCode = (languages: AutoTranslateLanguage[], value: string): string => {
  const normalized = normalizeAutoTranslateLanguageCode(value);
  const fallback =
    languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code))?.code ??
    DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

  if (!normalized) {
    return fallback;
  }

  return languages.find((language) => languageCodesEqual(language.code, normalized))?.code ?? fallback;
};

export function LanguageSelector({ enabled, languages }: LanguageSelectorProps) {
  const availableLanguages = useMemo(
    () =>
      languages.length > 0
        ? languages
        : [
            {
              name: "English (US)",
              code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
            },
          ],
    [languages],
  );
  const [selectedLanguageCode, setSelectedLanguageCode] = useState(() =>
    resolveLanguageCode(availableLanguages, readCookie(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const resolvedSelectedLanguageCode = resolveLanguageCode(availableLanguages, selectedLanguageCode);
  const selectedLanguage =
    availableLanguages.find((language) => languageCodesEqual(language.code, resolvedSelectedLanguageCode)) ??
    availableLanguages[0];

  useEffect(() => {
    const nextLanguageCode = enabled
      ? resolveLanguageCode(availableLanguages, selectedLanguageCode)
      : DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

    writeCookie(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME, nextLanguageCode);
    dispatchLanguageChange(nextLanguageCode);
  }, [availableLanguages, enabled, selectedLanguageCode]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node) || selectorRef.current?.contains(eventTarget)) {
        return;
      }

      setMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (!enabled) {
    return null;
  }

  return (
    <div className="language-selector" ref={selectorRef}>
      <button
        type="button"
        className="btn btn-pill language-selector-button"
        aria-label={`Docs language: ${selectedLanguage.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen((previous) => !previous);
        }}
      >
        <MaterialIcon name="translate" />
        <span className="language-selector-label">{selectedLanguage.name}</span>
        <MaterialIcon name="arrow_drop_down" />
      </button>

      {menuOpen ? (
        <div className="language-selector-menu" role="menu" aria-label="Docs language">
          {availableLanguages.map((language) => {
            const selected = languageCodesEqual(language.code, resolvedSelectedLanguageCode);

            return (
              <button
                key={language.code}
                type="button"
                className="language-selector-menu-item"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  const nextLanguageCode = resolveLanguageCode(availableLanguages, language.code);
                  setSelectedLanguageCode(nextLanguageCode);
                  setMenuOpen(false);
                }}
              >
                <MaterialIcon name={selected ? "check" : "language"} />
                <span>{language.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
