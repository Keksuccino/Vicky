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
  listMarkdownDocsTreePagesWithTitles,
  loadGitHubDoc,
} from "@/lib/github";
import {
  renderGitHubDocPageMarkdown,
  type RenderedGitHubDocPage,
} from "@/lib/markdown-server-renderer";
import {
  isSourceLanguage,
  loadCurrentLocalizedTreeItems,
  loadLocalizedPageForSource,
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
  store,
}: {
  config: GitHubRuntimeConfig;
  locator: { slug?: string; path?: string };
  requestedLanguageCode?: string;
  store: DocsStore;
}): Promise<DocsLanguageData<DocsPageWithSourceHeadings>> => {
  const sourcePage = await loadGitHubDoc(config, locator);
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
    const contentLanguageCode = servedPage.sourceLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE : language.code;

    return {
      data: servedPage.sourceLanguage ? servedPage : { ...servedPage, sourceHeadings: localized.sourcePage.headings },
      language,
      contentLanguageCode,
    };
  } catch (error: unknown) {
    warnPageFallback(language, error);
    return {
      data: sourcePage,
      language,
      contentLanguageCode: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
    };
  }
};

export const loadRenderedDocsPageForLanguage = async ({
  config,
  locator,
  requestedLanguageCode,
  store,
}: {
  config: GitHubRuntimeConfig;
  locator: { slug?: string; path?: string };
  requestedLanguageCode?: string;
  store: DocsStore;
}): Promise<DocsLanguageData<RenderedDocsPageWithSourceHeadings>> => {
  const pageResult = await loadDocsPageForLanguage({
    config,
    locator,
    requestedLanguageCode,
    store,
  });
  const renderedPage = await renderGitHubDocPageMarkdown({
    config,
    languageCode: pageResult.contentLanguageCode ?? pageResult.language.code,
    page: pageResult.data,
  });

  return {
    ...pageResult,
    data: renderedPage,
  };
};

export const loadDocsTreeForLanguage = async (params: {
  config: GitHubRuntimeConfig;
  requestedLanguageCode?: string;
  store: DocsStore;
  waitForTitleIndex?: boolean;
}): Promise<DocsLanguageData<GitHubDocTreeItem[]>> => {
  const { config, requestedLanguageCode, store } = params;
  const { items: sourceItems, pages } = await listMarkdownDocsTreePagesWithTitles(config);
  const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);

  if (isSourceLanguage(language)) {
    return {
      data: sourceItems,
      language,
      titlesPending: false,
    };
  }

  try {
    const localizedItems = await loadCurrentLocalizedTreeItems({
      config,
      language,
      localizationPath: store.settings.autoTranslate.localizationPath,
      sourcePages: pages,
    });
    const data = sourceItems.map((item) => localizedItems.get(item.slug) ?? item);

    return {
      data,
      language,
      titlesPending: false,
    };
  } catch (error: unknown) {
    const message = getAutoTranslateErrorMessage(error);
    logAutoTranslateInfo("Serving source sidebar titles because localized title loading failed", {
      language: formatAutoTranslateLanguageForLog(language),
      error: message,
    });

    return {
      data: sourceItems,
      language,
      titlesPending: false,
    };
  }
};
