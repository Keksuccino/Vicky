import { aiPlaintextDocsCache, docsSearchCorpusCache, renderedMarkdownCache } from "@/lib/cache";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { loadStoredGitHubBlobSummaries } from "@/lib/github-content-store";
import { normalizeDocsPath, stripRepoRoot } from "@/lib/github-paths";
import { deletePersistentRenderedMarkdownWhere, recordRenderedMarkdownCacheMutation } from "@/lib/markdown-render-cache-store";
import type { GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig } from "@/lib/types";

/** Prune targets named in a recorded mutation; the rest is summarized as a count. */
const MAX_RECORDED_PRUNE_TARGETS = 10;

/**
 * Caches derived from source pages: rendered HTML, the search corpora, and the plaintext export.
 * Rendered HTML is pruned only for pages and translations that changed.
 */
export type GitHubDocsPagesSnapshot = {
  /** Every Markdown file of the branch (source pages and translations) with its blob SHA. */
  index: { files: ReadonlyMap<string, { sha: string }> };
  pages: GitHubDocPage[];
  /** Source pages by NFC-normalized relative path. */
  pagesByPath: ReadonlyMap<string, GitHubDocPage>;
  tree: GitHubDocTreeItem[];
};

type RenderedMarkdownCachePruneTarget = {
  /** Unset: every language of the page. */
  languageCode?: string;
  slug: string;
  /** Content hash of the language's current version; its entry stays (only valid with `languageCode`). */
  keepContentHash?: string;
};

