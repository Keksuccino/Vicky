import path from "node:path";

import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguages,
} from "@/lib/auto-translate";
import { yieldToEventLoop } from "@/lib/background-jobs";
import { renderedMarkdownCache, setDocsCacheTtlMs } from "@/lib/cache";
import { resolveRuntimeConfig } from "@/lib/github";
import { assertGitHubCacheAccess, beginGitHubCacheAccess, trackGitHubCacheWrite } from "@/lib/github-cache-invalidation";
import { hashMarkdownContent, loadGitHubBlobs, loadStoredGitHubBlobSummaries } from "@/lib/github-content-store";
import { getGitHubDocsCacheDir } from "@/lib/github-docs-cache-files";
import { loadGitHubDocsSourceView } from "@/lib/github-docs-source";
import { listCurrentGitHubLocalizations } from "@/lib/github-localization";
import { badRequest } from "@/lib/http";
import {
  deletePersistentRenderedMarkdownWhere,
  getPersistentRenderedMarkdownCacheDir,
  getRenderedMarkdownCacheLastMutation,
  listPersistentRenderedMarkdownCacheEntries,
  hasPersistentRenderedMarkdown,
  recordRenderedMarkdownCacheMutation,
  writePersistentRenderedMarkdown,
  type PersistedRenderedMarkdown,
  type RenderedMarkdownCacheMutation,
} from "@/lib/markdown-render-cache-store";
import { MARKDOWN_RENDER_VERSION } from "@/lib/markdown-rendering-shared";
import {
  markdownRenderCacheKey,
  markdownRenderCachePrefix,
  renderMarkdownToHtml,
} from "@/lib/markdown-server-renderer";
import { getStore } from "@/lib/store";
import type { AutoTranslateLanguage, DocsStore, GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

const markdownExtensionRegex = /\.(md|mdx)$/i;

export type MarkdownRenderCacheLanguageStatus = {
  cached: boolean;
  contentHash: string;
  headingCount: number;
  htmlBytes: number;
  languageCode: string;
  languageName: string;
  savedAt: string | null;
  sourceLanguage: boolean;
};

export type MarkdownRenderCachePageStatus = {
  cachedVariants: number;
  languages: MarkdownRenderCacheLanguageStatus[];
  path: string;
  slug: string;
  title: string;
  totalVariants: number;
};

export type MarkdownRenderCacheStatus = {
  cacheDirectory: string;
  cachedVariants: number;
  currentSourceHtmlBytes: number;
  currentSourceEntries: number;
  globalEntries: number;
  globalHtmlBytes: number;
  globalStaleEntries: number;
  lastMutation: RenderedMarkdownCacheMutation | null;
  otherSourceEntries: number;
  processId: number;
  rendererVersion: string;
  sourcePagesCached: number;
  staleEntries: number;
  totalHtmlBytes: number;
  totalPages: number;
  totalVariants: number;
  translatedVariants: number;
  uncachedVariants: number;
  updatedAt: string;
  pages: MarkdownRenderCachePageStatus[];
};

export type MarkdownRenderCacheClearResult = {
  clearedEntries: number;
  scope: "all" | "page";
  slug?: string;
};

/** One rendered-HTML variant: a source page in the source language or one of its current translations. */
export type MarkdownRenderCacheVariant = {
  /** Unset while a translation's blob is not in the store yet; such a variant cannot have been rendered. */
  contentHash?: string;
  language: AutoTranslateLanguage;
  /** The source page; translations are cached under its slug. */
  page: GitHubDocPage;
  /** Blob of the variant's content. */
  sha: string;
  sourceLanguage: boolean;
};

/** The settings and docs source the cache admin routes work on. */
export const loadMarkdownRenderCacheContext = async (): Promise<{ config: GitHubRuntimeConfig; store: DocsStore }> => {
  const store = await getStore();
  setDocsCacheTtlMs(store.settings.docsCacheTtlMs);

  return {
    config: resolveRuntimeConfig(store.settings.github),
    store,
  };
};

const sourceLanguage = (): AutoTranslateLanguage => ({
  name: DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  code: DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  icon: getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE),
  enabled: true,
});

