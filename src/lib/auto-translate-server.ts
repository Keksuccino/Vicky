import { createHash } from "node:crypto";

import { shouldTranslateAutoTranslateLanguage } from "@/lib/auto-translate";
import { translatedDocsPageCache, translatedDocsTitleCache } from "@/lib/cache";
import { ApiError } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { requestOpenRouterChatCompletion } from "@/lib/openrouter";
import type {
  AutoTranslateLanguage,
  AutoTranslateSettings,
  GitHubDocPage,
  GitHubDocTreeItem,
  GitHubRuntimeConfig,
} from "@/lib/types";
import { toRuntimeConfigCacheKey } from "@/lib/github";

export const AUTO_TRANSLATE_SYSTEM_PROMPT = `You are a professional Markdown documentation page translator.
You translate docs pages to natural sounding translations for the larget language, easy to understand for people who speak the target language.
You use a chill and non-formal, yet professional sounding tone for translations. For example, for German you would use neutral sounding "Du" wording for the translation.
You should preserve Markdown formatting when translating pages, including embedded images, etc..
You get pages as JSON array with page title, page description and page content. Translate all 3, then return the translated content as the same JSON array syntax, but with translated values. Only return the JSON array, nothing else!`;

type PageTranslationPayload = {
  page_display_name: string;
  page_description: string;
  page_content: string;
};

type TitleTranslationPayload = {
  page_slug: string;
  page_display_name: string;
};

const pageTranslationLoads = new Map<string, Promise<GitHubDocPage>>();
const titleTranslationLoads = new Map<string, Promise<Map<string, string>>>();

const hashValue = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

const translationSettingsHash = (language: AutoTranslateLanguage, model: string): string =>
  hashValue({
    languageCode: language.code,
    languageName: language.name,
    model,
  });

const pageTranslationCacheKey = (
  config: GitHubRuntimeConfig,
  page: GitHubDocPage,
  language: AutoTranslateLanguage,
  model: string,
): string =>
  [
    toRuntimeConfigCacheKey(config),
    "auto-translate",
    "page",
    translationSettingsHash(language, model),
    page.slug,
    page.sha,
  ].join("|");

const titleTranslationCacheKey = (
  config: GitHubRuntimeConfig,
  items: GitHubDocTreeItem[],
  language: AutoTranslateLanguage,
  model: string,
): string =>
  [
    toRuntimeConfigCacheKey(config),
    "auto-translate",
    "titles",
    translationSettingsHash(language, model),
    hashValue(items.map((item) => ({ slug: item.slug, path: item.path, name: item.name }))),
  ].join("|");

const stripJsonCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
};