const renderedMarkdownCachePrefix = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|markdown-render|`;

export const docsSourceLogContext = (config: GitHubRuntimeConfig): Record<string, string> => ({
  owner: config.owner,
  repo: config.repo,
  branch: config.branch,
  docsPath: normalizeDocsPath(config.docsPath),
});

const normalizeRenderedMarkdownLanguageCode = (languageCode: string): string => languageCode.trim().replace(/_/g, "-").toLowerCase();

const pruneTargetKey = (slug: string, languageCode?: string): string => `${slug}|${languageCode ?? "*"}`;

const describePruneTargets = (targets: RenderedMarkdownCachePruneTarget[]): string => {
  const named = targets.slice(0, MAX_RECORDED_PRUNE_TARGETS).map((target) => (target.languageCode ? `${target.slug}:${target.languageCode}` : target.slug));
  return targets.length > MAX_RECORDED_PRUNE_TARGETS ? `${named.join(",")},+${targets.length - MAX_RECORDED_PRUNE_TARGETS} more` : named.join(",");
};

/**
 * Deletes the rendered entries of the targets, from memory and disk. Keys are matched with one
 * lookup each, however many targets there are. A mutation is recorded only when entries went.
 */
export const pruneRenderedMarkdownCache = async ({
  config,
  reason,
  targets,
}: {
  config: GitHubRuntimeConfig;
  reason: string;
  targets: RenderedMarkdownCachePruneTarget[];
}): Promise<number> => {
  const targetsByKey = new Map<string, RenderedMarkdownCachePruneTarget>();

  for (const target of targets) {
    const slug = target.slug.trim();
    if (!slug) {
      continue;
    }

    const languageCode = target.languageCode?.trim() ? normalizeRenderedMarkdownLanguageCode(target.languageCode) : undefined;
    targetsByKey.set(pruneTargetKey(slug, languageCode), {
      slug,
      ...(languageCode ? { languageCode } : {}),
      ...(languageCode && target.keepContentHash ? { keepContentHash: target.keepContentHash } : {}),
    });
  }

  if (targetsByKey.size === 0) {
    return 0;
  }

  const prefix = renderedMarkdownCachePrefix(config);
  const matchesTarget = (key: unknown): boolean => {
    if (typeof key !== "string" || !key.startsWith(prefix)) {
      return false;
    }

    const [rendererVersion, slug, languageCode, contentHash] = key.slice(prefix.length).split("|");
    if (!rendererVersion || !slug || !languageCode) {
      return false;
    }
    if (targetsByKey.has(pruneTargetKey(slug))) {
      return true;
    }

    const target = targetsByKey.get(pruneTargetKey(slug, languageCode));
    return target !== undefined && target.keepContentHash !== contentHash;
  };

  renderedMarkdownCache.deleteWhere(matchesTarget);
  const deletedEntries = await deletePersistentRenderedMarkdownWhere(matchesTarget);
  if (deletedEntries > 0) {
    const targetList = Array.from(targetsByKey.values());
    await recordRenderedMarkdownCacheMutation({
      deletedEntries,
      reason,
      scope: targetList.length === 1 ? "page" : "pages",
      target: describePruneTargets(targetList),
    });
  }

  return deletedEntries;
};

const sourcePagePruneTargets = (previous: GitHubDocsPagesSnapshot, next: GitHubDocsPagesSnapshot): RenderedMarkdownCachePruneTarget[] => {
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

/**
 * Targets for translations whose file changed or disappeared: their rendered HTML can no longer
 * be served. A translation lives at `<localization root>/<language>/<source page path>`, and the
 * root is a site setting this module does not know, so every changed file outside the docs is
 * matched against the source page paths it ends with; the path segment before such a suffix is
 * the language. A file that only looks like a translation names a language without entries, or
 * at worst costs one render. The content hash of the new version stays when its blob is stored
 * (the app committed it), so a change of the front matter alone keeps the rendered HTML.
 */
const translationPruneTargets = async (
  config: GitHubRuntimeConfig,
  previous: GitHubDocsPagesSnapshot,
  next: GitHubDocsPagesSnapshot,
  baseDir: string,
): Promise<RenderedMarkdownCachePruneTarget[]> => {
  const docsRoot = normalizeDocsPath(config.docsPath);
  const changed: Array<{ nextSha?: string; repoPath: string }> = [];
  for (const [repoPath, file] of previous.index.files) {
    const nextSha = next.index.files.get(repoPath)?.sha;
    if (nextSha !== file.sha && stripRepoRoot(docsRoot, repoPath) === null) {
      changed.push({ nextSha, repoPath });
    }
  }
  if (changed.length === 0) {
    return [];
  }

  const summaries = await loadStoredGitHubBlobSummaries(changed.flatMap((file) => (file.nextSha ? [file.nextSha] : [])), baseDir);
  const targets: RenderedMarkdownCachePruneTarget[] = [];
  for (const file of changed) {
    const keepContentHash = file.nextSha ? summaries.get(file.nextSha)?.contentHash : undefined;
    const segments = file.repoPath.split("/");
    for (let languageIndex = 0; languageIndex < segments.length - 1; languageIndex += 1) {
      const sourcePage = previous.pagesByPath.get(segments.slice(languageIndex + 1).join("/").normalize("NFC"));
      if (sourcePage) {
        targets.push({ languageCode: segments[languageIndex], slug: sourcePage.slug, ...(keepContentHash ? { keepContentHash } : {}) });
      }
    }
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
 * changed or that disappeared are pruned, and translations whose file changed or disappeared;
 * with `changedSourceSlugs`, exactly those pages, and an empty list (only localizations changed)
 * clears just the in-memory derivations. Rendered entries are keyed by content, so pruning only
 * reclaims space and removes deleted pages; in-memory derivations of all pages are rebuilt
 * either way.
 */
export const clearDerivedGitHubDocsCache = async (
  config: GitHubRuntimeConfig,
  options: { changedSourceSlugs: string[] } | { baseDir: string; snapshots: { previous: GitHubDocsPagesSnapshot; next: GitHubDocsPagesSnapshot } },
): Promise<void> => {
  clearDerivedGitHubDocsMemory(config);

  if ("snapshots" in options) {
    const { previous, next } = options.snapshots;
    await pruneRenderedMarkdownCache({
      config,
      reason: "docs-snapshot-change",
      targets: [...sourcePagePruneTargets(previous, next), ...(await translationPruneTargets(config, previous, next, options.baseDir))],
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
