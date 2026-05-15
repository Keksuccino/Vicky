import { createHash } from "node:crypto";

import {
  normalizeAutoTranslateLanguageCode,
  shouldTranslateAutoTranslateLanguage,
} from "@/lib/auto-translate";
import {
  formatAutoTranslateLanguageForLog,
  getAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { translatedDocsPageCache, translatedDocsTitleCache } from "@/lib/cache";
import { ApiError } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { requestOpenRouterChatCompletion } from "@/lib/openrouter";
import {
  readPersistentTitleTranslations,
  readPersistentTitleTranslationsSync,
  readPersistentTranslatedPage,
  readPersistentTranslatedPageSync,
  writePersistentTitleTranslations,
  writePersistentTranslatedPage,
} from "@/lib/translation-cache-store";
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

const logLanguageContext = (language: AutoTranslateLanguage): string => formatAutoTranslateLanguageForLog(language);

type TranslationQueueState = {
  pageQueues: Map<string, Map<string, Promise<GitHubDocPage>>>;
  titleQueues: Map<string, Map<string, Promise<Map<string, string>>>>;
};

const TRANSLATION_QUEUE_STATE_KEY = Symbol.for("vicky.autoTranslate.translationQueueState");

const getTranslationQueueState = (): TranslationQueueState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, TranslationQueueState | undefined>;
  let state = globalState[TRANSLATION_QUEUE_STATE_KEY];

  if (!state) {
    state = {
      pageQueues: new Map(),
      titleQueues: new Map(),
    };
    globalState[TRANSLATION_QUEUE_STATE_KEY] = state;
  }

  return state;
};

const languageQueueKey = (language: AutoTranslateLanguage): string =>
  normalizeAutoTranslateLanguageCode(language.code).toLowerCase();

const pageTranslationQueueKey = (config: GitHubRuntimeConfig, page: GitHubDocPage): string =>
  [toRuntimeConfigCacheKey(config), "auto-translate", "page-queue", page.slug || page.path].join("|");

const titleTranslationQueueKey = (config: GitHubRuntimeConfig): string =>
  [toRuntimeConfigCacheKey(config), "auto-translate", "title-queue"].join("|");

const runQueuedTranslation = <T>({
  getCached,
  languageKey,
  queues,
  queueKey,
  task,
}: {
  getCached: () => T | null;
  languageKey: string;
  queues: Map<string, Map<string, Promise<T>>>;
  queueKey: string;
  task: () => Promise<T>;
}): Promise<T> => {
  const cached = getCached();
  if (cached) {
    return Promise.resolve(cached);
  }

  let queue = queues.get(queueKey);
  if (!queue) {
    queue = new Map();
    queues.set(queueKey, queue);
  }

  const pending = queue.get(languageKey);
  if (pending) {
    return pending.then(() => {
      const cachedAfterPending = getCached();
      if (cachedAfterPending) {
        return cachedAfterPending;
      }

      return runQueuedTranslation({
        getCached,
        languageKey,
        queues,
        queueKey,
        task,
      });
    });
  }

  const loadPromise = Promise.resolve()
    .then(async () => {
      const cachedBeforeRequest = getCached();
      if (cachedBeforeRequest) {
        return cachedBeforeRequest;
      }

      return task();
    })
    .finally(() => {
      const currentQueue = queues.get(queueKey);
      if (currentQueue?.get(languageKey) !== loadPromise) {
        return;
      }

      currentQueue.delete(languageKey);
      if (currentQueue.size === 0) {
        queues.delete(queueKey);
      }
    });

  queue.set(languageKey, loadPromise);
  return loadPromise;
};

export type GitHubDocPageTranslationRequestResult = {
  totalPages: number;
  cachedPages: number;
  requestedPages: number;
  translatedPages: number;
  failedPages: number;
  failures: Array<{
    slug: string;
    path: string;
    error: string;
  }>;
};

export type GitHubDocPageTranslationCacheStatus = {
  totalPages: number;
  cachedPages: number;
};

const hashValue = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

const translationTargetHash = (language: AutoTranslateLanguage): string =>
  hashValue({
    languageCode: normalizeAutoTranslateLanguageCode(language.code).toLowerCase(),
  });

const legacyTranslationSettingsHash = (language: AutoTranslateLanguage, model: string): string =>
  hashValue({
    languageCode: language.code,
    languageName: language.name,
    model,
  });

