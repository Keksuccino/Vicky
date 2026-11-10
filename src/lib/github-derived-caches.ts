import {
  aiPlaintextDocsCache,
  docsSearchCorpusCache,
  renderedMarkdownCache,
  translatedDocsPageCache,
  translatedDocsTitleCache,
} from "@/lib/cache";
import { logAutoTranslateInfo } from "@/lib/auto-translate-logging";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { normalizeDocsPath } from "@/lib/github-paths";
import { deletePersistentRenderedMarkdownWhere, recordRenderedMarkdownCacheMutation } from "@/lib/markdown-render-cache-store";
import { deletePersistentTranslationCacheWhere } from "@/lib/translation-cache-store";
import type { GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig } from "@/lib/types";

/**
 * Caches derived from source pages: rendered HTML, translations, the search corpora, and the
 * plaintext export. They are pruned only for pages that changed.
 */
export type GitHubDocsPagesSnapshot = {
  pages: GitHubDocPage[];
  tree: GitHubDocTreeItem[];
};

type RenderedMarkdownCachePruneTarget = {
  languageCode?: string;
  slug: string;
};

const translatedDocsPageCachePrefix = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|auto-translate|page|`;

const translatedDocsTitleCachePrefix = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|auto-translate|titles|`;

const renderedMarkdownCachePrefix = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|markdown-render|`;

const titleSourceSignature = (items: GitHubDocTreeItem[]): string =>
  JSON.stringify(items.map((item) => ({ slug: item.slug, path: item.path, name: item.name })));

const normalizeRenderedMarkdownLanguageCode = (languageCode: string): string => languageCode.trim().replace(/_/g, "-").toLowerCase();

export const docsSourceLogContext = (config: GitHubRuntimeConfig): Record<string, string> => ({
  owner: config.owner,
  repo: config.repo,
  branch: config.branch,
  docsPath: normalizeDocsPath(config.docsPath),
});

const renderedMarkdownCacheKeyMatchesTarget = (config: GitHubRuntimeConfig, key: string, target: RenderedMarkdownCachePruneTarget): boolean => {
  const prefix = renderedMarkdownCachePrefix(config);
  if (!key.startsWith(prefix)) {
    return false;
  }

  const [rendererVersion, slug, languageCode] = key.slice(prefix.length).split("|");
  if (!rendererVersion || !slug || !languageCode || slug !== target.slug) {
    return false;
  }

  return !target.languageCode || languageCode === normalizeRenderedMarkdownLanguageCode(target.languageCode);
};

export const pruneRenderedMarkdownCache = async ({
  config,
  reason,
  targets,
}: {
  config: GitHubRuntimeConfig;
  reason: string;
  targets: RenderedMarkdownCachePruneTarget[];
}): Promise<number> => {
  const normalizedTargets = new Map<string, RenderedMarkdownCachePruneTarget>();

  for (const target of targets) {
    const slug = target.slug.trim();
    if (!slug) {
      continue;
    }

    const languageCode = target.languageCode?.trim() ? normalizeRenderedMarkdownLanguageCode(target.languageCode) : undefined;
    normalizedTargets.set(`${slug}|${languageCode ?? "*"}`, {
      slug,
      ...(languageCode ? { languageCode } : {}),
    });
  }

  const targetList = Array.from(normalizedTargets.values());
  if (targetList.length === 0) {
    return 0;
  }

  const matchesTarget = (key: string): boolean => targetList.some((target) => renderedMarkdownCacheKeyMatchesTarget(config, key, target));

  renderedMarkdownCache.deleteWhere((key) => typeof key === "string" && matchesTarget(key));
  const deletedEntries = await deletePersistentRenderedMarkdownWhere(matchesTarget);
  await recordRenderedMarkdownCacheMutation({
    deletedEntries,
    reason,
    scope: targetList.length === 1 ? "page" : "pages",
    target: targetList.map((target) => (target.languageCode ? `${target.slug}:${target.languageCode}` : target.slug)).join(","),
  });

  return deletedEntries;
};

const renderedMarkdownPruneTargetsForSnapshotChange = (previous: GitHubDocsPagesSnapshot, next: GitHubDocsPagesSnapshot): RenderedMarkdownCachePruneTarget[] => {
  const nextPagesBySlug = new Map(next.pages.map((page) => [page.slug, page]));
  const targets: RenderedMarkdownCachePruneTarget[] = [];

  for (const previousPage of previous.pages) {
    const nextPage = nextPagesBySlug.get(previousPage.slug);
    if (nextPage && nextPage.content === previousPage.content) {
      continue;
    }

    targets.push({ slug: previousPage.slug });
  }

  return targets;
};

const sourceSlugMatcher = (config: GitHubRuntimeConfig, slugs: Iterable<string>): ((key: string) => boolean) => {
  const pageCachePrefix = translatedDocsPageCachePrefix(config);
  const slugPrefixes = Array.from(slugs, (slug) => `${slug}|`);

  return (key: string): boolean => {
    if (!key.startsWith(pageCachePrefix)) {
      return false;
    }

    const cacheEntryKey = key.slice(pageCachePrefix.length);
    if (!/^[a-f0-9]{32}\|/.test(cacheEntryKey)) {
      return false;
    }

    const sourceCacheKey = cacheEntryKey.slice(33);
    return slugPrefixes.some((slugPrefix) => sourceCacheKey.startsWith(slugPrefix));
  };
};

const pruneTranslatedPagesForSlugs = async (config: GitHubRuntimeConfig, slugs: Iterable<string>): Promise<void> => {
  const matchesSlug = sourceSlugMatcher(config, slugs);
  translatedDocsPageCache.deleteWhere(matchesSlug);
  await deletePersistentTranslationCacheWhere(matchesSlug);
};

const pruneTranslatedDocsCacheForSnapshotChange = async (config: GitHubRuntimeConfig, previous: GitHubDocsPagesSnapshot, next: GitHubDocsPagesSnapshot): Promise<void> => {
  const nextPagesBySlug = new Map(next.pages.map((page) => [page.slug, page]));
  const stalePageSlugs = new Set<string>();

  for (const previousPage of previous.pages) {
    const nextPage = nextPagesBySlug.get(previousPage.slug);
    if (nextPage && nextPage.markdown === previousPage.markdown) {
      continue;
    }

    stalePageSlugs.add(previousPage.slug);
  }

  if (stalePageSlugs.size > 0) {
    logAutoTranslateInfo("Source content changed; existing page translation caches are stale", {
      ...docsSourceLogContext(config),
      pages: stalePageSlugs.size,
      slugs: Array.from(stalePageSlugs).join(","),
    });
    await pruneTranslatedPagesForSlugs(config, stalePageSlugs);
  }

  if (titleSourceSignature(previous.tree) !== titleSourceSignature(next.tree)) {
    const titleCachePrefix = translatedDocsTitleCachePrefix(config);
    logAutoTranslateInfo("Source tree changed; existing sidebar title translation cache is stale", {
      ...docsSourceLogContext(config),
      previousPages: previous.tree.length,
      nextPages: next.tree.length,
    });
    const matchesTitleCache = (key: string): boolean => key.startsWith(titleCachePrefix);
    translatedDocsTitleCache.deleteWhere(matchesTitleCache);
    await deletePersistentTranslationCacheWhere(matchesTitleCache);
  }
};

/** Drops the in-memory derivations of the source's pages and localizations: search corpora and the plaintext export. */
export const clearDerivedGitHubDocsMemory = (config: GitHubRuntimeConfig): void => {
  const prefix = `${gitHubRuntimeCacheKey(config)}|`;
  aiPlaintextDocsCache.deleteWhere((key) => key.startsWith(prefix));
  docsSearchCorpusCache.deleteWhere((key) => key.startsWith(prefix));
};

/**
 * Invalidates caches derived from source pages. With both snapshots, only pages whose content
 * changed or that disappeared are pruned; with `changedSourceSlugs`, exactly those pages, and
 * an empty list (only localizations changed) clears just the in-memory derivations.
 * Rendered and translated entries are keyed by source content, so pruning only reclaims space
 * and removes deleted pages; in-memory derivations of all pages are rebuilt either way.
 */
export const clearDerivedGitHubDocsCache = async (
  config: GitHubRuntimeConfig,
  options: { changedSourceSlugs: string[] } | { snapshots: { previous: GitHubDocsPagesSnapshot; next: GitHubDocsPagesSnapshot } },
): Promise<void> => {
  clearDerivedGitHubDocsMemory(config);

  if ("snapshots" in options) {
    await pruneTranslatedDocsCacheForSnapshotChange(config, options.snapshots.previous, options.snapshots.next);
    await pruneRenderedMarkdownCache({
      config,
      reason: "docs-snapshot-change",
      targets: renderedMarkdownPruneTargetsForSnapshotChange(options.snapshots.previous, options.snapshots.next),
    });
    return;
  }

  if (options.changedSourceSlugs.length === 0) {
    return;
  }

  await pruneTranslatedPagesForSlugs(config, options.changedSourceSlugs);
  await pruneRenderedMarkdownCache({
    config,
    reason: "source-page-change",
    targets: options.changedSourceSlugs.map((slug) => ({ slug })),
  });

  const titlePrefix = translatedDocsTitleCachePrefix(config);
  translatedDocsTitleCache.deleteWhere((key) => key.startsWith(titlePrefix));
  await deletePersistentTranslationCacheWhere((key) => key.startsWith(titlePrefix));
  logAutoTranslateInfo("Cleared derived in-memory translation caches for docs source", docsSourceLogContext(config));
};