const uniqueLanguagesByCode = (languages: AutoTranslateLanguage[]): AutoTranslateLanguage[] => {
  const seenCodes = new Set<string>();
  const output: AutoTranslateLanguage[] = [];

  for (const language of languages) {
    const code = normalizeAutoTranslateLanguageCode(language.code);
    const codeKey = code.toLowerCase();
    if (!code || seenCodes.has(codeKey)) {
      continue;
    }

    seenCodes.add(codeKey);
    output.push({
      ...language,
      code,
    });
  }

  return output;
};

const normalizeMarkdownCacheSlug = (value: string): string => {
  const trimmed = value.trim().replace(/\\+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const withoutExtension = trimmed.replace(markdownExtensionRegex, "");
  const normalized = path.posix.normalize(withoutExtension);

  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("|")
  ) {
    throw badRequest("Invalid docs page slug.");
  }

  return normalized;
};

const markdownRenderCacheKeyMatchesSlug = (
  config: GitHubRuntimeConfig,
  slug: string,
  key: string,
): boolean => {
  const prefix = markdownRenderCachePrefix(config);
  if (!key.startsWith(prefix)) {
    return false;
  }

  const parts = key.slice(prefix.length).split("|");
  return parts.length >= 4 && parts[1] === slug;
};

const variantCacheKey = (config: GitHubRuntimeConfig, variant: MarkdownRenderCacheVariant, contentHash: string): string =>
  markdownRenderCacheKey({ config, contentHash, languageCode: variant.language.code, slug: variant.page.slug });

/**
 * Lists the variants of every source page from the docs view, the blob summaries, and the
 * stored commit metadata. Reads no page body and makes no GitHub request beyond what loading
 * the docs view itself needs (none while it is current).
 */
const buildMarkdownRenderCacheVariants = async ({
  config,
  store,
}: {
  config: GitHubRuntimeConfig;
  store: DocsStore;
}): Promise<{ pages: GitHubDocPage[]; variants: MarkdownRenderCacheVariant[] }> => {
  const access = beginGitHubCacheAccess(config);
  const view = await loadGitHubDocsSourceView(config);
  const languages = uniqueLanguagesByCode(normalizeAutoTranslateLanguages(store.settings.autoTranslate.languages));
  const defaultLanguage = languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code)) ?? sourceLanguage();
  const translatedLanguages = languages.filter((language) => !isDefaultAutoTranslateLanguageCode(language.code));
  const [sourceSummaries, localizations] = await Promise.all([
    loadStoredGitHubBlobSummaries(view.pages.map((page) => page.sha), getGitHubDocsCacheDir()),
    listCurrentGitHubLocalizations({
      config,
      languageCodes: translatedLanguages.map((language) => language.code),
      localizationPath: store.settings.autoTranslate.localizationPath,
      view,
    }),
  ]);
  const variants: MarkdownRenderCacheVariant[] = [];

  for (const page of view.pages) {
    variants.push({
      contentHash: sourceSummaries.get(page.sha)?.contentHash ?? hashMarkdownContent(page.content),
      language: defaultLanguage,
      page,
      sha: page.sha,
      sourceLanguage: true,
    });

    for (const language of translatedLanguages) {
      const localization = localizations.get(language.code)?.get(page.path);
      if (localization) {
        variants.push({ contentHash: localization.summary?.contentHash, language, page, sha: localization.sha, sourceLanguage: false });
      }
    }
  }

  assertGitHubCacheAccess(access);

  return {
    pages: view.pages,
    variants,
  };
};