// Paid translations stay valid for the same target language/source page until the exact source content changes.
// GitHub fetch SHAs, model choices, and display-name tweaks must not invalidate them.
const pageSourceContentHash = (page: GitHubDocPage): string => hashValue(page.markdown);

const pageTranslationCacheKey = (
  config: GitHubRuntimeConfig,
  page: GitHubDocPage,
  language: AutoTranslateLanguage,
): string =>
  [
    toRuntimeConfigCacheKey(config),
    "auto-translate",
    "page",
    translationTargetHash(language),
    page.slug,
    pageSourceContentHash(page),
  ].join("|");

const legacyPageTranslationCacheKey = (
  config: GitHubRuntimeConfig,
  page: GitHubDocPage,
  language: AutoTranslateLanguage,
  model: string,
): string =>
  [
    toRuntimeConfigCacheKey(config),
    "auto-translate",
    "page",
    legacyTranslationSettingsHash(language, model),
    page.slug,
    page.sha,
  ].join("|");

const pageTranslationCacheKeys = (
  config: GitHubRuntimeConfig,
  page: GitHubDocPage,
  language: AutoTranslateLanguage,
  model: string,
): string[] => {
  const currentKey = pageTranslationCacheKey(config, page, language);
  const legacyKey = legacyPageTranslationCacheKey(config, page, language, model);
  return currentKey === legacyKey ? [currentKey] : [currentKey, legacyKey];
};

const titleSourceContentHash = (items: GitHubDocTreeItem[]): string =>
  hashValue(items.map((item) => ({ slug: item.slug, path: item.path, name: item.name })));

const titleTranslationCacheKey = (
  config: GitHubRuntimeConfig,
  items: GitHubDocTreeItem[],
  language: AutoTranslateLanguage,
): string =>
  [
    toRuntimeConfigCacheKey(config),
    "auto-translate",
    "titles",
    translationTargetHash(language),
    titleSourceContentHash(items),
  ].join("|");

const legacyTitleTranslationCacheKey = (
  config: GitHubRuntimeConfig,
  items: GitHubDocTreeItem[],
  language: AutoTranslateLanguage,
  model: string,
): string =>
  [
    toRuntimeConfigCacheKey(config),
    "auto-translate",
    "titles",
    legacyTranslationSettingsHash(language, model),
    titleSourceContentHash(items),
  ].join("|");

const titleTranslationCacheKeys = (
  config: GitHubRuntimeConfig,
  items: GitHubDocTreeItem[],
  language: AutoTranslateLanguage,
  model: string,
): string[] => {
  const currentKey = titleTranslationCacheKey(config, items, language);
  const legacyKey = legacyTitleTranslationCacheKey(config, items, language, model);
  return currentKey === legacyKey ? [currentKey] : [currentKey, legacyKey];
};

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

const getCachedTitleTranslations = ({
  config,
  items,
  language,
  model,
}: {
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
}): Map<string, string> | null => {
  const keys = titleTranslationCacheKeys(config, items, language, model);
  const key = keys[0];

  for (const cacheKey of keys) {
    const cached = translatedDocsTitleCache.get(cacheKey) as Map<string, string> | undefined;
    if (cached) {
      translatedDocsTitleCache.set(key, cached);
      return cached;
    }
  }

  for (const cacheKey of keys) {
    const persisted = readPersistentTitleTranslationsSync(cacheKey);
    if (persisted) {
      translatedDocsTitleCache.set(key, persisted);
      logAutoTranslateInfo("Loaded sidebar title translations from persistent cache", {
        language: logLanguageContext(language),
        pages: items.length,
        cacheKeyType: cacheKey === key ? "current" : "legacy",
      });
      return persisted;
    }
  }

  return null;
};

