import { isDefaultAutoTranslateLanguageCode } from "@/lib/auto-translate";
import {
  loadGitHubLocalizationOverview,
  loadGitHubLocalizedDoc,
  loadGitHubLocalizedTitles,
  type GitHubLocalizationStatus,
  type GitHubLocalizedDocResult,
} from "@/lib/github-localization";
import type { AutoTranslateLanguage, GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig } from "@/lib/types";

export type PageLocalizationLanguageStatus = {
  languageCode: string;
  languageName: string;
  sourceLanguage: boolean;
  currentPages: number;
  missingPages: number;
  outdatedPages: number;
  /** Translations whose state is not known until the running language load fetched them; never in a job's statuses. */
  pendingPages: number;
  totalPages: number;
  /** Current translations (by commit dates) that do not record their source version yet; recording it makes their status exact. */
  unrecordedPages: number;
};

/** A language of the admin overview; `loading` reports the blob downloads of its running language load. */
export type PageLocalizationOverviewStatus = PageLocalizationLanguageStatus & {
  loading: { downloaded: number; total: number } | null;
};

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
 * Per-language counts for the admin status: undetermined translations count as current, as
 * readers serve them; `unrecordedPages` counts the current ones the stamping action can record.
 * Source pages listed in `pendingPaths` of a language count as pending instead of missing.
 */
export const summarizePageLocalizationStatuses = (
  languages: AutoTranslateLanguage[],
  sourcePages: readonly GitHubDocPage[],
  localizations: Map<string, Map<string, GitHubLocalizationStatus>>,
  pendingPaths?: Map<string, Set<string>>,
): PageLocalizationLanguageStatus[] =>
  languages.map((language) => {
    const base = { languageCode: language.code, languageName: language.name, totalPages: sourcePages.length, pendingPages: 0 };
    if (isSourceLanguage(language)) {
      return { ...base, sourceLanguage: true, currentPages: sourcePages.length, missingPages: 0, outdatedPages: 0, unrecordedPages: 0 };
    }

    const byPath = localizations.get(language.code);
    const pending = pendingPaths?.get(language.code);
    const status = { ...base, sourceLanguage: false, currentPages: 0, missingPages: 0, outdatedPages: 0, unrecordedPages: 0 };
    for (const sourcePage of sourcePages) {
      const localization = byPath?.get(sourcePage.path);
      if (!localization) {
        if (pending?.has(sourcePage.path)) {
          status.pendingPages += 1;
        } else {
          status.missingPages += 1;
        }
      } else if (localization.state === "outdated") {
        status.outdatedPages += 1;
      } else {
        status.currentPages += 1;
        if (localization.state === "current" && localization.summary && !localization.summary.sourceBlobSha) {
          status.unrecordedPages += 1;
        }
      }
    }
    return status;
  });

/**
 * Status of every configured language for the admin Page Localization card, without a job: from
 * the repository index and the stored blob summaries, never from page bodies, and without waiting
 * for GitHub (see `loadGitHubLocalizationOverview`). The source language counts all source pages.
 */
export const loadPageLocalizationOverview = async ({
  config,
  languages,
  localizationPath,
}: {
  config: GitHubRuntimeConfig;
  languages: AutoTranslateLanguage[];
  localizationPath: string;
}): Promise<PageLocalizationOverviewStatus[]> => {
  const targetLanguages = languages.filter((language) => !isSourceLanguage(language));
  const overview = await loadGitHubLocalizationOverview({ config, languageCodes: targetLanguages.map((language) => language.code), localizationPath });
  const statuses = summarizePageLocalizationStatuses(
    languages,
    overview.sourcePages,
    new Map(Array.from(overview.languages, ([code, language]) => [code, language.statuses])),
    new Map(Array.from(overview.languages, ([code, language]) => [code, language.pendingPaths])),
  );
  return statuses.map((status) => ({ ...status, loading: overview.languages.get(status.languageCode)?.loading ?? null }));
};

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
