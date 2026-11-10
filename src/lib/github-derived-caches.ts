import { aiPlaintextDocsCache, docsSearchCorpusCache, renderedMarkdownCache } from "@/lib/cache";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { normalizeDocsPath } from "@/lib/github-paths";
import { deletePersistentRenderedMarkdownWhere, recordRenderedMarkdownCacheMutation } from "@/lib/markdown-render-cache-store";
import type { GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig } from "@/lib/types";

/**
 * Caches derived from source pages: rendered HTML, the search corpora, and the plaintext export.
 * Rendered HTML is pruned only for pages that changed.
 */
export type GitHubDocsPagesSnapshot = {
  pages: GitHubDocPage[];
  tree: GitHubDocTreeItem[];
};

type RenderedMarkdownCachePruneTarget = {
  languageCode?: string;
  slug: string;
};

const renderedMarkdownCachePrefix = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|markdown-render|`;

export const docsSourceLogContext = (config: GitHubRuntimeConfig): Record<string, string> => ({
  owner: config.owner,
  repo: config.repo,
  branch: config.branch,
  docsPath: normalizeDocsPath(config.docsPath),
});

const normalizeRenderedMarkdownLanguageCode = (languageCode: string): string => languageCode.trim().replace(/_/g, "-").toLowerCase();

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
 * Rendered entries are keyed by content, so pruning only reclaims space and removes deleted
 * pages; in-memory derivations of all pages are rebuilt either way.
 */
export const clearDerivedGitHubDocsCache = async (
  config: GitHubRuntimeConfig,
  options: { changedSourceSlugs: string[] } | { snapshots: { previous: GitHubDocsPagesSnapshot; next: GitHubDocsPagesSnapshot } },
): Promise<void> => {
  clearDerivedGitHubDocsMemory(config);

  if ("snapshots" in options) {
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

  await pruneRenderedMarkdownCache({
    config,
    reason: "source-page-change",
    targets: options.changedSourceSlugs.map((slug) => ({ slug })),
  });
};