const loadTitleOnlyTranslations = async ({
  apiKey,
  config,
  items,
  language,
  model,
  origin,
  requestTimeoutMs,
  siteTitle,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
  origin: string;
  requestTimeoutMs: number;
  siteTitle: string;
}): Promise<Map<string, string>> => {
  const queueState = getTranslationQueueState();

  return runQueuedTranslation({
    getCached: () => getCachedTitleTranslations({ config, items, language, model }),
    languageKey: languageQueueKey(language),
    queues: queueState.titleQueues,
    queueKey: titleTranslationQueueKey(config),
    task: async () => {
      const keys = titleTranslationCacheKeys(config, items, language, model);
      const key = keys[0];

      try {
        for (const cacheKey of keys) {
          const persisted = await readPersistentTitleTranslations(cacheKey);
          if (persisted) {
            translatedDocsTitleCache.set(key, persisted);
            logAutoTranslateInfo("Loaded sidebar title translations from persistent cache", {
              language: logLanguageContext(language),
              pages: items.length,
              cacheKeyType: cacheKey === key ? "current" : "legacy",
            });

            if (cacheKey !== key) {
              const migrated = await writePersistentTitleTranslations(key, persisted);
              if (migrated) {
                logAutoTranslateInfo("Updated persistent sidebar title translation cache key", {
                  language: logLanguageContext(language),
                  pages: items.length,
                });
              }
            }

            return persisted;
          }
        }

        logAutoTranslateInfo("Requesting sidebar title translations", {
          language: logLanguageContext(language),
          pages: items.length,
          model,
        });

        const text = await requestOpenRouterChatCompletion({
          apiKey,
          model,
          origin,
          siteTitle,
          timeoutMs: requestTimeoutMs,
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
        });

        const translations = normalizeTitleTranslationResponse(text, items);
        const persisted = await writePersistentTitleTranslations(key, translations);
        if (!persisted) {
          throw new ApiError(500, "Failed to persist translated docs title cache.");
        }

        translatedDocsTitleCache.set(key, translations);
        logAutoTranslateInfo("Wrote persistent sidebar title translation cache", {
          language: logLanguageContext(language),
          pages: items.length,
        });
        logAutoTranslateInfo("Translated docs sidebar titles", {
          language: logLanguageContext(language),
          pages: items.length,
          model,
        });
        return translations;
      } catch (error: unknown) {
        logAutoTranslateInfo("Sidebar title translation failed", {
          language: logLanguageContext(language),
          pages: items.length,
          model,
          error: getAutoTranslateErrorMessage(error),
        });
        throw error;
      }
    },
  });
};

const applyTreeTitleTranslations = (
  items: GitHubDocTreeItem[],
  translations: Map<string, string>,
): GitHubDocTreeItem[] =>
  items.map((item) => ({
    ...item,
    name: translations.get(item.slug) ?? item.name,
  }));

export const applyCachedTranslatedDocTreeTitles = ({
  config,
  items,
  language,
  model,
  settings,
}: {
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
  settings: AutoTranslateSettings;
}): GitHubDocTreeItem[] => {
  if (!shouldTranslateAutoTranslateLanguage(settings, language) || items.length === 0 || !model.trim()) {
    return items;
  }

  const keys = titleTranslationCacheKeys(config, items, language, model);
  const key = keys[0];

  for (const cacheKey of keys) {
    const cached = translatedDocsTitleCache.get(cacheKey) as Map<string, string> | undefined;
    if (cached) {
      translatedDocsTitleCache.set(key, cached);
      return applyTreeTitleTranslations(items, cached);
    }
  }

  for (const cacheKey of keys) {
    const persisted = readPersistentTitleTranslationsSync(cacheKey);
    if (persisted) {
      translatedDocsTitleCache.set(key, persisted);
      logAutoTranslateInfo("Loaded sidebar title translations from persistent cache", {
        language: logLanguageContext(language),
        pages: items.length,
        cacheKeyType: cacheKey === key ? "current" : "legacy",
      });
      return applyTreeTitleTranslations(items, persisted);
    }
  }

  return items;
};

export const hasCachedTranslatedDocTreeTitles = ({
  config,
  items,
  language,
  model,
  settings,
}: {
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
  settings: AutoTranslateSettings;
}): boolean => {
  if (!shouldTranslateAutoTranslateLanguage(settings, language) || items.length === 0 || !model.trim()) {
    return true;
  }

  const keys = titleTranslationCacheKeys(config, items, language, model);
  const key = keys[0];

  for (const cacheKey of keys) {
    const cached = translatedDocsTitleCache.get(cacheKey) as Map<string, string> | undefined;
    if (cached) {
      translatedDocsTitleCache.set(key, cached);
      return true;
    }
  }

  for (const cacheKey of keys) {
    const persisted = readPersistentTitleTranslationsSync(cacheKey);
    if (persisted) {
      translatedDocsTitleCache.set(key, persisted);
      logAutoTranslateInfo("Loaded sidebar title translations from persistent cache", {
        language: logLanguageContext(language),
        pages: items.length,
        cacheKeyType: cacheKey === key ? "current" : "legacy",
      });
      return true;
    }
  }

  return false;
};

