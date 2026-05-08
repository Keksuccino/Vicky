"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { CircleFlagIcon } from "@/components/circle-flag-icon";
import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import type { AutoTranslateLanguage } from "@/components/types";
import {
  AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT,
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { normalizeCircleFlagIconId } from "@/lib/circle-flags";

const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const ICON_ONLY_LANGUAGE_SELECTOR_QUERY = "(max-width: 760px)";

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

const getLanguageIconId = (language: AutoTranslateLanguage): string =>
  normalizeCircleFlagIconId(language.icon) || getDefaultAutoTranslateLanguageIcon(language.code);

const getLanguageSearchText = (language: AutoTranslateLanguage): string =>
  `${language.name} ${language.code} ${language.icon}`.toLowerCase();

export function LanguageSelector({ enabled, languages }: LanguageSelectorProps) {
  const availableLanguages = useMemo(
    () =>
      languages.length > 0
        ? languages
        : [
            {
              name: "English (US)",
              code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
              icon: "us",
            },
          ],
    [languages],
  );
  const [selectedLanguageCode, setSelectedLanguageCode] = useState(() =>
    resolveLanguageCode(availableLanguages, readCookie(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [isIconOnly, setIsIconOnly] = useState(false);
  const [query, setQuery] = useState("");
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const resolvedSelectedLanguageCode = resolveLanguageCode(availableLanguages, selectedLanguageCode);
  const selectedLanguage =
    availableLanguages.find((language) => languageCodesEqual(language.code, resolvedSelectedLanguageCode)) ??
    availableLanguages[0];
  const selectedIconId = getLanguageIconId(selectedLanguage);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleLanguages = useMemo(
    () =>
      normalizedQuery
        ? availableLanguages.filter((language) => getLanguageSearchText(language).includes(normalizedQuery))
        : availableLanguages,
    [availableLanguages, normalizedQuery],
  );

  useEffect(() => {
    const nextLanguageCode = enabled
      ? resolveLanguageCode(availableLanguages, selectedLanguageCode)
      : DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

    writeCookie(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME, nextLanguageCode);
    dispatchLanguageChange(nextLanguageCode);
  }, [availableLanguages, enabled, selectedLanguageCode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(ICON_ONLY_LANGUAGE_SELECTOR_QUERY);
    const updateIconOnlyState = () => setIsIconOnly(mediaQuery.matches);

    updateIconOnlyState();
    mediaQuery.addEventListener("change", updateIconOnlyState);

    return () => {
      mediaQuery.removeEventListener("change", updateIconOnlyState);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      setQuery("");
      return;
    }

    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });

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
        className={cn("btn btn-pill language-selector-button", isIconOnly && "ui-tooltip")}
        aria-label={`Docs language: ${selectedLanguage.name}`}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        data-ui-tooltip={isIconOnly ? `Docs language: ${selectedLanguage.name}` : undefined}
        onClick={() => {
          setMenuOpen((previous) => !previous);
        }}
      >
        <CircleFlagIcon iconId={selectedIconId} />
        <span className="language-selector-label">{selectedLanguage.name}</span>
        <MaterialIcon name="arrow_drop_down" />
      </button>

      {menuOpen ? (
        <div className="language-selector-menu circle-flag-picker-popover" role="dialog" aria-label="Docs language">
          <div className="search-input-wrap circle-flag-picker-search language-selector-search">
            <MaterialIcon name="search" className="search-icon" />
            <input
              ref={searchInputRef}
              className="input"
              value={query}
              aria-label="Search languages"
              placeholder="Search language"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div
            className="circle-flag-picker-options language-selector-options"
            role="listbox"
            aria-label="Available docs languages"
          >
            {visibleLanguages.length > 0 ? (
              visibleLanguages.map((language) => {
                const selected = languageCodesEqual(language.code, resolvedSelectedLanguageCode);
                const languageIconId = getLanguageIconId(language);

                return (
                  <button
                    key={language.code}
                    type="button"
                    className={cn(
                      "circle-flag-picker-option language-selector-menu-item",
                      selected && "circle-flag-picker-option-selected",
                    )}
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      const nextLanguageCode = resolveLanguageCode(availableLanguages, language.code);
                      setSelectedLanguageCode(nextLanguageCode);
                      setMenuOpen(false);
                    }}
                  >
                    <CircleFlagIcon iconId={languageIconId} />
                    <span>{language.name}</span>
                    <code>{language.code}</code>
                  </button>
                );
              })
            ) : (
              <p className="circle-flag-picker-empty">No languages found</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
