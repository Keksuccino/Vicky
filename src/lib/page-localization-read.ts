import { isDefaultAutoTranslateLanguageCode } from "@/lib/auto-translate";
import {
  loadGitHubLocalizationSnapshot,
  loadGitHubLocalizedDoc,
  type GitHubLocalizedDocResult,
  type GitHubLocalizationPageStatus,
} from "@/lib/github";
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

export const isLocalizedPageOutdated = (
  sourcePage: Pick<GitHubDocPage, "updatedAt">,
  localizedPage: Pick<GitHubLocalizationPageStatus, "updatedAt">,
): boolean => {
  const sourceTime = sourcePage.updatedAt ? Date.parse(sourcePage.updatedAt) : Number.NaN;
  const translationTime = localizedPage.updatedAt ? Date.parse(localizedPage.updatedAt) : Number.NaN;

  return Number.isFinite(sourceTime) && Number.isFinite(translationTime) && sourceTime > translationTime;
};

export const loadCurrentLocalizedTreeItems = async ({
  config,
  language,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<Map<string, GitHubDocTreeItem>> => {
  if (isSourceLanguage(language)) {
    return new Map();
  }

  const snapshot = await loadGitHubLocalizationSnapshot({ config, language, localizationPath, sourcePages });
  const sourcePageByPath = new Map(sourcePages.map((page) => [page.path, page]));
  const output = new Map<string, GitHubDocTreeItem>();

  for (const page of snapshot.pages) {
    const sourcePage = sourcePageByPath.get(page.path);
    if (!sourcePage || isLocalizedPageOutdated(sourcePage, page)) {
      continue;
    }

    output.set(page.slug, {
      path: page.path,
      slug: page.slug,
      name: page.title.trim() || page.slug,
    });
  }

  return output;
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
