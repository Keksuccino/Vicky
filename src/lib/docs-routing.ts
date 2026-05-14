import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import type { AutoTranslateLanguage } from "@/lib/types";

export type ParsedDocsRoute = {
  languageCode?: string;
  pagePath: string;
};

export const normalizeDocsPagePath = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.(md|mdx)$/i, "");

  return normalized ? `/${normalized}` : "/";
};

export const findConfiguredDocsLanguage = (
  languages: AutoTranslateLanguage[],
  value: string | null | undefined,
): AutoTranslateLanguage | null => {
  const normalized = normalizeAutoTranslateLanguageCode(value);
  if (!normalized) {
    return null;
  }

  return languages.find((language) => languageCodesEqual(language.code, normalized)) ?? null;
};

export const parseDocsRoutePath = (
  requestedPath: string,
  languages: AutoTranslateLanguage[],
): ParsedDocsRoute => {
  const normalizedPath = normalizeDocsPagePath(requestedPath);
  const segments = normalizedPath.replace(/^\/+/, "").split("/").filter(Boolean);
  const language = findConfiguredDocsLanguage(languages, segments[0]);

  if (!language) {
    return {
      pagePath: normalizedPath,
    };
  }

  return {
    languageCode: language.code,
    pagePath: normalizeDocsPagePath(segments.slice(1).join("/")),
  };
};

export const docsHrefForPagePath = (
  pagePath: string,
  languageCode?: string,
): string => {
  const normalizedPath = normalizeDocsPagePath(pagePath);
  const normalizedLanguage = normalizeAutoTranslateLanguageCode(languageCode) || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
  const prefix = `/docs/${normalizedLanguage}`;

  if (normalizedPath === "/") {
    return prefix;
  }

  return `${prefix}${normalizedPath}`;
};
