import { isDefaultAutoTranslateLanguageCode } from "@/lib/auto-translate";
import { loadGitHubLocalizedDoc, loadGitHubLocalizedTitles, type GitHubLocalizedDocResult } from "@/lib/github-localization";
import type { AutoTranslateLanguage, GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig } from "@/lib/types";

const sourceFallbackPage = (sourcePage: GitHubDocPage, languageCode: string, status: "missing" | "outdated"): GitHubDocPage => ({
  ...sourcePage,
  languageCode,
  sourceLanguage: true,
  sourcePath: sourcePage.path,
  sourceSlug: sourcePage.slug,
  sourceUpdatedAt: sourcePage.updatedAt,
  translationStale: status === "outdated",
  localizationStatus: status,
});

export const isSourceLanguage = (language: Pick<AutoTranslateLanguage, "code">): boolean =>
  isDefaultAutoTranslateLanguageCode(language.code);

/**
 * Sidebar items of a language: source items whose page has a current translation carry the
 * translated title. `titlesPending` reports titles the store is still downloading.
 */
export const loadLocalizedTreeItems = async ({
  config,
  language,
  localizationPath,
  sourceItems,
  waitForPendingTitles,
}: {
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  localizationPath: string;
  sourceItems: GitHubDocTreeItem[];
  waitForPendingTitles?: boolean;
}): Promise<{ items: GitHubDocTreeItem[]; titlesPending: boolean }> => {
  if (isSourceLanguage(language)) {
    return { items: sourceItems, titlesPending: false };
  }

  const { pending, titles } = await loadGitHubLocalizedTitles({ config, languageCode: language.code, localizationPath, waitForPending: waitForPendingTitles });
  return {
    items: sourceItems.map((item) => {
      const title = titles.get(item.slug);
      return title ? { ...item, name: title } : item;
    }),
    titlesPending: pending,
  };
};

/**
 * Public page delivery is deliberately read-only. Missing or stale localizations are
 * refreshed only by the authenticated translation job, never while serving a page.
 */
export const loadLocalizedPageForSource = async ({
  config,
  language,
  localizationPath,
  sourcePage,
}: {
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  localizationPath: string;
  sourcePage: GitHubDocPage;
}): Promise<GitHubLocalizedDocResult> => {
  if (isSourceLanguage(language)) {
    return {
      sourcePage,
      page: {
        ...sourcePage,
        languageCode: language.code,
        sourceLanguage: true,
        localizationStatus: "source",
      },
      status: "current",
      localizedRepoPath: sourcePage.path,
    };
  }

  return loadGitHubLocalizedDoc({ config, language, localizationPath, sourcePage });
};

export const resolveServedLocalizedPage = (localized: GitHubLocalizedDocResult, language: AutoTranslateLanguage): GitHubDocPage => {
  if (localized.page && localized.status === "current") {
    return {
      ...localized.page,
      languageCode: language.code,
      sourceLanguage: false,
      localizationStatus: "current",
    };
  }

  return sourceFallbackPage(localized.sourcePage, language.code, localized.status === "outdated" ? "outdated" : "missing");
};