export const warmTranslatedDocTreeTitles = ({
  apiKey,
  config,
  items,
  language,
  model,
  origin,
  settings,
  siteTitle,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
  origin: string;
  settings: AutoTranslateSettings;
  siteTitle: string;
}): void => {
  if (!shouldTranslateAutoTranslateLanguage(settings, language) || items.length === 0 || !apiKey.trim() || !model.trim()) {
    return;
  }

  void loadTranslatedDocTreeTitles({
    apiKey,
    config,
    items,
    language,
    model,
    origin,
    settings,
    siteTitle,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[auto-translate] Failed to warm docs sidebar title translations for ${language.name} (${language.code}): ${message}`,
    );
  });
};

export const loadTranslatedDocTreeTitles = async ({
  apiKey,
  config,
  items,
  language,
  model,
  origin,
  settings,
  siteTitle,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  items: GitHubDocTreeItem[];
  language: AutoTranslateLanguage;
  model: string;
  origin: string;
  settings: AutoTranslateSettings;
  siteTitle: string;
}): Promise<GitHubDocTreeItem[]> => {
  if (!shouldTranslateAutoTranslateLanguage(settings, language) || items.length === 0 || !apiKey.trim() || !model.trim()) {
    return items;
  }

  const translations = await loadTitleOnlyTranslations({
    apiKey,
    config,
    items,
    language,
    model,
    origin,
    requestTimeoutMs: settings.requestTimeoutMs,
    siteTitle,
  });

  return applyTreeTitleTranslations(items, translations);
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

const withSourcePageRuntimeFields = (translatedPage: GitHubDocPage, sourcePage: GitHubDocPage): GitHubDocPage => ({
  ...translatedPage,
  path: sourcePage.path,
  slug: sourcePage.slug,
  sha: sourcePage.sha,
  includeInPlaintextExport: sourcePage.includeInPlaintextExport,
  updatedAt: sourcePage.updatedAt ?? translatedPage.updatedAt,
  updatedBy: sourcePage.updatedBy ?? translatedPage.updatedBy,
});

export const getCachedTranslatedDocPage = (
  config: GitHubRuntimeConfig,
  sourcePage: GitHubDocPage,
  language: AutoTranslateLanguage,
  model: string,
): GitHubDocPage | null => {
  const keys = pageTranslationCacheKeys(config, sourcePage, language, model);
  const key = keys[0];

  for (const cacheKey of keys) {
    const cached = translatedDocsPageCache.get(cacheKey) as GitHubDocPage | undefined;
    if (cached) {
      translatedDocsPageCache.set(key, cached);
      return withSourcePageRuntimeFields(cached, sourcePage);
    }
  }

  for (const cacheKey of keys) {
    const persisted = readPersistentTranslatedPageSync(cacheKey);
    if (persisted) {
      translatedDocsPageCache.set(key, persisted);
      logAutoTranslateInfo("Loaded page translation from persistent cache", {
        language: logLanguageContext(language),
        slug: sourcePage.slug,
        path: sourcePage.path,
        cacheKeyType: cacheKey === key ? "current" : "legacy",
      });
      return withSourcePageRuntimeFields(persisted, sourcePage);
    }
  }

  return null;
};

export const getGitHubDocPageTranslationCacheStatus = ({
  config,
  language,
  model,
  pages,
}: {
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  model: string;
  pages: GitHubDocPage[];
}): GitHubDocPageTranslationCacheStatus => {
  const normalizedModel = model.trim();

  if (!normalizedModel || pages.length === 0) {
    return {
      totalPages: pages.length,
      cachedPages: 0,
    };
  }

  return {
    totalPages: pages.length,
    cachedPages: pages.reduce(
      (count, page) => count + (getCachedTranslatedDocPage(config, page, language, normalizedModel) ? 1 : 0),
      0,
    ),
  };
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

  const queueState = getTranslationQueueState();
  const loadPromise = runQueuedTranslation({
    getCached: () => getCachedTranslatedDocPage(config, sourcePage, language, model),
    languageKey: languageQueueKey(language),
    queues: queueState.pageQueues,
    queueKey: pageTranslationQueueKey(config, sourcePage),
    task: async () => {
      const keys = pageTranslationCacheKeys(config, sourcePage, language, model);
      const key = keys[0];

      try {
        for (const cacheKey of keys) {
          const persisted = await readPersistentTranslatedPage(cacheKey);
          if (persisted) {
            translatedDocsPageCache.set(key, persisted);
            logAutoTranslateInfo("Loaded page translation from persistent cache", {
              language: logLanguageContext(language),
              slug: sourcePage.slug,
              path: sourcePage.path,
              cacheKeyType: cacheKey === key ? "current" : "legacy",
            });

            if (cacheKey !== key) {
              const migrated = await writePersistentTranslatedPage(key, persisted);
              if (migrated) {
                logAutoTranslateInfo("Updated persistent page translation cache key", {
                  language: logLanguageContext(language),
                  slug: sourcePage.slug,
                  path: sourcePage.path,
                });
              }
            }

            return persisted;
          }
        }

        logAutoTranslateInfo("Requesting page translation", {
          language: logLanguageContext(language),
          slug: sourcePage.slug,
          path: sourcePage.path,
          model,
        });

        const text = await requestOpenRouterChatCompletion({
          apiKey,
          model,
          origin,
          siteTitle,
          timeoutMs: settings.requestTimeoutMs,
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
        });

        const translatedPage = createTranslatedDocPage(sourcePage, normalizePageTranslationResponse(text));
        const persisted = await writePersistentTranslatedPage(key, translatedPage);
        if (!persisted) {
          throw new ApiError(500, "Failed to persist translated docs page cache.");
        }

        translatedDocsPageCache.set(key, translatedPage);
        logAutoTranslateInfo("Wrote persistent page translation cache", {
          language: logLanguageContext(language),
          slug: sourcePage.slug,
          path: sourcePage.path,
        });
        logAutoTranslateInfo("Translated docs page", {
          language: logLanguageContext(language),
          slug: sourcePage.slug,
          path: sourcePage.path,
          model,
        });
        return translatedPage;
      } catch (error: unknown) {
        logAutoTranslateInfo("Page translation failed", {
          language: logLanguageContext(language),
          slug: sourcePage.slug,
          path: sourcePage.path,
          model,
          error: getAutoTranslateErrorMessage(error),
        });
        throw error;
      }
    },
  });

  return loadPromise.then((translatedPage) => withSourcePageRuntimeFields(translatedPage, sourcePage));
};

export const translateMissingGitHubDocPages = async ({
  apiKey,
  config,
  language,
  model,
  origin,
  pages,
  settings,
  siteTitle,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  model: string;
  origin: string;
  pages: GitHubDocPage[];
  settings: AutoTranslateSettings;
  siteTitle: string;
}): Promise<GitHubDocPageTranslationRequestResult> => {
  const pagesToTranslate = pages.filter((page) => !getCachedTranslatedDocPage(config, page, language, model));
  logAutoTranslateInfo("Prepared missing page translations", {
    language: logLanguageContext(language),
    totalPages: pages.length,
    cachedPages: pages.length - pagesToTranslate.length,
    requestedPages: pagesToTranslate.length,
    model,
  });

  const results = await Promise.allSettled(
    pagesToTranslate.map((sourcePage) =>
      translateGitHubDocPage({
        apiKey,
        config,
        language,
        model,
        origin,
        settings,
        siteTitle,
        sourcePage,
      }),
    ),
  );

  const failures: GitHubDocPageTranslationRequestResult["failures"] = [];
  let translatedPages = 0;

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      translatedPages += 1;
      return;
    }

    const sourcePage = pagesToTranslate[index];
    const reason = result.reason;
    logAutoTranslateInfo("Bulk page translation item failed", {
      language: logLanguageContext(language),
      slug: sourcePage.slug,
      path: sourcePage.path,
      error: getAutoTranslateErrorMessage(reason),
    });
    failures.push({
      slug: sourcePage.slug,
      path: sourcePage.path,
      error: getAutoTranslateErrorMessage(reason),
    });
  });

  const output = {
    totalPages: pages.length,
    cachedPages: pages.length - pagesToTranslate.length,
    requestedPages: pagesToTranslate.length,
    translatedPages,
    failedPages: failures.length,
    failures,
  };

  logAutoTranslateInfo("Finished missing page translations", {
    language: logLanguageContext(language),
    totalPages: output.totalPages,
    cachedPages: output.cachedPages,
    requestedPages: output.requestedPages,
    translatedPages: output.translatedPages,
    failedPages: output.failedPages,
    model,
  });

  return output;
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

  const titleOnlyTranslations = await loadTitleOnlyTranslations({
    apiKey,
    config,
    items,
    language,
    model,
    origin,
    requestTimeoutMs: settings.requestTimeoutMs,
    siteTitle,
  });

  return items.map((item) => ({
    ...item,
    name:
      fullPageTranslatedTitles.get(item.slug) ??
      titleOnlyTranslations.get(item.slug) ??
      item.name,
  }));
};