const parseJsonResponse = (value: string): unknown => {
  const normalized = stripJsonCodeFence(value);

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    const firstArrayIndex = normalized.indexOf("[");
    const lastArrayIndex = normalized.lastIndexOf("]");
    if (firstArrayIndex >= 0 && lastArrayIndex > firstArrayIndex) {
      try {
        return JSON.parse(normalized.slice(firstArrayIndex, lastArrayIndex + 1)) as unknown;
      } catch {
        // Try an object payload below before returning a translation-specific API error.
      }
    }

    const firstObjectIndex = normalized.indexOf("{");
    const lastObjectIndex = normalized.lastIndexOf("}");
    if (firstObjectIndex >= 0 && lastObjectIndex > firstObjectIndex) {
      try {
        return JSON.parse(normalized.slice(firstObjectIndex, lastObjectIndex + 1)) as unknown;
      } catch {
        // Fall through to the normalized API error below.
      }
    }

    throw new ApiError(502, "OpenRouter returned translation JSON that could not be parsed.");
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const normalizePageTranslationResponse = (value: string): PageTranslationPayload => {
  const parsed = parseJsonResponse(value);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const record = asRecord(first);
  const title = record.page_display_name;
  const description = record.page_description;
  const content = record.page_content;

  if (typeof title !== "string" || typeof description !== "string" || typeof content !== "string") {
    throw new ApiError(502, "OpenRouter returned an invalid page translation payload.");
  }

  return {
    page_display_name: title.trim(),
    page_description: description.trim(),
    page_content: content,
  };
};

const normalizeTitleTranslationResponse = (
  value: string,
  sourceItems: GitHubDocTreeItem[],
): Map<string, string> => {
  const parsed = parseJsonResponse(value);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const sourceSlugs = new Set(sourceItems.map((item) => item.slug));
  const titles = new Map<string, string>();

  for (const entry of entries) {
    const record = asRecord(entry);
    const slug = typeof record.page_slug === "string" ? record.page_slug.trim() : "";
    const title = typeof record.page_display_name === "string" ? record.page_display_name.trim() : "";

    if (!slug || !title || !sourceSlugs.has(slug)) {
      continue;
    }

    titles.set(slug, title);
  }

  if (titles.size === 0 && sourceItems.length > 0) {
    throw new ApiError(502, "OpenRouter returned an invalid title translation payload.");
  }

  return titles;
};

const buildPageTranslationPrompt = (targetLanguageDisplayName: string, page: GitHubDocPage): string => {
  const payload: PageTranslationPayload[] = [
    {
      page_display_name: page.title,
      page_description: page.description,
      page_content: page.content,
    },
  ];

  return `Please translate the following page to ${targetLanguageDisplayName}. Return only the translated JSON array, nothing else:

${JSON.stringify(payload, null, 2)}`;
};

const buildTitleTranslationPrompt = (targetLanguageDisplayName: string, items: GitHubDocTreeItem[]): string => {
  const payload: TitleTranslationPayload[] = items.map((item) => ({
    page_slug: item.slug,
    page_display_name: item.name,
  }));

  return `Please translate the following page titles to ${targetLanguageDisplayName}. Keep all page_slug values unchanged and untranslated. Return only the translated JSON array, nothing else:

${JSON.stringify(payload, null, 2)}`;
};

const createTranslatedDocPage = (sourcePage: GitHubDocPage, translation: PageTranslationPayload): GitHubDocPage => {
  const translatedMarkdown = serializeMarkdownDocument({
    title: translation.page_display_name || sourcePage.title,
    description: translation.page_description,
    content: translation.page_content,
    includeInPlaintextExport: sourcePage.includeInPlaintextExport,
  });
  const parsed = parseMarkdownDocument(translatedMarkdown);

  return {
    ...sourcePage,
    title: parsed.title,
    description: parsed.description,
    content: parsed.content,
    markdown: translatedMarkdown,
    headings: parsed.headings,
  };
};

export const getCachedTranslatedDocPage = (
  config: GitHubRuntimeConfig,
  sourcePage: GitHubDocPage,
  language: AutoTranslateLanguage,
  model: string,
): GitHubDocPage | null => {
  const key = pageTranslationCacheKey(config, sourcePage, language, model);
  return (translatedDocsPageCache.get(key) as GitHubDocPage | undefined) ?? null;
};

export const translateGitHubDocPage = async ({
  apiKey,
  config,
  language,
  model,
  origin,
  settings,
  siteTitle,
  sourcePage,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  model: string;
  origin: string;
  settings: AutoTranslateSettings;
  siteTitle: string;
  sourcePage: GitHubDocPage;
}): Promise<GitHubDocPage> => {
  if (!shouldTranslateAutoTranslateLanguage(settings, language)) {
    return sourcePage;
  }

  const key = pageTranslationCacheKey(config, sourcePage, language, model);
  const cached = translatedDocsPageCache.get(key) as GitHubDocPage | undefined;
  if (cached) {
    return cached;
  }

  const pending = pageTranslationLoads.get(key);
  if (pending) {
    return pending;
  }

  const loadPromise = requestOpenRouterChatCompletion({
    apiKey,
    model,
    origin,
    siteTitle,
    messages: [
      {
        role: "system",
        content: AUTO_TRANSLATE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildPageTranslationPrompt(language.name, sourcePage),
      },
    ],
  })
    .then((text) => {
      const translatedPage = createTranslatedDocPage(sourcePage, normalizePageTranslationResponse(text));
      translatedDocsPageCache.set(key, translatedPage);
      return translatedPage;
    })
    .finally(() => {
      if (pageTranslationLoads.get(key) === loadPromise) {
        pageTranslationLoads.delete(key);
      }
    });

  pageTranslationLoads.set(key, loadPromise);
  return loadPromise;
};

export const translateGitHubDocTreeTitles = async ({
  apiKey,
  config,
  items,
  language,
  model,
  origin,
  pages,
  settings,
  siteTitle,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
  origin: string;
  pages: GitHubDocPage[];
  settings: AutoTranslateSettings;
  siteTitle: string;
}): Promise<GitHubDocTreeItem[]> => {
  if (!shouldTranslateAutoTranslateLanguage(settings, language) || items.length === 0) {
    return items;
  }

  const sourcePageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const fullPageTranslatedTitles = new Map<string, string>();

  for (const item of items) {
    const sourcePage = sourcePageBySlug.get(item.slug);
    const fullTranslation = sourcePage ? getCachedTranslatedDocPage(config, sourcePage, language, model) : null;

    if (fullTranslation?.title.trim()) {
      fullPageTranslatedTitles.set(item.slug, fullTranslation.title.trim());
    }
  }

  let titleOnlyTranslations = new Map<string, string>();
  const key = titleTranslationCacheKey(config, items, language, model);
  const cached = translatedDocsTitleCache.get(key) as Map<string, string> | undefined;

  if (cached) {
    titleOnlyTranslations = cached;
  } else {
    const pending = titleTranslationLoads.get(key);
    if (pending) {
      titleOnlyTranslations = await pending;
    } else {
      const loadPromise = requestOpenRouterChatCompletion({
        apiKey,
        model,
        origin,
        siteTitle,
        messages: [
          {
            role: "system",
            content: AUTO_TRANSLATE_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: buildTitleTranslationPrompt(language.name, items),
          },
        ],
      })
        .then((text) => {
          const translations = normalizeTitleTranslationResponse(text, items);
          translatedDocsTitleCache.set(key, translations);
          return translations;
        })
        .finally(() => {
          if (titleTranslationLoads.get(key) === loadPromise) {
            titleTranslationLoads.delete(key);
          }
        });

      titleTranslationLoads.set(key, loadPromise);
      titleOnlyTranslations = await loadPromise;
    }
  }

  return items.map((item) => ({
    ...item,
    name:
      fullPageTranslatedTitles.get(item.slug) ??
      titleOnlyTranslations.get(item.slug) ??
      item.name,
  }));
};
