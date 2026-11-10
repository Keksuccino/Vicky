import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  resolveAutoTranslateLanguage,
} from "@/lib/auto-translate";
import {
  formatAutoTranslateLanguageForLog,
  getAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import {
  listMarkdownDocsTree,
  loadPublicGitHubDoc,
} from "@/lib/github";
import { assertGitHubCacheAccess, beginGitHubCacheAccess } from "@/lib/github-cache-invalidation";
import {
  renderGitHubDocPageMarkdown,
  type RenderedGitHubDocPage,
} from "@/lib/markdown-server-renderer";
import {
  isSourceLanguage,
  loadLocalizedPageForSource,
  loadLocalizedTreeItems,
  resolveServedLocalizedPage,
} from "@/lib/page-localization-read";
import type {
  AutoTranslateLanguage,
  DocsStore,
  GitHubDocPage,
  GitHubDocTreeItem,
  GitHubRuntimeConfig,
  MarkdownHeading,
} from "@/lib/types";

/**
 * Public docs loaders. They take no admission permit themselves: each public request takes
 * exactly one at its boundary (route handler or initial page render) through
 * `withPublicDocsAdmission`, however many of these loaders it calls.
 */

export type DocsPageWithSourceHeadings = GitHubDocPage & {
  sourceHeadings?: MarkdownHeading[];
};

export type RenderedDocsPageWithSourceHeadings = RenderedGitHubDocPage & {
  sourceHeadings?: MarkdownHeading[];
};

export type DocsLanguageData<T> = {
  data: T;
  language: AutoTranslateLanguage;
  contentLanguageCode?: string;
  titlesPending?: boolean;
};

const warnPageFallback = (language: AutoTranslateLanguage, error: unknown): void => {
  const message = getAutoTranslateErrorMessage(error);
  logAutoTranslateInfo("Serving source page because page translation failed", {
    language: formatAutoTranslateLanguageForLog(language),
    error: message,
  });
  console.warn(
    `[page-localization] Failed to load docs page localization for ${language.name} (${language.code}); serving source page. ${message}`,
  );
};

export const loadDocsPageForLanguage = async ({
  config,
  locator,
  requestedLanguageCode,
  signal,
  store,
}: {
  config: GitHubRuntimeConfig;
  locator: { slug?: string; path?: string };
  requestedLanguageCode?: string;
  signal?: AbortSignal;
  store: DocsStore;
}): Promise<DocsLanguageData<DocsPageWithSourceHeadings>> => {
  const access = beginGitHubCacheAccess(config);
  const sourcePage = await loadPublicGitHubDoc(config, locator, { signal });
  const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);

  if (isSourceLanguage(language)) {
    return {
      data: sourcePage,
      language,
      contentLanguageCode: language.code,
    };
  }

  try {
    const localized = await loadLocalizedPageForSource({
      config,
      language,
      localizationPath: store.settings.autoTranslate.localizationPath,
      sourcePage,
    });
    const servedPage = resolveServedLocalizedPage(localized, language);
    assertGitHubCacheAccess(access);
    const contentLanguageCode = servedPage.sourceLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE : language.code;

    return {
      data: servedPage.sourceLanguage ? servedPage : { ...servedPage, sourceHeadings: localized.sourcePage.headings },
      language,
      contentLanguageCode,
    };
  } catch (error: unknown) {
    assertGitHubCacheAccess(access);
    warnPageFallback(language, error);
    return {
      data: sourcePage,
      language,
      contentLanguageCode: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
    };
  }
};

export const loadRenderedDocsPageForLanguage = async (params: {
  config: GitHubRuntimeConfig;
  locator: { slug?: string; path?: string };
  requestedLanguageCode?: string;
  signal?: AbortSignal;
  store: DocsStore;
}): Promise<DocsLanguageData<RenderedDocsPageWithSourceHeadings>> => {
  const access = beginGitHubCacheAccess(params.config);
  const pageResult = await loadDocsPageForLanguage(params);
  const renderedPage = await renderGitHubDocPageMarkdown({
    config: params.config,
    languageCode: pageResult.contentLanguageCode ?? pageResult.language.code,
    page: pageResult.data,
  });
  assertGitHubCacheAccess(access);

  return {
    ...pageResult,
    data: renderedPage,
  };
};

/**
 * Sidebar items of a language. Translated titles come from the localization title index, never
 * from page bodies; while the store still downloads some, `titlesPending` is set and
 * `waitForPendingTitles` (a client title refresh) waits a bounded time for them.
 */
export const loadDocsTreeForLanguage = async ({
  config,
  requestedLanguageCode,
  store,
  waitForPendingTitles,
}: {
  config: GitHubRuntimeConfig;
  requestedLanguageCode?: string;
  store: DocsStore;
  waitForPendingTitles?: boolean;
}): Promise<DocsLanguageData<GitHubDocTreeItem[]>> => {
  const access = beginGitHubCacheAccess(config);
  const sourceItems = await listMarkdownDocsTree(config);
  const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);

  try {
    const { items, titlesPending } = await loadLocalizedTreeItems({
      config,
      language,
      localizationPath: store.settings.autoTranslate.localizationPath,
      sourceItems,
      waitForPendingTitles,
    });
    assertGitHubCacheAccess(access);

    return { data: items, language, titlesPending };
  } catch (error: unknown) {
    assertGitHubCacheAccess(access);
    const message = getAutoTranslateErrorMessage(error);
    logAutoTranslateInfo("Serving source sidebar titles because localized title loading failed", {
      language: formatAutoTranslateLanguageForLog(language),
      error: message,
    });

    return { data: sourceItems, language, titlesPending: false };
  }
};