export const createMarkdownRenderCacheStatus = async ({
  config,
  store,
}: {
  config: GitHubRuntimeConfig;
  store: DocsStore;
}): Promise<MarkdownRenderCacheStatus> => {
  const access = beginGitHubCacheAccess(config);
  const prefix = markdownRenderCachePrefix(config);
  const [allCacheEntries, lastMutation, variantData] = await Promise.all([
    listPersistentRenderedMarkdownCacheEntries(),
    getRenderedMarkdownCacheLastMutation(),
    buildMarkdownRenderCacheVariants({ config, store }),
  ]);
  const cacheEntries = allCacheEntries.filter((entry) => entry.key.startsWith(prefix));
  const cacheEntriesByKey = new Map(cacheEntries.map((entry) => [entry.key, entry]));
  const expectedKeys = new Set<string>();
  const variantsBySlug = new Map<string, MarkdownRenderCacheLanguageStatus[]>();
  let cachedVariants = 0;
  let sourcePagesCached = 0;
  let translatedVariants = 0;
  let totalHtmlBytes = 0;

  for (const variant of variantData.variants) {
    const cacheKey = variant.contentHash ? variantCacheKey(config, variant, variant.contentHash) : null;
    const persisted = cacheKey ? cacheEntriesByKey.get(cacheKey) ?? null : null;
    const cached = Boolean(persisted);
    if (cacheKey) {
      expectedKeys.add(cacheKey);
    }

    if (cached) {
      cachedVariants += 1;
      totalHtmlBytes += persisted?.htmlBytes ?? 0;
    }

    if (cached && variant.sourceLanguage) {
      sourcePagesCached += 1;
    }

    if (!variant.sourceLanguage) {
      translatedVariants += 1;
    }

    const statuses = variantsBySlug.get(variant.page.slug) ?? [];
    statuses.push({
      cached,
      contentHash: variant.contentHash ?? "",
      headingCount: persisted?.headingCount ?? 0,
      htmlBytes: persisted?.htmlBytes ?? 0,
      languageCode: variant.language.code,
      languageName: variant.language.name,
      savedAt: persisted?.savedAt ?? null,
      sourceLanguage: variant.sourceLanguage,
    });
    variantsBySlug.set(variant.page.slug, statuses);
  }

  const pages = variantData.pages.map((page): MarkdownRenderCachePageStatus => {
    const languages = variantsBySlug.get(page.slug) ?? [];
    const pageCachedVariants = languages.reduce((count, language) => count + (language.cached ? 1 : 0), 0);

    return {
      cachedVariants: pageCachedVariants,
      languages,
      path: page.path,
      slug: page.slug,
      title: page.title.trim() || page.slug,
      totalVariants: languages.length,
    };
  });
  const totalVariants = variantData.variants.length;
  const staleEntries = cacheEntries.reduce((count, entry) => count + (expectedKeys.has(entry.key) ? 0 : 1), 0);
  const globalStaleEntries = allCacheEntries.reduce((count, entry) => count + (expectedKeys.has(entry.key) ? 0 : 1), 0);
  const currentSourceHtmlBytes = cacheEntries.reduce((bytes, entry) => bytes + entry.htmlBytes, 0);
  const globalHtmlBytes = allCacheEntries.reduce((bytes, entry) => bytes + entry.htmlBytes, 0);
  assertGitHubCacheAccess(access);

  return {
    cacheDirectory: getPersistentRenderedMarkdownCacheDir(),
    cachedVariants,
    currentSourceHtmlBytes,
    currentSourceEntries: cacheEntries.length,
    globalEntries: allCacheEntries.length,
    globalHtmlBytes,
    globalStaleEntries,
    lastMutation,
    otherSourceEntries: Math.max(0, allCacheEntries.length - cacheEntries.length),
    processId: process.pid,
    rendererVersion: MARKDOWN_RENDER_VERSION,
    sourcePagesCached,
    staleEntries,
    totalHtmlBytes,
    totalPages: variantData.pages.length,
    totalVariants,
    translatedVariants,
    uncachedVariants: Math.max(0, totalVariants - cachedVariants),
    updatedAt: new Date().toISOString(),
    pages,
  };
};

/** The variants a warm run renders, and how it renders one; see `planMarkdownRenderCacheWarm`. */
export type MarkdownRenderCacheWarmPlan = {
  /** Variants without stored HTML when the plan was made. */
  missing: MarkdownRenderCacheVariant[];
  totalPages: number;
  totalVariants: number;
  /**
   * Loads, renders, and stores one variant: `"rendered"`, or `"cached"` when its HTML was stored
   * meanwhile (a page view rendered it). Throws when it fails, with a 409 `ApiError` once the docs
   * source changed, which ends the run.
   */
  warm: (variant: MarkdownRenderCacheVariant) => Promise<"cached" | "rendered">;
};

