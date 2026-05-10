import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  resolveAutoTranslateLanguage,
  shouldTranslateAutoTranslateLanguage,
} from "@/lib/auto-translate";
import {
  formatAutoTranslateLanguageForLog,
  getAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import {
  applyCachedTranslatedDocTreeTitles,
  hasCachedTranslatedDocTreeTitles,
  loadTranslatedDocTreeTitles,
  translateGitHubDocPage,
  warmTranslatedDocTreeTitles,
} from "@/lib/auto-translate-server";
import { decryptSecret } from "@/lib/encryption";
import {
  listMarkdownDocsTreeWithTitleStatus,
  loadGitHubDoc,
  warmMarkdownDocsTitleIndex,
} from "@/lib/github";
import {
  renderGitHubDocPageMarkdown,
  type RenderedGitHubDocPage,
} from "@/lib/markdown-server-renderer";
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
    `[auto-translate] Failed to translate docs page to ${language.name} (${language.code}); serving source English page. ${message}`,
  );
};

const warnTreeFallback = (language: AutoTranslateLanguage, error: unknown): void => {
  const message = getAutoTranslateErrorMessage(error);
  logAutoTranslateInfo("Serving source sidebar titles because title translation failed", {
    language: formatAutoTranslateLanguageForLog(language),
    error: message,
  });
  console.warn(
    `[auto-translate] Failed to translate docs sidebar titles to ${language.name} (${language.code}); serving source English titles. ${message}`,
  );
};

export const loadDocsPageForLanguage = async ({
  config,
  locator,
  origin,
  requestedLanguageCode,
  store,
}: {
  config: GitHubRuntimeConfig;
  locator: { slug?: string; path?: string };
  origin: string;
  requestedLanguageCode?: string;
  store: DocsStore;
}): Promise<DocsLanguageData<DocsPageWithSourceHeadings>> => {
  const sourcePage = await loadGitHubDoc(config, locator);
  const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);
  const shouldTranslate = shouldTranslateAutoTranslateLanguage(store.settings.autoTranslate, language);
  const apiKeyEncrypted = store.settings.openRouter.apiKeyEncrypted;
  const model = store.settings.autoTranslate.openRouterModel.trim();

  if (!shouldTranslate) {
    return {
      data: sourcePage,
      language,
      contentLanguageCode: language.code,
    };
  }

  if (!apiKeyEncrypted || !model) {
    warnPageFallback(language, new Error("Auto-translate is not fully configured."));
    return {
      data: sourcePage,
      language,
      contentLanguageCode: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
    };
  }

  try {
    const translatedPage = await translateGitHubDocPage({
      apiKey: decryptSecret(apiKeyEncrypted).trim(),
      config,
      language,
      model,
      origin,
      settings: store.settings.autoTranslate,
      siteTitle: store.settings.siteTitle || "Vicky Docs",
      sourcePage,
    });

    return {
      data: { ...translatedPage, sourceHeadings: sourcePage.headings },
      language,
      contentLanguageCode: language.code,
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
  origin,
  requestedLanguageCode,
  store,
}: {
  config: GitHubRuntimeConfig;
  locator: { slug?: string; path?: string };
  origin: string;
  requestedLanguageCode?: string;
  store: DocsStore;
}): Promise<DocsLanguageData<RenderedDocsPageWithSourceHeadings>> => {
  const pageResult = await loadDocsPageForLanguage({
    config,
    locator,
    origin,
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

export const loadDocsTreeForLanguage = async ({
  config,
  origin,
  requestedLanguageCode,
  store,
  waitForTitleIndex,
}: {
  config: GitHubRuntimeConfig;
  origin: string;
  requestedLanguageCode?: string;
  store: DocsStore;
  waitForTitleIndex?: boolean;
}): Promise<DocsLanguageData<GitHubDocTreeItem[]>> => {
  const treeResult = await listMarkdownDocsTreeWithTitleStatus(config, { waitForTitleIndex });
  const sourceItems = treeResult.items;
  const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);
  const shouldTranslate = shouldTranslateAutoTranslateLanguage(store.settings.autoTranslate, language);
  const apiKeyEncrypted = store.settings.openRouter.apiKeyEncrypted;
  const model = store.settings.autoTranslate.openRouterModel.trim();

  if (!shouldTranslate) {
    return {
      data: sourceItems,
      language,
      titlesPending: !treeResult.titleIndexReady,
    };
  }

  if (!apiKeyEncrypted || !model) {
    warnTreeFallback(language, new Error("Auto-translate is not fully configured."));
    return {
      data: sourceItems,
      language,
      titlesPending: !treeResult.titleIndexReady,
    };
  }

  try {
    const apiKey = decryptSecret(apiKeyEncrypted).trim();
    const warmTranslations = (titleItems: GitHubDocTreeItem[]) => {
      warmTranslatedDocTreeTitles({
        apiKey,
        config,
        items: titleItems,
        language,
        model,
        origin,
        settings: store.settings.autoTranslate,
        siteTitle: store.settings.siteTitle || "Vicky Docs",
      });
    };

    if (treeResult.titleIndexReady) {
      if (waitForTitleIndex) {
        const translatedItems = await loadTranslatedDocTreeTitles({
          apiKey,
          config,
          items: sourceItems,
          language,
          model,
          origin,
          settings: store.settings.autoTranslate,
          siteTitle: store.settings.siteTitle || "Vicky Docs",
        });

        return {
          data: translatedItems,
          language,
          titlesPending: false,
        };
      }

      warmTranslations(sourceItems);
    } else {
      void warmMarkdownDocsTitleIndex(config)
        .then((titleItems) => {
          warmTranslations(titleItems);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[docs] Failed to warm translated docs tree titles: ${message}`);
        });
    }

    return {
      data: applyCachedTranslatedDocTreeTitles({
        config,
        items: sourceItems,
        language,
        model,
        settings: store.settings.autoTranslate,
      }),
      language,
      titlesPending:
        !treeResult.titleIndexReady ||
        !hasCachedTranslatedDocTreeTitles({
          config,
          items: sourceItems,
          language,
          model,
          settings: store.settings.autoTranslate,
        }),
    };
  } catch (error: unknown) {
    warnTreeFallback(language, error);
    return {
      data: sourceItems,
      language,
      titlesPending: true,
    };
  }
};
