import path from "node:path";

import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguages,
} from "@/lib/auto-translate";
import { renderedMarkdownCache } from "@/lib/cache";
import { listMarkdownDocsTreePagesWithTitles, loadGitHubLocalizationSnapshot } from "@/lib/github";
import { badRequest } from "@/lib/http";
import {
  deletePersistentRenderedMarkdownWhere,
  getPersistentRenderedMarkdownCacheDir,
  getRenderedMarkdownCacheLastMutation,
  listPersistentRenderedMarkdownCacheEntries,
  recordRenderedMarkdownCacheMutation,
  readPersistentRenderedMarkdownMetadata,
  writePersistentRenderedMarkdown,
  type RenderedMarkdownCacheMutation,
} from "@/lib/markdown-render-cache-store";
import { MARKDOWN_RENDER_VERSION } from "@/lib/markdown-rendering-shared";
import {
  markdownRenderCacheKey,
  markdownRenderCachePrefix,
  renderMarkdownToHtml,
} from "@/lib/markdown-server-renderer";
import { isLocalizedPageOutdated } from "@/lib/page-localization-read";
import type { AutoTranslateLanguage, DocsStore, GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

const MARKDOWN_CACHE_RENDER_CONCURRENCY = 4;
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

export type MarkdownRenderCacheWarmResult = {
  cachedVariants: number;
  failedVariants: number;
  failures: Array<{
    error: string;
    languageCode: string;
    slug: string;
  }>;
  renderedVariants: number;
  skippedVariants: number;
  totalPages: number;
  totalVariants: number;
};

export type MarkdownRenderCacheClearResult = {
  clearedEntries: number;
  scope: "all" | "page";
  slug?: string;
};

type MarkdownRenderCacheVariant = {
  content: string;
  language: AutoTranslateLanguage;
  page: GitHubDocPage;
  sourceLanguage: boolean;
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

const markdownRenderCacheVariantKey = (
  config: GitHubRuntimeConfig,
  variant: MarkdownRenderCacheVariant,
): { cacheKey: string; contentHash: string } =>
  markdownRenderCacheKey({
    config,
    content: variant.content,
    languageCode: variant.language.code,
    slug: variant.page.slug,
  });

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  iteratee: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (values.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(concurrency, values.length));
  const output = new Array<R>(values.length);
  let index = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (index < values.length) {
      const currentIndex = index;
      index += 1;
      output[currentIndex] = await iteratee(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return output;
};

const buildMarkdownRenderCacheVariants = async ({
  config,
  store,
}: {
  config: GitHubRuntimeConfig;
  store: DocsStore;
}): Promise<{ pages: GitHubDocPage[]; variants: MarkdownRenderCacheVariant[] }> => {
  const { pages } = await listMarkdownDocsTreePagesWithTitles(config);
  const languages = uniqueLanguagesByCode(normalizeAutoTranslateLanguages(store.settings.autoTranslate.languages));
  const defaultLanguage = languages.find((language) => isDefaultAutoTranslateLanguageCode(language.code)) ?? sourceLanguage();
  const translatedLanguages = languages.filter((language) => !isDefaultAutoTranslateLanguageCode(language.code));
  const variants: MarkdownRenderCacheVariant[] = [];
  const localizedPagesByLanguage = new Map<string, Map<string, GitHubDocPage>>();

  for (const language of translatedLanguages) {
    const snapshot = await loadGitHubLocalizationSnapshot({
      config,
      language,
      localizationPath: store.settings.autoTranslate.localizationPath,
      sourcePages: pages,
    });
    localizedPagesByLanguage.set(language.code.toLowerCase(), new Map(snapshot.pages.map((page) => [page.path, page])));
  }

  for (const page of pages) {
    variants.push({
      content: page.content,
      language: defaultLanguage,
      page,
      sourceLanguage: true,
    });

    for (const language of translatedLanguages) {
      const localizedPage = localizedPagesByLanguage.get(language.code.toLowerCase())?.get(page.path) ?? null;
      if (!localizedPage || isLocalizedPageOutdated(page, localizedPage)) {
        continue;
      }

      variants.push({
        content: localizedPage.content,
        language,
        page: localizedPage,
        sourceLanguage: false,
      });
    }
  }

  return {
    pages,
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
    const { cacheKey, contentHash } = markdownRenderCacheVariantKey(config, variant);
    const persisted = cacheEntriesByKey.get(cacheKey) ?? null;
    const cached = Boolean(persisted);
    expectedKeys.add(cacheKey);

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
      contentHash,
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

export const warmMarkdownRenderCache = async ({
  config,
  store,
}: {
  config: GitHubRuntimeConfig;
  store: DocsStore;
}): Promise<MarkdownRenderCacheWarmResult> => {
  const { pages, variants } = await buildMarkdownRenderCacheVariants({ config, store });
  const missingVariants: Array<MarkdownRenderCacheVariant & { cacheKey: string }> = [];

  for (const variant of variants) {
    const { cacheKey } = markdownRenderCacheVariantKey(config, variant);
    const persisted = await readPersistentRenderedMarkdownMetadata(cacheKey);
    if (!persisted) {
      missingVariants.push({
        ...variant,
        cacheKey,
      });
    }
  }

  const results = await mapWithConcurrency(
    missingVariants,
    MARKDOWN_CACHE_RENDER_CONCURRENCY,
    async (variant) => {
      try {
        const fromMemory = renderedMarkdownCache.get(variant.cacheKey);
        const rendered =
          fromMemory && typeof fromMemory === "object" && fromMemory !== null && "html" in fromMemory && "headings" in fromMemory
            ? (fromMemory as Awaited<ReturnType<typeof renderMarkdownToHtml>>)
            : await renderMarkdownToHtml(variant.content, variant.language.code);

        renderedMarkdownCache.set(variant.cacheKey, rendered);

        const persisted = await writePersistentRenderedMarkdown(variant.cacheKey, rendered);
        if (!persisted) {
          throw new Error("Failed to write rendered Markdown HTML cache.");
        }

        return {
          ok: true as const,
          variant,
        };
      } catch (error: unknown) {
        return {
          error: error instanceof Error ? error.message : String(error),
          ok: false as const,
          variant,
        };
      }
    },
  );

  const failures = results
    .filter((result): result is Extract<(typeof results)[number], { ok: false }> => !result.ok)
    .map((result) => ({
      error: result.error,
      languageCode: result.variant.language.code,
      slug: result.variant.page.slug,
    }));

  return {
    cachedVariants: variants.length - missingVariants.length,
    failedVariants: failures.length,
    failures,
    renderedVariants: missingVariants.length - failures.length,
    skippedVariants: variants.length - missingVariants.length,
    totalPages: pages.length,
    totalVariants: variants.length,
  };
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