/**
 * Plans rendering the HTML that is missing for the current docs, from the index of the cache
 * alone (no entry is opened). Bodies are loaded one variant at a time and dropped after rendering;
 * translations the store lacks are downloaded here, the only place the cache card fetches page
 * content. Rendering is synchronous CPU work, so `warm` renders one variant at a time, each after
 * a turn of the event loop: callers may load several variants at once, and requests still get
 * answered between two renders.
 */
export const planMarkdownRenderCacheWarm = async ({
  config,
  store,
}: {
  config: GitHubRuntimeConfig;
  store: DocsStore;
}): Promise<MarkdownRenderCacheWarmPlan> => {
  const access = beginGitHubCacheAccess(config);
  const baseDir = getGitHubDocsCacheDir();
  const { pages, variants } = await buildMarkdownRenderCacheVariants({ config, store });
  const isCached = async (cacheKey: string): Promise<boolean> => {
    const cached = await hasPersistentRenderedMarkdown(cacheKey);
    assertGitHubCacheAccess(access);
    return cached;
  };
  const missing: MarkdownRenderCacheVariant[] = [];
  for (const variant of variants) {
    if (!variant.contentHash || !(await isCached(variantCacheKey(config, variant, variant.contentHash)))) {
      missing.push(variant);
    }
  }

  let renderTurn: Promise<unknown> = Promise.resolve();
  const renderInTurn = (content: string, languageCode: string): Promise<PersistedRenderedMarkdown> => {
    const rendered = renderTurn.then(async () => {
      await yieldToEventLoop();
      return renderMarkdownToHtml(content, languageCode);
    });
    renderTurn = rendered.catch(() => undefined);
    return rendered;
  };

  const warm = async (variant: MarkdownRenderCacheVariant): Promise<"cached" | "rendered"> => {
    const record = variant.sourceLanguage ? null : (await loadGitHubBlobs(config, [variant.sha], baseDir)).get(variant.sha);
    const content = variant.sourceLanguage ? variant.page.content : record?.content;
    const contentHash = variant.contentHash ?? record?.contentHash;
    if (content === undefined || !contentHash) {
      throw new Error(`Blob ${variant.sha} is missing from the content store.`);
    }

    const cacheKey = variantCacheKey(config, variant, contentHash);
    if (await isCached(cacheKey)) {
      return "cached";
    }

    const rendered = (renderedMarkdownCache.get(cacheKey) as PersistedRenderedMarkdown | undefined) ?? (await renderInTurn(content, variant.language.code));
    assertGitHubCacheAccess(access);
    renderedMarkdownCache.set(cacheKey, rendered);

    const persisted = await trackGitHubCacheWrite(access, writePersistentRenderedMarkdown(cacheKey, rendered));
    assertGitHubCacheAccess(access);
    if (!persisted) {
      throw new Error("Failed to write rendered Markdown HTML cache.");
    }
    return "rendered";
  };

  return { missing, totalPages: pages.length, totalVariants: variants.length, warm };
};

export const clearMarkdownRenderCache = async ({
  config,
  slug,
}: {
  config: GitHubRuntimeConfig;
  slug?: string;
}): Promise<MarkdownRenderCacheClearResult> => {
  if (!slug?.trim()) {
    const prefix = markdownRenderCachePrefix(config);
    renderedMarkdownCache.deleteWhere((key) => typeof key === "string" && key.startsWith(prefix));
    const clearedEntries = await deletePersistentRenderedMarkdownWhere((key) => key.startsWith(prefix));
    await recordRenderedMarkdownCacheMutation({
      deletedEntries: clearedEntries,
      reason: "admin-clear-current-source",
      scope: "all",
    });

    return {
      clearedEntries,
      scope: "all",
    };
  }

  const normalizedSlug = normalizeMarkdownCacheSlug(slug);
  renderedMarkdownCache.deleteWhere(
    (key) => typeof key === "string" && markdownRenderCacheKeyMatchesSlug(config, normalizedSlug, key),
  );
  const clearedEntries = await deletePersistentRenderedMarkdownWhere((key) =>
    markdownRenderCacheKeyMatchesSlug(config, normalizedSlug, key),
  );
  await recordRenderedMarkdownCacheMutation({
    deletedEntries: clearedEntries,
    reason: "admin-clear-page",
    scope: "page",
    target: normalizedSlug,
  });

  return {
    clearedEntries,
    scope: "page",
    slug: normalizedSlug,
  };
};
