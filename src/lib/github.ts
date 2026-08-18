import path from "node:path";

import { Octokit } from "@octokit/rest";

import {
  aiPlaintextDocsCache,
  docsPageCache,
  docsSearchCorpusCache,
  docsSnapshotCache,
  docsTreeCache,
  renderedMarkdownCache,
  translatedDocsPageCache,
  translatedDocsTitleCache,
} from "@/lib/cache";
import { logAutoTranslateInfo } from "@/lib/auto-translate-logging";
import { decryptSecret } from "@/lib/encryption";
import {
  deletePersistentGitHubDocsSnapshot,
  readPersistentGitHubDocsSnapshot,
  writePersistentGitHubDocsSnapshot,
  type PersistedGitHubDocsSnapshot,
} from "@/lib/docs-snapshot-store";
import {
  assertGitHubCacheAccess,
  beginGitHubCacheAccess,
  invalidateAllGitHubRuntimeCaches,
  invalidateGitHubRuntimeCaches,
  prepareGitHubCacheMutation,
  trackGitHubCacheWrite,
  type GitHubCacheLease,
} from "@/lib/github-cache-invalidation";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { badRequest, notFound } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { canonicalizePublicDocLocator, type CanonicalPublicDocLocator } from "@/lib/public-doc-path";
import {
  deletePersistentRenderedMarkdownWhere,
  recordRenderedMarkdownCacheMutation,
} from "@/lib/markdown-render-cache-store";
import { deletePersistentTranslationCacheWhere } from "@/lib/translation-cache-store";
import type {
  GitHubDocPage,
  GitHubPlaintextDocPage,
  GitHubDocTreeItem,
  GitHubRuntimeConfig,
  GitHubSettings,
  GitHubValidationResult,
  AutoTranslateLanguage,
  SaveGitHubDocInput,
  SaveGitHubDocResult,
} from "@/lib/types";

const markdownExtensionRegex = /\.(md|mdx)$/i;

const normalizeSlashes = (value: string): string => value.replace(/\\+/g, "/").replace(/\/+/g, "/");

const normalizePathValue = (value: string): string => {
  const normalized = normalizeSlashes(value).trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }

  const posixNormalized = path.posix.normalize(normalized);

  if (
    !posixNormalized ||
    posixNormalized === "." ||
    posixNormalized === ".." ||
    posixNormalized.startsWith("../")
  ) {
    throw badRequest("Invalid docs path.");
  }

  return posixNormalized;
};

const normalizeDocsPath = (docsPath: string): string => {
  if (!docsPath.trim()) {
    return "";
  }

  return normalizePathValue(docsPath);
};

const normalizeLocalizationRoot = (localizationPath: string): string => {
  const normalized = normalizePathValue(localizationPath || "localizations");
  return normalized || "localizations";
};

const normalizeLocalizationLanguageCode = (languageCode: string): string => {
  const normalized = languageCode.trim().replace(/_/g, "-");
  if (!normalized) {
    throw badRequest("Localization language code is required.");
  }

  return normalizePathValue(normalized);
};

const ensureMarkdownPath = (relativePath: string): string => {
  const normalized = normalizePathValue(relativePath);

  if (!normalized) {
    throw badRequest("Document path is required.");
  }

  if (markdownExtensionRegex.test(normalized)) {
    return normalized;
  }

  if (path.posix.extname(normalized)) {
    throw badRequest("Document path must end with .md or .mdx.");
  }

  return `${normalized}.md`;
};

const relativePathToSlug = (relativePath: string): string => relativePath.replace(markdownExtensionRegex, "");

const prettyNameFromPath = (relativePath: string): string => {
  const base = path.posix.basename(relativePath).replace(markdownExtensionRegex, "");
  return base
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

export const toRuntimeConfigCacheKey = (config: GitHubRuntimeConfig): string =>
  gitHubRuntimeCacheKey(config);

const snapshotCacheKey = (config: GitHubRuntimeConfig): string => `${toRuntimeConfigCacheKey(config)}|snapshot`;
const localizationSnapshotCacheKey = (
  config: GitHubRuntimeConfig,
  localizationPath: string,
  languageCode: string,
): string =>
  `${toRuntimeConfigCacheKey(config)}|localization-snapshot|${normalizeLocalizationRoot(localizationPath)}|${languageCode.toLowerCase()}`;
const treeCacheKey = (config: GitHubRuntimeConfig): string => `${toRuntimeConfigCacheKey(config)}|tree`;
const titleIndexCacheKey = (config: GitHubRuntimeConfig, items: GitHubDocTreeItem[]): string =>
  `${toRuntimeConfigCacheKey(config)}|title-index|${titleSourceSignature(items)}`;
const pageLocatorCacheKey = (config: GitHubRuntimeConfig, relativePath: string): string =>
  `${toRuntimeConfigCacheKey(config)}|page-locator|${relativePath}`;
const pageRevisionCacheKey = (config: GitHubRuntimeConfig, page: Pick<GitHubDocPage, "slug" | "sha">): string =>
  `${toRuntimeConfigCacheKey(config)}|page|${page.slug}|${page.sha}`;
const commitMetadataCacheKey = (config: GitHubRuntimeConfig, fullRepoPath: string, sha: string): string =>
  `${toRuntimeConfigCacheKey(config)}|commit|${fullRepoPath}|${sha}`;
const FULL_DOCS_LOAD_CONCURRENCY = 6;

type GitHubDocsSnapshot = PersistedGitHubDocsSnapshot;

type GitHubLocalizationSnapshot = {
  fetchedAt: string;
  expiresAt: string;
  tree: GitHubDocTreeItem[];
  pages: GitHubDocPage[];
};

export type GitHubLocalizationPageStatus = {
  path: string;
  slug: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type GitHubLocalizedDocSourcePage = Pick<
  GitHubDocPage,
  "path" | "slug" | "sha" | "includeInPlaintextExport" | "updatedAt" | "updatedBy"
> &
  Partial<Pick<GitHubDocPage, "title" | "description" | "content">>;

export type GitHubLocalizedDocResult = {
  sourcePage: GitHubDocPage;
  page: GitHubDocPage | null;
  status: "current" | "outdated" | "missing";
  localizedRepoPath: string;
};

type GitHubMarkdownTreeEntry = GitHubDocTreeItem & {
  fullPath: string;
  sha: string;
};

type GitHubDocReadTarget = {
  relativePath: string;
  fullPath: string;
  slug: string;
  treeItem: GitHubDocTreeItem;
};

type GitHubDocPageLocatorCacheEntry = {
  revisionKey: string;
  relativePath: string;
  slug: string;
  sha: string;
};

type GitHubDocsTreeWithTitleStatus = {
  items: GitHubDocTreeItem[];
  titleIndexReady: boolean;
};

const translatedDocsPageCachePrefix = (config: GitHubRuntimeConfig): string =>
  `${toRuntimeConfigCacheKey(config)}|auto-translate|page|`;

const translatedDocsTitleCachePrefix = (config: GitHubRuntimeConfig): string =>
  `${toRuntimeConfigCacheKey(config)}|auto-translate|titles|`;

const renderedMarkdownCachePrefix = (config: GitHubRuntimeConfig): string =>
  `${toRuntimeConfigCacheKey(config)}|markdown-render|`;

type RenderedMarkdownCachePruneTarget = {
  languageCode?: string;
  slug: string;
};

const titleSourceSignature = (items: GitHubDocTreeItem[]): string =>
  JSON.stringify(items.map((item) => ({ slug: item.slug, path: item.path, name: item.name })));

const normalizeRenderedMarkdownLanguageCode = (languageCode: string): string => languageCode.trim().replace(/_/g, "-").toLowerCase();

const renderedMarkdownCacheKeyMatchesTarget = (
  config: GitHubRuntimeConfig,
  key: string,
  target: RenderedMarkdownCachePruneTarget,
): boolean => {
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

const pruneRenderedMarkdownCache = async ({
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

    const languageCode = target.languageCode?.trim()
      ? normalizeRenderedMarkdownLanguageCode(target.languageCode)
      : undefined;
    normalizedTargets.set(`${slug}|${languageCode ?? "*"}`, {
      slug,
      ...(languageCode ? { languageCode } : {}),
    });
  }

  const targetList = Array.from(normalizedTargets.values());
  if (targetList.length === 0) {
    return 0;
  }

  const matchesTarget = (key: string): boolean =>
    targetList.some((target) => renderedMarkdownCacheKeyMatchesTarget(config, key, target));

  renderedMarkdownCache.deleteWhere((key) => typeof key === "string" && matchesTarget(key));
  const deletedEntries = await deletePersistentRenderedMarkdownWhere(matchesTarget);
  await recordRenderedMarkdownCacheMutation({
    deletedEntries,
    reason,
    scope: targetList.length === 1 ? "page" : "pages",
    target: targetList
      .map((target) => (target.languageCode ? `${target.slug}:${target.languageCode}` : target.slug))
      .join(","),
  });

  return deletedEntries;
};

const renderedMarkdownPruneTargetsForSnapshotChange = (
  previous: GitHubDocsSnapshot,
  next: GitHubDocsSnapshot,
): RenderedMarkdownCachePruneTarget[] => {
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

const docsSourceLogContext = (config: GitHubRuntimeConfig): Record<string, string> => ({
  owner: config.owner,
  repo: config.repo,
  branch: config.branch,
  docsPath: normalizeDocsPath(config.docsPath),
});

const pruneTranslatedDocsCacheForSnapshotChange = async (
  config: GitHubRuntimeConfig,
  previous: GitHubDocsSnapshot,
  next: GitHubDocsSnapshot,
): Promise<void> => {
  const nextPagesBySlug = new Map(next.pages.map((page) => [page.slug, page]));
  const pageCachePrefix = translatedDocsPageCachePrefix(config);
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

    const stalePageSlugPrefixes = Array.from(stalePageSlugs, (slug) => `${slug}|`);
    const matchesStalePage = (key: string): boolean => {
      if (!key.startsWith(pageCachePrefix)) {
        return false;
      }

      const cacheEntryKey = key.slice(pageCachePrefix.length);
      if (!/^[a-f0-9]{32}\|/.test(cacheEntryKey)) {
        return false;
      }

      const sourceCacheKey = cacheEntryKey.slice(33);
      return stalePageSlugPrefixes.some((slugPrefix) => sourceCacheKey.startsWith(slugPrefix));
    };
    translatedDocsPageCache.deleteWhere(matchesStalePage);
    await deletePersistentTranslationCacheWhere(matchesStalePage);
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

const docsSnapshotLoads = new Map<string, Promise<GitHubDocsSnapshot>>();
const localizationSnapshotLoads = new Map<string, Promise<GitHubLocalizationSnapshot>>();
const docsTreeLoads = new Map<string, Promise<GitHubDocTreeItem[]>>();
const docsTitleIndexLoads = new Map<string, Promise<GitHubDocTreeItem[]>>();
const docsPageLoads = new Map<string, Promise<GitHubDocPage>>();
const commitMetadataLoads = new Map<string, Promise<{ updatedAt?: string; updatedBy?: string }>>();
const publicDocsTreeIndexes = new WeakMap<GitHubDocTreeItem[], { byPath: Map<string, GitHubDocTreeItem>; bySlug: Map<string, GitHubDocTreeItem> }>();
const publicDocsNegativeCache = new Map<string, number>();
const MAX_PUBLIC_DOC_NEGATIVE_CACHE_ENTRIES = 10_000;
const MAX_PUBLIC_DOC_NEGATIVE_CACHE_TTL_MS = 30_000;
let lastPublicDocsNegativeCachePruneAt = Number.NEGATIVE_INFINITY;

const createOctokit = (config: GitHubRuntimeConfig): Octokit =>
  new Octokit({
    auth: config.token,
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

const asUnknownRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const readStringField = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const extractCommitMetadata = (commit: unknown): { updatedAt?: string; updatedBy?: string } => {
  const commitRecord = asUnknownRecord(commit);
  const author = asUnknownRecord(commitRecord.author);
  const committer = asUnknownRecord(commitRecord.committer);
  const nestedCommit = asUnknownRecord(commitRecord.commit);
  const nestedAuthor = asUnknownRecord(nestedCommit.author);
  const nestedCommitter = asUnknownRecord(nestedCommit.committer);

  return {
    updatedAt:
      readStringField(author, "date") ??
      readStringField(committer, "date") ??
      readStringField(nestedAuthor, "date") ??
      readStringField(nestedCommitter, "date"),
    updatedBy:
      readStringField(author, "login") ??
      readStringField(committer, "login") ??
      readStringField(author, "name") ??
      readStringField(committer, "name") ??
      readStringField(nestedAuthor, "name") ??
      readStringField(nestedCommitter, "name"),
  };
};

const joinDocsPath = (docsRoot: string, relativePath: string): string => {
  if (!docsRoot) {
    return relativePath;
  }

  return `${docsRoot}/${relativePath}`;
};

const stripDocsRoot = (docsRoot: string, repoPath: string): string | null => {
  if (!docsRoot) {
    return repoPath;
  }

  if (repoPath === docsRoot) {
    return "";
  }

  if (!repoPath.startsWith(`${docsRoot}/`)) {
    return null;
  }

  return repoPath.slice(docsRoot.length + 1);
};

const resolvePathFromInput = (docsRoot: string, value: string): string => {
  const normalized = normalizePathValue(value);
  const stripped = stripDocsRoot(docsRoot, normalized);

  if (stripped === null) {
    return ensureMarkdownPath(normalized);
  }

  return ensureMarkdownPath(stripped);
};

const resolveSlugInput = (slug: string): string => {
  const normalized = normalizePathValue(slug);
  return normalized.replace(markdownExtensionRegex, "");
};

export const validateGitHubRuntimeConfig = (config: Partial<GitHubRuntimeConfig>): GitHubValidationResult => {
  const errors: string[] = [];

  if (!config.owner?.trim()) {
    errors.push("GitHub owner is required.");
  }

  if (!config.repo?.trim()) {
    errors.push("GitHub repository is required.");
  }

  if (!config.branch?.trim()) {
    errors.push("GitHub branch is required.");
  }

  if (!config.docsPath?.trim()) {
    errors.push("GitHub docs path is required.");
  }

  if (!config.token?.trim()) {
    errors.push("GitHub token is required.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

export const resolveRuntimeConfig = (
  settings: GitHubSettings,
  tokenOverride?: string,
): GitHubRuntimeConfig => {
  const token = tokenOverride?.trim() || decryptSecret(settings.tokenEncrypted).trim();

  return {
    owner: settings.owner.trim(),
    repo: settings.repo.trim(),
    branch: settings.branch.trim() || "main",
    docsPath: settings.docsPath.trim() || "docs",
    token,
    cacheEpoch: settings.cacheEpoch,
  };
};

export const clearGitHubDocsCache = async (config?: GitHubRuntimeConfig): Promise<void> => {
  if (!config) {
    await invalidateAllGitHubRuntimeCaches();
    logAutoTranslateInfo("Cleared all docs caches");
    return;
  }

  await invalidateGitHubRuntimeCaches(config, { reason: "docs-cache-clear" });
  logAutoTranslateInfo("Cleared all caches for docs source", docsSourceLogContext(config));
};

const clearDerivedGitHubDocsCache = async (
  config: GitHubRuntimeConfig,
  options?: {
    changedSourceSlugs?: string[];
    snapshots?: { previous?: GitHubDocsSnapshot; next?: GitHubDocsSnapshot };
  },
): Promise<void> => {
  const prefix = `${toRuntimeConfigCacheKey(config)}|`;
  const snapshots = options?.snapshots;
  if (!snapshots?.next) {
    docsTreeCache.deleteWhere((key) => key.startsWith(`${prefix}title-index|`));
  }
  docsSearchCorpusCache.deleteWhere((key) => key.startsWith(prefix));
  aiPlaintextDocsCache.deleteWhere((key) => key.startsWith(prefix));

  if (snapshots?.previous && snapshots.next) {
    clearLocalizationCaches(config);
    await pruneTranslatedDocsCacheForSnapshotChange(config, snapshots.previous, snapshots.next);
    await pruneRenderedMarkdownCache({
      config,
      reason: "docs-snapshot-change",
      targets: renderedMarkdownPruneTargetsForSnapshotChange(snapshots.previous, snapshots.next),
    });
    return;
  }

  clearLocalizationCaches(config);
  if (options?.changedSourceSlugs !== undefined) {
    if (options.changedSourceSlugs.length > 0) {
      await Promise.all(options.changedSourceSlugs.map((slug) => pruneTranslatedPageCacheForSlug(config, slug)));
      await pruneRenderedMarkdownCache({
        config,
        reason: "source-page-change",
        targets: options.changedSourceSlugs.map((slug) => ({ slug })),
      });
    }
  } else {
    const pagePrefix = translatedDocsPageCachePrefix(config);
    translatedDocsPageCache.deleteWhere((key) => key.startsWith(pagePrefix));
    await deletePersistentTranslationCacheWhere((key) => key.startsWith(pagePrefix));
  }
  const titlePrefix = translatedDocsTitleCachePrefix(config);
  translatedDocsTitleCache.deleteWhere((key) => key.startsWith(titlePrefix));
  await deletePersistentTranslationCacheWhere((key) => key.startsWith(titlePrefix));
  logAutoTranslateInfo("Cleared derived in-memory translation caches for docs source", docsSourceLogContext(config));
};

export const testGitHubConnection = async (
  config: GitHubRuntimeConfig,
): Promise<{ ok: true; defaultBranch: string } | { ok: false; error: string }> => {
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    return {
      ok: false,
      error: validation.errors.join(" "),
    };
  }

  try {
    const octokit = createOctokit(config);
    const repoResponse = await octokit.repos.get({
      owner: config.owner,
      repo: config.repo,
    });

    await octokit.repos.getBranch({
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
    });

    return {
      ok: true,
      defaultBranch: repoResponse.data.default_branch,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown GitHub API error.";
    return {
      ok: false,
      error: message,
    };
  }
};

const listMarkdownTreeEntriesFromGitHub = async (
  config: GitHubRuntimeConfig,
  rootPath: string,
): Promise<{ branchCommitSha?: string; items: GitHubMarkdownTreeEntry[]; treeSha?: string }> => {
  const octokit = createOctokit(config);
  const docsRoot = normalizePathValue(rootPath);

  const branch = await octokit.repos.getBranch({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });

  const treeSha = branch.data.commit.commit.tree.sha;
  const treeResponse = await octokit.git.getTree({
    owner: config.owner,
    repo: config.repo,
    tree_sha: treeSha,
    recursive: "1",
  });

  const treeItems: GitHubMarkdownTreeEntry[] = [];

  for (const node of treeResponse.data.tree) {
    if (node.type !== "blob" || !node.path || !node.sha) {
      continue;
    }

    const repoPath = normalizePathValue(node.path);
    if (!markdownExtensionRegex.test(repoPath)) {
      continue;
    }

    const relativePath = stripDocsRoot(docsRoot, repoPath);

    if (relativePath === null || !relativePath) {
      continue;
    }

    const markdownPath = ensureMarkdownPath(relativePath);
    treeItems.push({
      fullPath: repoPath,
      path: markdownPath,
      sha: node.sha,
      slug: relativePathToSlug(markdownPath),
      name: prettyNameFromPath(markdownPath),
    });
  }

  treeItems.sort((left, right) => left.path.localeCompare(right.path));

  return {
    branchCommitSha: branch.data.commit.sha,
    items: treeItems,
    treeSha,
  };
};

const listMarkdownTreeFromGitHub = async (
  config: GitHubRuntimeConfig,
  rootPath: string,
): Promise<{ branchCommitSha?: string; items: GitHubDocTreeItem[]; treeSha?: string }> => {
  const result = await listMarkdownTreeEntriesFromGitHub(config, rootPath);
  return {
    branchCommitSha: result.branchCommitSha,
    items: result.items.map((item) => ({
      path: item.path,
      slug: item.slug,
      name: item.name,
    })),
    treeSha: result.treeSha,
  };
};

const listDocsTreeFromGitHub = async (
  config: GitHubRuntimeConfig,
): Promise<{ branchCommitSha?: string; items: GitHubDocTreeItem[]; treeSha?: string }> =>
  listMarkdownTreeFromGitHub(config, normalizeDocsPath(config.docsPath));

export const listMarkdownDocsTree = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocTreeItem[]> => {
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const cacheKey = treeCacheKey(config);
  const loadKey = `${cacheKey}|generation-${access.generation}`;
  const cached = options?.bypassCache ? undefined : docsTreeCache.get(cacheKey);
  if (cached) {
    return cached as GitHubDocTreeItem[];
  }

  const pending = docsTreeLoads.get(loadKey);
  if (pending) {
    const items = await pending;
    assertGitHubCacheAccess(access);
    return items;
  }

  // Coalesce the persistent-snapshot check as well as the GitHub tree request. A burst
  // of public misses must never fan out into repeated disk reads or upstream tree calls.
  const loadPromise = (async (): Promise<GitHubDocTreeItem[]> => {
    if (!options?.bypassCache) {
      const snapshot = await readPersistentGitHubDocsSnapshot(config);
      assertGitHubCacheAccess(access);
      if (snapshot) {
        cacheSnapshotForRead(config, snapshot);
        return snapshot.tree;
      }
    }

    const result = await listDocsTreeFromGitHub(config);
    assertGitHubCacheAccess(access);
    docsTreeCache.set(cacheKey, result.items);
    return result.items;
  })()
    .finally(() => {
      if (docsTreeLoads.get(loadKey) === loadPromise) {
        docsTreeLoads.delete(loadKey);
      }
    });

  docsTreeLoads.set(loadKey, loadPromise);
  return loadPromise;
};

const loadFreshGitHubDocsTitleIndex = async (
  config: GitHubRuntimeConfig,
  baseTree: GitHubDocTreeItem[],
): Promise<GitHubDocTreeItem[]> => {
  if (baseTree.length === 0) {
    return [];
  }

  const docsRoot = normalizeDocsPath(config.docsPath);
  const octokit = createOctokit(config);

  const titledItems = await mapWithConcurrency(
    baseTree,
    FULL_DOCS_LOAD_CONCURRENCY,
    async (item): Promise<GitHubDocTreeItem> => {
      try {
        const file = await fetchFileFromGitHub(config, joinDocsPath(docsRoot, item.path), octokit);
        const parsed = parseMarkdownDocument(file.markdown);
        const title = parsed.title.trim();

        return {
          ...item,
          name: title || item.name,
        };
      } catch {
        return item;
      }
    },
  );

  return sortTreeItems(titledItems);
};

const warmGitHubDocsTitleIndex = (config: GitHubRuntimeConfig, baseTree: GitHubDocTreeItem[]): void => {
  const access = beginGitHubCacheAccess(config);
  const cacheKey = titleIndexCacheKey(config, baseTree);
  if (docsTreeCache.get(cacheKey) || docsTitleIndexLoads.has(cacheKey)) {
    return;
  }

  const loadPromise = loadFreshGitHubDocsTitleIndex(config, baseTree)
    .then((items) => {
      assertGitHubCacheAccess(access);
      docsTreeCache.set(cacheKey, items);
      return items;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[docs] Failed to warm docs title index: ${message}`);
      return baseTree;
    })
    .finally(() => {
      if (docsTitleIndexLoads.get(cacheKey) === loadPromise) {
        docsTitleIndexLoads.delete(cacheKey);
      }
    });

  docsTitleIndexLoads.set(cacheKey, loadPromise);
};

export const warmMarkdownDocsTitleIndex = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocTreeItem[]> => {
  const access = beginGitHubCacheAccess(config);
  const baseTree = await listMarkdownDocsTree(config, options);
  assertGitHubCacheAccess(access);
  const cacheKey = titleIndexCacheKey(config, baseTree);
  const loadKey = `${cacheKey}|generation-${access.generation}`;
  const cached = options?.bypassCache ? undefined : docsTreeCache.get(cacheKey);
  if (cached) {
    return cached as GitHubDocTreeItem[];
  }

  const pending = docsTitleIndexLoads.get(loadKey);
  if (pending) {
    const items = await pending;
    assertGitHubCacheAccess(access);
    return items;
  }

  const loadPromise = loadFreshGitHubDocsTitleIndex(config, baseTree)
    .then((items) => {
      assertGitHubCacheAccess(access);
      docsTreeCache.set(cacheKey, items);
      return items;
    })
    .finally(() => {
      if (docsTitleIndexLoads.get(loadKey) === loadPromise) {
        docsTitleIndexLoads.delete(loadKey);
      }
    });

  docsTitleIndexLoads.set(loadKey, loadPromise);
  return loadPromise;
};

export const listMarkdownDocsTreeWithTitleStatus = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean; waitForTitleIndex?: boolean },
): Promise<GitHubDocsTreeWithTitleStatus> => {
  const baseTree = await listMarkdownDocsTree(config, options);
  const cacheKey = titleIndexCacheKey(config, baseTree);
  const cached = options?.bypassCache ? undefined : docsTreeCache.get(cacheKey);
  if (cached) {
    return {
      items: cached as GitHubDocTreeItem[],
      titleIndexReady: true,
    };
  }

  if (options?.waitForTitleIndex) {
    return {
      items: await warmMarkdownDocsTitleIndex(config, options),
      titleIndexReady: true,
    };
  }

  warmGitHubDocsTitleIndex(config, baseTree);

  return {
    items: baseTree,
    titleIndexReady: false,
  };
};

export const listMarkdownDocsTreeWithTitles = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean; waitForTitleIndex?: boolean },
): Promise<GitHubDocTreeItem[]> => {
  const { items } = await listMarkdownDocsTreeWithTitleStatus(config, options);
  return items;
};

export const listMarkdownDocsTreePagesWithTitles = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean; store?: boolean },
): Promise<{ items: GitHubDocTreeItem[]; pages: GitHubDocPage[] }> => {
  const snapshot = await loadGitHubDocsSnapshot(config, options);
  return {
    items: snapshot.tree,
    pages: snapshot.pages,
  };
};

const fetchFileFromGitHub = async (
  config: GitHubRuntimeConfig,
  fullRepoPath: string,
  octokitOverride?: Octokit,
): Promise<{ sha: string; markdown: string }> => {
  const octokit = octokitOverride ?? createOctokit(config);

  try {
    const fileResponse = await octokit.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: fullRepoPath,
      ref: config.branch,
    });

    if (Array.isArray(fileResponse.data) || fileResponse.data.type !== "file") {
      throw badRequest("Document path does not point to a file.");
    }

    const content = Buffer.from(fileResponse.data.content, fileResponse.data.encoding as BufferEncoding).toString(
      "utf8",
    );

    return {
      sha: fileResponse.data.sha,
      markdown: content,
    };
  } catch (error: unknown) {
    const errorWithStatus = error as { status?: number };
    if (errorWithStatus.status === 404) {
      throw notFound("Document not found.");
    }

    throw error;
  }
};

const fetchLatestCommitMetadata = async (
  config: GitHubRuntimeConfig,
  fullRepoPath: string,
  octokitOverride?: Octokit,
): Promise<{ updatedAt?: string; updatedBy?: string }> => {
  const octokit = octokitOverride ?? createOctokit(config);

  try {
    const commits = await octokit.repos.listCommits({
      owner: config.owner,
      repo: config.repo,
      path: fullRepoPath,
      sha: config.branch,
      per_page: 1,
    });

    const latest = commits.data[0];
    if (!latest) {
      return {};
    }

    return {
      updatedAt: latest.commit.author?.date ?? undefined,
      updatedBy: latest.author?.login ?? latest.commit.author?.name ?? undefined,
    };
  } catch {
    return {};
  }
};

const cacheCommitMetadata = (
  config: GitHubRuntimeConfig,
  fullRepoPath: string,
  sha: string,
  commitMeta: { updatedAt?: string; updatedBy?: string },
): void => {
  docsPageCache.set(commitMetadataCacheKey(config, fullRepoPath, sha), commitMeta);
};

const getCachedCommitMetadata = (
  config: GitHubRuntimeConfig,
  fullRepoPath: string,
  sha: string,
): { updatedAt?: string; updatedBy?: string } | null => {
  return (docsPageCache.get(commitMetadataCacheKey(config, fullRepoPath, sha)) as { updatedAt?: string; updatedBy?: string } | undefined) ?? null;
};

const loadCommitMetadata = async (config: GitHubRuntimeConfig, fullRepoPath: string, sha: string, octokitOverride?: Octokit): Promise<{ updatedAt?: string; updatedBy?: string }> => {
  const access = beginGitHubCacheAccess(config);
  const cached = getCachedCommitMetadata(config, fullRepoPath, sha);
  if (cached) {
    return cached;
  }

  const loadKey = `${commitMetadataCacheKey(config, fullRepoPath, sha)}|generation-${access.generation}`;
  const pending = commitMetadataLoads.get(loadKey);
  if (pending) {
    const result = await pending;
    assertGitHubCacheAccess(access);
    return result;
  }

  const loadPromise = fetchLatestCommitMetadata(config, fullRepoPath, octokitOverride)
    .then((commitMeta) => {
      assertGitHubCacheAccess(access);
      cacheCommitMetadata(config, fullRepoPath, sha, commitMeta);
      return commitMeta;
    })
    .finally(() => {
      if (commitMetadataLoads.get(loadKey) === loadPromise) {
        commitMetadataLoads.delete(loadKey);
      }
    });
  commitMetadataLoads.set(loadKey, loadPromise);
  return loadPromise;
};

const warmCommitMetadata = (
  config: GitHubRuntimeConfig,
  fullRepoPath: string,
  sha: string,
  octokitOverride?: Octokit,
): void => {
  const access = beginGitHubCacheAccess(config);
  if (getCachedCommitMetadata(config, fullRepoPath, sha)) {
    return;
  }

  void loadCommitMetadata(config, fullRepoPath, sha, octokitOverride)
    .then(() => assertGitHubCacheAccess(access))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[docs] Failed to warm commit metadata for ${fullRepoPath}: ${message}`);
    });
};

const createGitHubDocPage = (
  treeItem: GitHubDocTreeItem,
  file: { sha: string; markdown: string },
  commitMeta: { updatedAt?: string; updatedBy?: string },
): GitHubDocPage => {
  const parsed = parseMarkdownDocument(file.markdown);

  return {
    path: treeItem.path,
    slug: treeItem.slug,
    sha: file.sha,
    title: parsed.title,
    description: parsed.description,
    content: parsed.content,
    markdown: file.markdown,
    headings: parsed.headings,
    includeInPlaintextExport: parsed.includeInPlaintextExport,
    updatedAt: commitMeta.updatedAt,
    updatedBy: commitMeta.updatedBy,
  };
};

const treeItemFromPage = (page: GitHubDocPage): GitHubDocTreeItem => ({
  path: page.path,
  slug: page.slug,
  name: page.title.trim() || prettyNameFromPath(page.path),
});

const sortTreeItems = (items: GitHubDocTreeItem[]): GitHubDocTreeItem[] =>
  [...items].sort((left, right) => left.path.localeCompare(right.path));

const mergeCachedCommitMetadata = (config: GitHubRuntimeConfig, page: GitHubDocPage): GitHubDocPage => {
  const fullPath = joinDocsPath(normalizeDocsPath(config.docsPath), page.path);
  const commitMeta = getCachedCommitMetadata(config, fullPath, page.sha);

  if (!commitMeta) {
    return page;
  }

  return {
    ...page,
    updatedAt: commitMeta.updatedAt,
    updatedBy: commitMeta.updatedBy,
  };
};

const readPageFromCache = (
  config: GitHubRuntimeConfig,
  target: Pick<GitHubDocReadTarget, "relativePath">,
  mode: "get" | "peek" = "get",
): GitHubDocPage | null => {
  const read = mode === "peek" ? docsPageCache.peek.bind(docsPageCache) : docsPageCache.get.bind(docsPageCache);
  const locator = read(pageLocatorCacheKey(config, target.relativePath)) as GitHubDocPageLocatorCacheEntry | undefined;
  if (!locator?.revisionKey) {
    return null;
  }

  const page = read(locator.revisionKey) as GitHubDocPage | undefined;
  return page ? mergeCachedCommitMetadata(config, page) : null;
};

export const getCachedGitHubDocPage = (config: GitHubRuntimeConfig, relativePath: string): GitHubDocPage | null => {
  beginGitHubCacheAccess(config);
  try {
    return readPageFromCache(config, { relativePath: ensureMarkdownPath(relativePath) });
  } catch {
    return null;
  }
};

const pruneTranslatedPageCacheForSlug = async (config: GitHubRuntimeConfig, slug: string): Promise<void> => {
  const pageCachePrefix = translatedDocsPageCachePrefix(config);
  const sourceSlugPrefix = `${slug}|`;

  const matchesSlug = (key: string): boolean => {
    if (!key.startsWith(pageCachePrefix)) {
      return false;
    }

    const cacheEntryKey = key.slice(pageCachePrefix.length);
    if (!/^[a-f0-9]{32}\|/.test(cacheEntryKey)) {
      return false;
    }

    return cacheEntryKey.slice(33).startsWith(sourceSlugPrefix);
  };
  translatedDocsPageCache.deleteWhere(matchesSlug);
  await deletePersistentTranslationCacheWhere(matchesSlug);
};

const cacheGitHubDocPage = (config: GitHubRuntimeConfig, page: GitHubDocPage): GitHubDocPage | null => {
  const revisionKey = pageRevisionCacheKey(config, page);
  const previousPage = readPageFromCache(config, { relativePath: page.path }, "peek");

  docsPageCache.set(revisionKey, page);
  docsPageCache.set(pageLocatorCacheKey(config, page.path), {
    revisionKey,
    relativePath: page.path,
    slug: page.slug,
    sha: page.sha,
  } satisfies GitHubDocPageLocatorCacheEntry);

  return previousPage ?? null;
};

const loadFreshGitHubDocsSnapshot = async (
  config: GitHubRuntimeConfig,
  options?: { store?: boolean },
): Promise<GitHubDocsSnapshot> => {
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const treeResult = await listDocsTreeFromGitHub(config);
  const baseTree = treeResult.items;
  const docsRoot = normalizeDocsPath(config.docsPath);
  const octokit = createOctokit(config);

  const pages = await mapWithConcurrency(
    baseTree,
    FULL_DOCS_LOAD_CONCURRENCY,
    async (item): Promise<GitHubDocPage> => {
      const fullPath = joinDocsPath(docsRoot, item.path);
      const file = await fetchFileFromGitHub(config, fullPath, octokit);
      const commitMeta = await fetchLatestCommitMetadata(config, fullPath, octokit);
      if (options?.store !== false) {
        cacheCommitMetadata(config, fullPath, file.sha, commitMeta);
      }
      return createGitHubDocPage(item, file, commitMeta);
    },
  );

  const fetchedAtMs = Date.now();
  const tree = sortTreeItems(pages.map((page) => treeItemFromPage(page)));
  const snapshot = {
    branchCommitSha: treeResult.branchCommitSha,
    treeSha: treeResult.treeSha,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    expiresAt: new Date(fetchedAtMs + docsSnapshotCache.getTtlMs()).toISOString(),
    tree,
    pages,
  };

  if (options?.store !== false) {
    pages.forEach((page) => cacheGitHubDocPage(config, page));
    docsTreeCache.set(treeCacheKey(config), baseTree);
    docsTreeCache.set(titleIndexCacheKey(config, baseTree), tree);
  }

  return snapshot;
};

const loadGitHubDocsSnapshot = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean; store?: boolean },
): Promise<GitHubDocsSnapshot> => {
  const access = beginGitHubCacheAccess(config);
  const cacheKey = snapshotCacheKey(config);
  const loadKey = `${cacheKey}|generation-${access.generation}`;
  const shouldStore = options?.store !== false;
  let previousSnapshot = docsSnapshotCache.peek(cacheKey) as GitHubDocsSnapshot | undefined;
  const cached = options?.bypassCache ? undefined : docsSnapshotCache.get(cacheKey);

  if (cached) {
    return cached as GitHubDocsSnapshot;
  }

  if (!previousSnapshot && shouldStore) {
    previousSnapshot = (await readPersistentGitHubDocsSnapshot(config, { allowExpired: true })) ?? undefined;
    assertGitHubCacheAccess(access);
  }

  if (!options?.bypassCache && shouldStore) {
    const persisted = await readPersistentGitHubDocsSnapshot(config);
    assertGitHubCacheAccess(access);
    if (persisted) {
      cacheSnapshotForRead(config, persisted);
      return persisted;
    }
  }

  if (!shouldStore) {
    const snapshot = await loadFreshGitHubDocsSnapshot(config, { store: false });
    assertGitHubCacheAccess(access);
    return snapshot;
  }

  const pending = docsSnapshotLoads.get(loadKey);
  if (pending) {
    const snapshot = await pending;
    assertGitHubCacheAccess(access);
    return snapshot;
  }

  const loadPromise = loadFreshGitHubDocsSnapshot(config, { store: false })
    .then(async (snapshot) => {
      assertGitHubCacheAccess(access);
      cacheSnapshotForRead(config, snapshot);
      docsSnapshotCache.set(cacheKey, snapshot);
      await trackGitHubCacheWrite(access, writePersistentGitHubDocsSnapshot(config, snapshot));
      assertGitHubCacheAccess(access);
      await clearDerivedGitHubDocsCache(config, { snapshots: { previous: previousSnapshot, next: snapshot } });
      assertGitHubCacheAccess(access);
      return snapshot;
    })
    .finally(() => {
      if (docsSnapshotLoads.get(loadKey) === loadPromise) {
        docsSnapshotLoads.delete(loadKey);
      }
    });

  docsSnapshotLoads.set(loadKey, loadPromise);
  return loadPromise;
};

export const localizedRepoPathForSourcePath = (
  localizationPath: string,
  languageCode: string,
  sourcePath: string,
): string => {
  const root = normalizeLocalizationRoot(localizationPath);
  const language = normalizeLocalizationLanguageCode(languageCode);
  const relativeSourcePath = ensureMarkdownPath(sourcePath);
  return joinDocsPath(joinDocsPath(root, language), relativeSourcePath);
};

const createLocalizedDocPage = ({
  commitMeta,
  file,
  languageCode,
  localizedRepoPath,
  sourcePage,
}: {
  commitMeta: { updatedAt?: string; updatedBy?: string };
  file: { sha: string; markdown: string };
  languageCode: string;
  localizedRepoPath: string;
  sourcePage: Pick<GitHubDocPage, "path" | "slug" | "updatedAt"> & Partial<Pick<GitHubDocPage, "title">>;
}): GitHubDocPage => {
  const page = createGitHubDocPage(
    {
      path: sourcePage.path,
      slug: sourcePage.slug,
      name: sourcePage.title?.trim() || prettyNameFromPath(sourcePage.path),
    },
    file,
    commitMeta,
  );

  return {
    ...page,
    languageCode,
    sourceLanguage: false,
    sourcePath: sourcePage.path,
    sourceSlug: sourcePage.slug,
    sourceUpdatedAt: sourcePage.updatedAt,
    translationPath: localizedRepoPath,
    translationUpdatedAt: page.updatedAt,
  };
};

const isTranslationOutdated = (sourcePage: GitHubDocPage, translatedPage: GitHubDocPage): boolean => {
  const sourceTime = sourcePage.updatedAt ? Date.parse(sourcePage.updatedAt) : Number.NaN;
  const translationTime = translatedPage.updatedAt ? Date.parse(translatedPage.updatedAt) : Number.NaN;

  return Number.isFinite(sourceTime) && Number.isFinite(translationTime) && sourceTime > translationTime;
};

export const hydrateGitHubDocPageMetadata = async <T extends Pick<GitHubDocPage, "path" | "sha" | "updatedAt" | "updatedBy">>(
  config: GitHubRuntimeConfig,
  page: T,
): Promise<T> => {
  const access = beginGitHubCacheAccess(config);
  if (page.updatedAt) {
    return page;
  }

  const fullPath = joinDocsPath(normalizeDocsPath(config.docsPath), page.path);
  const cachedCommitMeta = getCachedCommitMetadata(config, fullPath, page.sha);
  const commitMeta = cachedCommitMeta ?? (await loadCommitMetadata(config, fullPath, page.sha));
  assertGitHubCacheAccess(access);
  if (!cachedCommitMeta) {
    cacheCommitMetadata(config, fullPath, page.sha, commitMeta);
  }

  return {
    ...page,
    updatedAt: commitMeta.updatedAt ?? page.updatedAt,
    updatedBy: commitMeta.updatedBy ?? page.updatedBy,
  };
};

export const loadGitHubLocalizedDoc = async ({
  config,
  language,
  localizationPath,
  sourcePage,
}: {
  config: GitHubRuntimeConfig;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePage: GitHubDocPage;
}): Promise<GitHubLocalizedDocResult> => {
  const access = beginGitHubCacheAccess(config);
  const resolvedSourcePage = await hydrateGitHubDocPageMetadata(config, sourcePage);
  const localizedRepoPath = localizedRepoPathForSourcePath(localizationPath, language.code, resolvedSourcePage.path);
  const octokit = createOctokit(config);

  try {
    const file = await fetchFileFromGitHub(config, localizedRepoPath, octokit);
    const commitMeta = await fetchLatestCommitMetadata(config, localizedRepoPath, octokit);
    assertGitHubCacheAccess(access);
    const page = createLocalizedDocPage({
      commitMeta,
      file,
      languageCode: language.code,
      localizedRepoPath,
      sourcePage: resolvedSourcePage,
    });
    const outdated = isTranslationOutdated(resolvedSourcePage, page);

    return {
      sourcePage: resolvedSourcePage,
      page: {
        ...page,
        translationStale: outdated,
        localizationStatus: outdated ? "outdated" : "current",
      },
      status: outdated ? "outdated" : "current",
      localizedRepoPath,
    };
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    return {
      sourcePage: resolvedSourcePage,
      page: null,
      status: "missing",
      localizedRepoPath,
    };
  }
};

export const loadGitHubLocalizationSnapshot = async ({
  config,
  language,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<GitHubLocalizationSnapshot> => {
  const access = beginGitHubCacheAccess(config);
  const cacheKey = localizationSnapshotCacheKey(config, localizationPath, language.code);
  const loadKey = `${cacheKey}|generation-${access.generation}`;
  const previousSnapshot = docsSnapshotCache.peek(cacheKey) as GitHubLocalizationSnapshot | undefined;
  const cached = docsSnapshotCache.get(cacheKey);
  if (cached) {
    return cached as GitHubLocalizationSnapshot;
  }

  const pending = localizationSnapshotLoads.get(loadKey);
  if (pending) {
    const snapshot = await pending;
    assertGitHubCacheAccess(access);
    return snapshot;
  }

  const loadPromise = (async () => {
    const sourcePageByPath = new Map(sourcePages.map((page) => [page.path, page]));
    const languageRoot = joinDocsPath(normalizeLocalizationRoot(localizationPath), normalizeLocalizationLanguageCode(language.code));
    const treeResult = await listMarkdownTreeFromGitHub(config, languageRoot);
    const filteredItems = treeResult.items.filter((item) => sourcePageByPath.has(item.path));
    const octokit = createOctokit(config);
    const pages = await mapWithConcurrency(
      filteredItems,
      FULL_DOCS_LOAD_CONCURRENCY,
      async (item): Promise<GitHubDocPage | null> => {
        const sourcePage = sourcePageByPath.get(item.path);
        if (!sourcePage) {
          return null;
        }

        const fullPath = joinDocsPath(languageRoot, item.path);
        const file = await fetchFileFromGitHub(config, fullPath, octokit);
        const commitMeta = await fetchLatestCommitMetadata(config, fullPath, octokit);
        return createLocalizedDocPage({
          commitMeta,
          file,
          languageCode: language.code,
          localizedRepoPath: fullPath,
          sourcePage,
        });
      },
    );
    const filteredPages = pages.filter((page): page is GitHubDocPage => Boolean(page));
    const fetchedAtMs = Date.now();
    const snapshot = {
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      expiresAt: new Date(fetchedAtMs + docsSnapshotCache.getTtlMs()).toISOString(),
      tree: sortTreeItems(filteredPages.map((page) => treeItemFromPage(page))),
      pages: filteredPages,
    };

    if (previousSnapshot) {
      const nextPagesBySlug = new Map(snapshot.pages.map((page) => [page.slug, page]));
      const changedSlugs = previousSnapshot.pages
        .filter((page) => nextPagesBySlug.get(page.slug)?.content !== page.content)
        .map((page) => page.slug);
      if (changedSlugs.length > 0) {
        await pruneRenderedMarkdownCache({
          config,
          reason: "localization-snapshot-change",
          targets: changedSlugs.map((slug) => ({ languageCode: language.code, slug })),
        });
      }
      docsSearchCorpusCache.deleteWhere((key) => key.startsWith(`${toRuntimeConfigCacheKey(config)}|search-corpus|`));
    }

    assertGitHubCacheAccess(access);
    docsSnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  })().finally(() => {
    if (localizationSnapshotLoads.get(loadKey) === loadPromise) {
      localizationSnapshotLoads.delete(loadKey);
    }
  });

  localizationSnapshotLoads.set(loadKey, loadPromise);
  return loadPromise;
};

export const loadGitHubLocalizationStatusIndex = async ({
  config,
  language,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<Map<string, GitHubLocalizationPageStatus>> => {
  const access = beginGitHubCacheAccess(config);
  const sourcePaths = new Set(sourcePages.map((page) => page.path));
  const languageRoot = joinDocsPath(normalizeLocalizationRoot(localizationPath), normalizeLocalizationLanguageCode(language.code));
  const treeResult = await listMarkdownTreeEntriesFromGitHub(config, languageRoot);
  const filteredItems = treeResult.items.filter((item) => sourcePaths.has(item.path));
  const octokit = createOctokit(config);
  const entries = await mapWithConcurrency(
    filteredItems,
    FULL_DOCS_LOAD_CONCURRENCY,
    async (item): Promise<GitHubLocalizationPageStatus> => {
      const cachedCommitMeta = getCachedCommitMetadata(config, item.fullPath, item.sha);
      const commitMeta = cachedCommitMeta ?? (await fetchLatestCommitMetadata(config, item.fullPath, octokit));
      if (!cachedCommitMeta) {
        assertGitHubCacheAccess(access);
        cacheCommitMetadata(config, item.fullPath, item.sha, commitMeta);
      }

      return {
        path: item.path,
        slug: item.slug,
        updatedAt: commitMeta.updatedAt,
        updatedBy: commitMeta.updatedBy,
      };
    },
  );
  assertGitHubCacheAccess(access);

  return new Map(entries.map((entry) => [entry.path, entry]));
};

const clearLocalizationCaches = (
  config: GitHubRuntimeConfig,
  localizationPath?: string,
  languageCode?: string,
): void => {
  const prefix = localizationPath
    ? `${toRuntimeConfigCacheKey(config)}|localization-snapshot|${normalizeLocalizationRoot(localizationPath)}|${
        languageCode ? `${languageCode.toLowerCase()}` : ""
      }`
    : `${toRuntimeConfigCacheKey(config)}|localization-snapshot|`;

  docsSnapshotCache.deleteWhere((key) => key.startsWith(prefix));
  docsSearchCorpusCache.deleteWhere((key) => key.startsWith(`${toRuntimeConfigCacheKey(config)}|`));
};

const findTreeItemBySlug = async (
  config: GitHubRuntimeConfig,
  slug: string,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocTreeItem | null> => {
  if (!slug) {
    return null;
  }

  const tree = await listMarkdownDocsTree(config, options);
  const normalizedSlug = resolveSlugInput(slug);

  return (
    tree.find(
      (item) =>
        item.slug === normalizedSlug ||
        item.path === normalizedSlug ||
        relativePathToSlug(item.path) === normalizedSlug,
    ) ?? null
  );
};

const resolveGitHubDocReadTarget = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
  options?: { bypassCache?: boolean },
): Promise<GitHubDocReadTarget> => {
  const docsRoot = normalizeDocsPath(config.docsPath);

  if (locator.path?.trim()) {
    const normalizedPath = normalizePathValue(locator.path);
    const strippedPath = stripDocsRoot(docsRoot, normalizedPath);
    const relativeCandidate = strippedPath === null ? normalizedPath : strippedPath;

    if (!relativeCandidate) {
      throw badRequest("Document path is required.");
    }

    if (markdownExtensionRegex.test(relativeCandidate) || path.posix.extname(relativeCandidate)) {
      const relativePath = ensureMarkdownPath(relativeCandidate);
      const slug = relativePathToSlug(relativePath);

      return {
        relativePath,
        fullPath: joinDocsPath(docsRoot, relativePath),
        slug,
        treeItem: {
          path: relativePath,
          slug,
          name: prettyNameFromPath(relativePath),
        },
      };
    }

    const slug = resolveSlugInput(relativeCandidate);
    const treeItem = await findTreeItemBySlug(config, slug, options);
    const relativePath = treeItem?.path ?? ensureMarkdownPath(slug);

    return {
      relativePath,
      fullPath: joinDocsPath(docsRoot, relativePath),
      slug: treeItem?.slug ?? relativePathToSlug(relativePath),
      treeItem:
        treeItem ??
        {
          path: relativePath,
          slug: relativePathToSlug(relativePath),
          name: prettyNameFromPath(relativePath),
        },
    };
  }

  if (!locator.slug?.trim()) {
    throw badRequest("A slug or path query parameter is required.");
  }

  const slug = resolveSlugInput(locator.slug);
  const treeItem = await findTreeItemBySlug(config, slug, options);
  const relativePath = treeItem?.path ?? ensureMarkdownPath(slug);

  return {
    relativePath,
    fullPath: joinDocsPath(docsRoot, relativePath),
    slug: treeItem?.slug ?? relativePathToSlug(relativePath),
    treeItem:
      treeItem ??
      {
        path: relativePath,
        slug: relativePathToSlug(relativePath),
        name: prettyNameFromPath(relativePath),
      },
  };
};

const isNotFoundError = (error: unknown): boolean =>
  error instanceof Error &&
  ("status" in error ? (error as { status?: unknown }).status === 404 : error.message === "Document not found.");

const createReadTargetFromRelativePath = (
  config: GitHubRuntimeConfig,
  relativePath: string,
  slugOverride?: string,
): GitHubDocReadTarget => {
  const docsRoot = normalizeDocsPath(config.docsPath);
  const normalizedRelativePath = ensureMarkdownPath(relativePath);
  const slug = slugOverride?.trim() || relativePathToSlug(normalizedRelativePath);

  return {
    relativePath: normalizedRelativePath,
    fullPath: joinDocsPath(docsRoot, normalizedRelativePath),
    slug,
    treeItem: {
      path: normalizedRelativePath,
      slug,
      name: prettyNameFromPath(normalizedRelativePath),
    },
  };
};

const createDirectSlugReadTargets = (config: GitHubRuntimeConfig, slugInput: string): GitHubDocReadTarget[] => {
  const slug = resolveSlugInput(slugInput);
  if (!slug) {
    return [];
  }

  const markdownPath = `${slug}.md`;
  const mdxPath = `${slug}.mdx`;
  const targets = [createReadTargetFromRelativePath(config, markdownPath, slug)];

  if (mdxPath !== markdownPath) {
    targets.push(createReadTargetFromRelativePath(config, mdxPath, slug));
  }

  return targets;
};

const getPublicDocsTreeIndex = (tree: GitHubDocTreeItem[]): { byPath: Map<string, GitHubDocTreeItem>; bySlug: Map<string, GitHubDocTreeItem> } => {
  const cached = publicDocsTreeIndexes.get(tree);
  if (cached) {
    return cached;
  }

  const index = { byPath: new Map<string, GitHubDocTreeItem>(), bySlug: new Map<string, GitHubDocTreeItem>() };
  for (const item of tree) {
    const normalizedPath = item.path.normalize("NFC");
    const normalizedSlug = item.slug.normalize("NFC");
    if (!index.byPath.has(normalizedPath)) {
      index.byPath.set(normalizedPath, item);
    }
    if (!index.bySlug.has(normalizedSlug)) {
      index.bySlug.set(normalizedSlug, item);
    }
  }
  publicDocsTreeIndexes.set(tree, index);
  return index;
};

const publicDocNegativeCacheKey = (access: GitHubCacheLease, locatorKey: string): string => `${access.runtimeKey}|generation-${access.generation}|${locatorKey}`;

const hasPublicDocNegativeCacheEntry = (key: string, now = Date.now()): boolean => {
  const expiresAt = publicDocsNegativeCache.get(key);
  if (expiresAt === undefined) {
    return false;
  }
  if (now >= expiresAt) {
    publicDocsNegativeCache.delete(key);
    return false;
  }

  // Refresh insertion order on a hit so bounded eviction behaves as an LRU cache.
  publicDocsNegativeCache.delete(key);
  publicDocsNegativeCache.set(key, expiresAt);
  return true;
};

const cachePublicDocNegativeEntry = (key: string, now = Date.now()): void => {
  const ttlMs = Math.min(MAX_PUBLIC_DOC_NEGATIVE_CACHE_TTL_MS, docsTreeCache.getTtlMs());
  if (now - lastPublicDocsNegativeCachePruneAt >= ttlMs) {
    lastPublicDocsNegativeCachePruneAt = now;
    for (const [entryKey, expiresAt] of publicDocsNegativeCache.entries()) {
      if (now >= expiresAt) {
        publicDocsNegativeCache.delete(entryKey);
      }
    }
  }
  while (publicDocsNegativeCache.size >= MAX_PUBLIC_DOC_NEGATIVE_CACHE_ENTRIES) {
    const oldestKey = publicDocsNegativeCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    publicDocsNegativeCache.delete(oldestKey);
  }

  publicDocsNegativeCache.set(key, now + ttlMs);
};

const resolvePublicGitHubDocReadTarget = async (config: GitHubRuntimeConfig, locator: CanonicalPublicDocLocator, access: GitHubCacheLease, signal?: AbortSignal): Promise<GitHubDocReadTarget> => {
  const docsRoot = normalizeDocsPath(config.docsPath);
  let treeLookupKey: string;
  let lookupMode: "path" | "slug";

  if (locator.kind === "path") {
    const stripped = stripDocsRoot(docsRoot, locator.path);
    const relativePath = stripped === null ? locator.path : stripped;
    if (!relativePath) {
      throw badRequest("Document path is required.");
    }
    lookupMode = markdownExtensionRegex.test(relativePath) ? "path" : "slug";
    treeLookupKey = lookupMode === "path" ? relativePath : relativePathToSlug(relativePath);
  } else {
    lookupMode = "slug";
    treeLookupKey = locator.slug;
  }

  const missKey = publicDocNegativeCacheKey(access, `${lookupMode}:${treeLookupKey}`);
  if (hasPublicDocNegativeCacheEntry(missKey)) {
    throw notFound("Document not found.");
  }

  const tree = await awaitWithAbort(listMarkdownDocsTree(config), signal);
  assertGitHubCacheAccess(access);
  const index = getPublicDocsTreeIndex(tree);
  const treeItem = lookupMode === "path" ? index.byPath.get(treeLookupKey) : index.bySlug.get(treeLookupKey);
  if (!treeItem) {
    cachePublicDocNegativeEntry(missKey);
    throw notFound("Document not found.");
  }

  return {
    relativePath: treeItem.path,
    fullPath: joinDocsPath(docsRoot, treeItem.path),
    slug: treeItem.slug,
    treeItem,
  };
};

const awaitWithAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    const error = new Error("The document request was aborted.");
    error.name = "AbortError";
    throw error;
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const error = new Error("The document request was aborted.");
      error.name = "AbortError";
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

const loadFreshGitHubDocPage = async (
  config: GitHubRuntimeConfig,
  target: GitHubDocReadTarget,
): Promise<GitHubDocPage> => {
  const octokit = createOctokit(config);
  const file = await fetchFileFromGitHub(config, target.fullPath, octokit);
  const cachedCommitMeta = getCachedCommitMetadata(config, target.fullPath, file.sha);

  if (!cachedCommitMeta) {
    warmCommitMetadata(config, target.fullPath, file.sha, octokit);
  }

  return createGitHubDocPage(target.treeItem, file, cachedCommitMeta ?? {});
};

const loadGitHubDocTarget = async (
  config: GitHubRuntimeConfig,
  target: GitHubDocReadTarget,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocPage> => {
  const access = beginGitHubCacheAccess(config);
  const cached = options?.bypassCache ? null : readPageFromCache(config, target);
  if (cached) {
    return cached;
  }

  const loadKey = `${toRuntimeConfigCacheKey(config)}|page-load|${target.relativePath}|generation-${access.generation}`;
  const pending = docsPageLoads.get(loadKey);
  if (pending) {
    const page = await pending;
    assertGitHubCacheAccess(access);
    return page;
  }

  const loadPromise = loadFreshGitHubDocPage(config, target)
    .then(async (page) => {
      assertGitHubCacheAccess(access);
      const previousPage = cacheGitHubDocPage(config, page);
      if (previousPage && previousPage.content !== page.content) {
        logAutoTranslateInfo("Source page content changed; existing page translation caches are stale", {
          ...docsSourceLogContext(config),
          slug: page.slug,
          path: page.path,
        });
        await clearDerivedGitHubDocsCache(config, { changedSourceSlugs: [page.slug] });
        assertGitHubCacheAccess(access);
      }
      return mergeCachedCommitMetadata(config, page);
    })
    .finally(() => {
      if (docsPageLoads.get(loadKey) === loadPromise) {
        docsPageLoads.delete(loadKey);
      }
    });

  docsPageLoads.set(loadKey, loadPromise);
  return loadPromise;
};

const loadDirectGitHubDocBySlug = async (
  config: GitHubRuntimeConfig,
  slug: string,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocPage | null> => {
  let lastNotFound: unknown = null;

  for (const target of createDirectSlugReadTargets(config, slug)) {
    try {
      return await loadGitHubDocTarget(config, target, options);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      lastNotFound = error;
    }
  }

  if (lastNotFound) {
    return null;
  }

  return null;
};

const cacheSnapshotForRead = (config: GitHubRuntimeConfig, snapshot: GitHubDocsSnapshot): void => {
  const prefix = `${toRuntimeConfigCacheKey(config)}|`;
  // A snapshot is authoritative for its source generation. Removing every old page
  // locator is essential: otherwise a page deleted on GitHub remains directly readable.
  docsPageCache.deleteWhere((key) => key.startsWith(prefix));
  docsTreeCache.deleteWhere((key) => key.startsWith(prefix));
  docsSnapshotCache.set(snapshotCacheKey(config), snapshot);
  docsTreeCache.set(treeCacheKey(config), snapshot.tree);
  docsTreeCache.set(titleIndexCacheKey(config, snapshot.tree), snapshot.tree);
  snapshot.pages.forEach((page) => cacheGitHubDocPage(config, page));
};

const readPageFromPersistentSnapshot = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
): Promise<GitHubDocPage | null> => {
  const access = beginGitHubCacheAccess(config);
  const snapshot = await readPersistentGitHubDocsSnapshot(config);
  assertGitHubCacheAccess(access);
  if (!snapshot?.pages.length) {
    return null;
  }

  let page: GitHubDocPage | undefined;

  if (locator.slug?.trim()) {
    const normalizedSlug = resolveSlugInput(locator.slug);
    page = snapshot.pages.find(
      (entry) =>
        entry.slug === normalizedSlug ||
        entry.path === normalizedSlug ||
        relativePathToSlug(entry.path) === normalizedSlug,
    );
  } else if (locator.path?.trim()) {
    const docsRoot = normalizeDocsPath(config.docsPath);
    const relativePath = resolvePathFromInput(docsRoot, locator.path);
    const normalizedSlug = relativePathToSlug(relativePath);
    page = snapshot.pages.find((entry) => entry.path === relativePath || entry.slug === normalizedSlug);
  }

  if (!page) {
    return null;
  }

  cacheSnapshotForRead(config, snapshot);
  return mergeCachedCommitMetadata(config, page);
};

const upsertGitHubDocPageInSnapshotCache = async (
  config: GitHubRuntimeConfig,
  page: GitHubDocPage,
  access: GitHubCacheLease,
): Promise<void> => {
  assertGitHubCacheAccess(access);
  cacheGitHubDocPage(config, page);
  docsTreeCache.delete(treeCacheKey(config));
  docsTreeCache.deleteWhere((key) => key.startsWith(`${toRuntimeConfigCacheKey(config)}|title-index|`));

  const cacheKey = snapshotCacheKey(config);
  const cached = docsSnapshotCache.get(cacheKey) as GitHubDocsSnapshot | undefined;
  const changedSourceSlugs = [page.slug];

  if (!cached) {
    await deletePersistentGitHubDocsSnapshot(config);
    await clearDerivedGitHubDocsCache(config, { changedSourceSlugs });
    assertGitHubCacheAccess(access);
    return;
  }

  const pages = cached.pages.filter((entry) => entry.path !== page.path && entry.slug !== page.slug);
  pages.push(page);
  pages.sort((left, right) => left.path.localeCompare(right.path));
  const updatedAtMs = Date.now();
  const nextSnapshot = {
    ...cached,
    expiresAt: new Date(updatedAtMs + docsSnapshotCache.getTtlMs()).toISOString(),
    tree: sortTreeItems(pages.map((entry) => treeItemFromPage(entry))),
    pages,
  };

  docsSnapshotCache.set(cacheKey, nextSnapshot);
  // Remove the old durable snapshot before replacement. If the replacement cannot
  // be written, a restart must fetch GitHub instead of reviving pre-save content.
  await deletePersistentGitHubDocsSnapshot(config);
  assertGitHubCacheAccess(access);
  const persisted = await trackGitHubCacheWrite(access, writePersistentGitHubDocsSnapshot(config, nextSnapshot));
  if (!persisted) {
    await deletePersistentGitHubDocsSnapshot(config);
  }
  assertGitHubCacheAccess(access);
  await clearDerivedGitHubDocsCache(config, { snapshots: { previous: cached, next: nextSnapshot } });
  assertGitHubCacheAccess(access);
};

export const refreshGitHubDocsCache = async (
  config: GitHubRuntimeConfig,
): Promise<{ pageCount: number; fetchedAt: string; expiresAt: string }> => {
  // Refresh is fail-closed: revoke and remove every current-source layer before
  // fetching, so a failed GitHub refresh cannot fall back to a deleted document.
  await invalidateGitHubRuntimeCaches(config, { reason: "admin-docs-refresh" });
  const snapshot = await loadGitHubDocsSnapshot(config, { bypassCache: true });
  return {
    pageCount: snapshot.pages.length,
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
  };
};

export const loadGitHubDoc = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
  options?: { bypassCache?: boolean },
): Promise<GitHubDocPage> => {
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  if (!options?.bypassCache) {
    const persistedPage = await readPageFromPersistentSnapshot(config, locator);
    assertGitHubCacheAccess(access);
    if (persistedPage) {
      return persistedPage;
    }
  }

  if (locator.slug?.trim() && !locator.path?.trim()) {
    const directPage = await loadDirectGitHubDocBySlug(config, locator.slug, options);
    assertGitHubCacheAccess(access);
    if (directPage) {
      return directPage;
    }
  }

  const target = await resolveGitHubDocReadTarget(config, locator, options);
  const page = await loadGitHubDocTarget(config, target, options);
  assertGitHubCacheAccess(access);
  return page;
};

/**
 * Public reads are deliberately tree-authorized. Unlike the editor-capable loader above,
 * an unknown user-controlled locator is never converted into speculative `.md`/`.mdx`
 * GitHub requests. Shared upstream work keeps valid cold reads efficient, while callers
 * may stop awaiting it without cancelling the coalesced operation for other visitors.
 */
export const loadPublicGitHubDoc = async (config: GitHubRuntimeConfig, locator: { slug?: string; path?: string }, options?: { signal?: AbortSignal }): Promise<GitHubDocPage> => {
  const canonicalLocator = canonicalizePublicDocLocator(locator);
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);
  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const target = await resolvePublicGitHubDocReadTarget(config, canonicalLocator, access, options?.signal);
  const page = await awaitWithAbort(loadGitHubDocTarget(config, target), options?.signal);
  assertGitHubCacheAccess(access);
  return page;
};

export const loadPublicGitHubDocMetadata = async (config: GitHubRuntimeConfig, locator: { slug?: string; path?: string }, options?: { signal?: AbortSignal }): Promise<Pick<GitHubDocPage, "path" | "slug" | "updatedAt" | "updatedBy">> => {
  const access = beginGitHubCacheAccess(config);
  const page = await loadPublicGitHubDoc(config, locator, options);
  const enrichedPage = await awaitWithAbort(hydrateGitHubDocPageMetadata(config, page), options?.signal);
  assertGitHubCacheAccess(access);
  return {
    path: enrichedPage.path,
    slug: enrichedPage.slug,
    updatedAt: enrichedPage.updatedAt,
    updatedBy: enrichedPage.updatedBy,
  };
};

export const loadGitHubDocMetadata = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
  options?: { bypassCache?: boolean },
): Promise<Pick<GitHubDocPage, "path" | "slug" | "updatedAt" | "updatedBy">> => {
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const target = await resolveGitHubDocReadTarget(config, locator, options);
  const cachedPage = options?.bypassCache ? null : readPageFromCache(config, target);
  let sha = cachedPage?.sha;

  if (!sha) {
    const file = await fetchFileFromGitHub(config, target.fullPath);
    sha = file.sha;
  }

  const cachedCommitMeta = options?.bypassCache ? null : getCachedCommitMetadata(config, target.fullPath, sha);
  const commitMeta = cachedCommitMeta ?? (await fetchLatestCommitMetadata(config, target.fullPath));
  assertGitHubCacheAccess(access);

  if (!cachedCommitMeta) {
    cacheCommitMetadata(config, target.fullPath, sha, commitMeta);
  }

  if (cachedPage) {
    const enrichedPage = {
      ...cachedPage,
      updatedAt: commitMeta.updatedAt ?? cachedPage.updatedAt,
      updatedBy: commitMeta.updatedBy ?? cachedPage.updatedBy,
    };
    cacheGitHubDocPage(config, enrichedPage);

    return {
      path: enrichedPage.path,
      slug: enrichedPage.slug,
      updatedAt: enrichedPage.updatedAt,
      updatedBy: enrichedPage.updatedBy,
    };
  }

  return {
    path: target.relativePath,
    slug: target.slug,
    updatedAt: commitMeta.updatedAt,
    updatedBy: commitMeta.updatedBy,
  };
};

export const listGitHubDocsForPlaintextExport = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
): Promise<GitHubPlaintextDocPage[]> => {
  const snapshot = await loadGitHubDocsSnapshot(config, options);

  return snapshot.pages.map((page): GitHubPlaintextDocPage => ({
    path: page.path,
    slug: page.slug,
    title: page.title.trim() || prettyNameFromPath(page.path),
    markdown: page.markdown,
    includeInPlaintextExport: page.includeInPlaintextExport,
  }));
};

const resolveSavePath = async (
  config: GitHubRuntimeConfig,
  input: SaveGitHubDocInput,
): Promise<{ relativePath: string; fullPath: string; slug: string }> => {
  const docsRoot = normalizeDocsPath(config.docsPath);

  if (input.path?.trim()) {
    const relativePath = resolvePathFromInput(docsRoot, input.path);
    return {
      relativePath,
      fullPath: joinDocsPath(docsRoot, relativePath),
      slug: relativePathToSlug(relativePath),
    };
  }

  if (input.slug?.trim()) {
    const slug = resolveSlugInput(input.slug);
    const relativePath = ensureMarkdownPath(slug);

    return {
      relativePath,
      fullPath: joinDocsPath(docsRoot, relativePath),
      slug,
    };
  }

  throw badRequest("Either path or slug must be provided when saving a document.");
};

export const saveGitHubDoc = async (
  config: GitHubRuntimeConfig,
  input: SaveGitHubDocInput,
): Promise<SaveGitHubDocResult> => {
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const octokit = createOctokit(config);
  const target = await resolveSavePath(config, input);

  let existingSha: string | undefined;
  let existingMarkdown = "";

  try {
    const existing = await fetchFileFromGitHub(config, target.fullPath);
    existingSha = existing.sha;
    existingMarkdown = existing.markdown;
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError.status !== 404 && apiError.message !== "Document not found.") {
      throw error;
    }
  }

  let baseTitle = "";
  let baseDescription = "";
  let baseContent = "";
  let baseIncludeInPlaintextExport = true;
  const parsedExisting = existingMarkdown ? parseMarkdownDocument(existingMarkdown) : null;

  if (input.markdown !== undefined) {
    const parsedIncoming = parseMarkdownDocument(input.markdown);
    baseTitle = parsedIncoming.title;
    baseDescription = parsedIncoming.description;
    baseContent = parsedIncoming.content;
    baseIncludeInPlaintextExport = parsedIncoming.includeInPlaintextExport;
  } else if (parsedExisting) {
    baseTitle = parsedExisting.title;
    baseDescription = parsedExisting.description;
    baseContent = parsedExisting.content;
    baseIncludeInPlaintextExport = parsedExisting.includeInPlaintextExport;
  }

  const markdown = serializeMarkdownDocument({
    title: input.title ?? baseTitle,
    description: input.description ?? baseDescription,
    content: input.content ?? baseContent,
    includeInPlaintextExport: input.includeInPlaintextExport ?? baseIncludeInPlaintextExport,
  });

  const parsedOutput = parseMarkdownDocument(markdown);
  if (!parsedOutput.content.trim()) {
    throw badRequest("Document content cannot be empty.");
  }

  const commitMessage = input.commitMessage?.trim() || `docs: update ${target.relativePath}`;

  const writeResult = await octokit.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: target.fullPath,
    message: commitMessage,
    content: Buffer.from(markdown, "utf8").toString("base64"),
    branch: config.branch,
    sha: existingSha,
  });
  assertGitHubCacheAccess(access);

  const commitSha = writeResult.data.commit?.sha;
  if (!commitSha) {
    throw new Error("GitHub response did not include a commit SHA.");
  }

  const commitMeta = extractCommitMetadata(writeResult.data.commit);
  const page = createGitHubDocPage(
    {
      path: target.relativePath,
      slug: target.slug,
      name: prettyNameFromPath(target.relativePath),
    },
    {
      sha: writeResult.data.content?.sha ?? existingSha ?? commitSha,
      markdown,
    },
    {
      updatedAt: commitMeta.updatedAt ?? new Date().toISOString(),
      updatedBy: commitMeta.updatedBy,
    },
  );

  // The barrier is deliberately after GitHub confirms the commit. Failed remote
  // writes preserve the still-valid cache; successful writes invalidate old readers.
  const mutationAccess = await prepareGitHubCacheMutation(config);
  await upsertGitHubDocPageInSnapshotCache(config, page, mutationAccess);

  return {
    path: target.relativePath,
    slug: target.slug,
    commitSha,
    page,
  };
};

export const saveGitHubLocalizedDoc = async ({
  config,
  input,
  language,
  localizationPath,
  sourcePage,
}: {
  config: GitHubRuntimeConfig;
  input: Omit<SaveGitHubDocInput, "path" | "slug">;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePage: GitHubDocPage;
}): Promise<SaveGitHubDocResult> => {
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const resolvedSourcePage = await hydrateGitHubDocPageMetadata(config, sourcePage);
  const octokit = createOctokit(config);
  const fullPath = localizedRepoPathForSourcePath(localizationPath, language.code, resolvedSourcePage.path);

  let existingSha: string | undefined;
  let existingMarkdown = "";

  try {
    const existing = await fetchFileFromGitHub(config, fullPath, octokit);
    existingSha = existing.sha;
    existingMarkdown = existing.markdown;
  } catch (error: unknown) {
    const apiError = error as { status?: number; message?: string };
    if (apiError.status !== 404 && apiError.message !== "Document not found.") {
      throw error;
    }
  }

  let baseTitle = resolvedSourcePage.title;
  let baseDescription = resolvedSourcePage.description;
  let baseContent = resolvedSourcePage.content;
  let baseIncludeInPlaintextExport = resolvedSourcePage.includeInPlaintextExport;

  if (input.markdown !== undefined) {
    const parsedIncoming = parseMarkdownDocument(input.markdown);
    baseTitle = parsedIncoming.title;
    baseDescription = parsedIncoming.description;
    baseContent = parsedIncoming.content;
    baseIncludeInPlaintextExport = parsedIncoming.includeInPlaintextExport;
  } else if (existingMarkdown) {
    const parsedExisting = parseMarkdownDocument(existingMarkdown);
    baseTitle = parsedExisting.title;
    baseDescription = parsedExisting.description;
    baseContent = parsedExisting.content;
    baseIncludeInPlaintextExport = parsedExisting.includeInPlaintextExport;
  }

  const markdown = serializeMarkdownDocument({
    title: input.title ?? baseTitle,
    description: input.description ?? baseDescription,
    content: input.content ?? baseContent,
    includeInPlaintextExport: input.includeInPlaintextExport ?? baseIncludeInPlaintextExport,
  });

  const parsedOutput = parseMarkdownDocument(markdown);
  if (!parsedOutput.content.trim()) {
    throw badRequest("Localized document content cannot be empty.");
  }

  const commitMessage =
    input.commitMessage?.trim() || `docs: update ${language.code} localization for ${resolvedSourcePage.path}`;

  const writeResult = await octokit.repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: fullPath,
    message: commitMessage,
    content: Buffer.from(markdown, "utf8").toString("base64"),
    branch: config.branch,
    sha: existingSha,
  });
  assertGitHubCacheAccess(access);

  const commitSha = writeResult.data.commit?.sha;
  if (!commitSha) {
    throw new Error("GitHub response did not include a commit SHA.");
  }

  const commitMeta = extractCommitMetadata(writeResult.data.commit);
  const page = createLocalizedDocPage({
    commitMeta: {
      updatedAt: commitMeta.updatedAt ?? new Date().toISOString(),
      updatedBy: commitMeta.updatedBy,
    },
    file: {
      sha: writeResult.data.content?.sha ?? existingSha ?? commitSha,
      markdown,
    },
    languageCode: language.code,
    localizedRepoPath: fullPath,
    sourcePage: resolvedSourcePage,
  });

  const mutationAccess = await prepareGitHubCacheMutation(config);
  clearLocalizationCaches(config, localizationPath, language.code);
  await pruneRenderedMarkdownCache({
    config,
    reason: "localized-page-save",
    targets: [{ languageCode: language.code, slug: page.slug }],
  });
  assertGitHubCacheAccess(mutationAccess);

  return {
    path: page.path,
    slug: page.slug,
    commitSha,
    page: {
      ...page,
      translationStale: false,
      localizationStatus: "current",
    },
  };
};

export type SaveGitHubLocalizedDocBatchItem = {
  input: Omit<SaveGitHubDocInput, "path" | "slug">;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePage: GitHubLocalizedDocSourcePage;
};

export type SaveGitHubLocalizedDocsBatchResult = {
  commitSha: string;
  results: SaveGitHubDocResult[];
};

export const saveGitHubLocalizedDocsBatch = async ({
  commitMessage,
  config,
  includePages = true,
  items,
}: {
  commitMessage?: string;
  config: GitHubRuntimeConfig;
  includePages?: boolean;
  items: SaveGitHubLocalizedDocBatchItem[];
}): Promise<SaveGitHubLocalizedDocsBatchResult> => {
  const access = beginGitHubCacheAccess(config);
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  if (items.length === 0) {
    throw badRequest("At least one localized document is required.");
  }

  const octokit = createOctokit(config);
  const refName = `heads/${config.branch}`;
  const ref = await octokit.git.getRef({
    owner: config.owner,
    repo: config.repo,
    ref: refName,
  });
  const baseCommitSha = ref.data.object.sha;
  const baseCommit = await octokit.git.getCommit({
    owner: config.owner,
    repo: config.repo,
    commit_sha: baseCommitSha,
  });
  const baseTreeSha = baseCommit.data.tree.sha;
  const preparedItems = await mapWithConcurrency(items, FULL_DOCS_LOAD_CONCURRENCY, async (item) => {
    const resolvedSourcePage = await hydrateGitHubDocPageMetadata(config, item.sourcePage);
    const fullPath = localizedRepoPathForSourcePath(
      item.localizationPath,
      item.language.code,
      resolvedSourcePage.path,
    );
    let baseTitle = resolvedSourcePage.title ?? "";
    let baseDescription = resolvedSourcePage.description ?? "";
    let baseContent = resolvedSourcePage.content ?? "";
    let baseIncludeInPlaintextExport = resolvedSourcePage.includeInPlaintextExport;

    if (item.input.markdown !== undefined) {
      const parsedIncoming = parseMarkdownDocument(item.input.markdown);
      baseTitle = parsedIncoming.title;
      baseDescription = parsedIncoming.description;
      baseContent = parsedIncoming.content;
      baseIncludeInPlaintextExport = parsedIncoming.includeInPlaintextExport;
    }

    const markdown = serializeMarkdownDocument({
      title: item.input.title ?? baseTitle,
      description: item.input.description ?? baseDescription,
      content: item.input.content ?? baseContent,
      includeInPlaintextExport: item.input.includeInPlaintextExport ?? baseIncludeInPlaintextExport,
    });
    const parsedOutput = parseMarkdownDocument(markdown);
    if (!parsedOutput.content.trim()) {
      throw badRequest("Localized document content cannot be empty.");
    }

    const blob = await octokit.git.createBlob({
      owner: config.owner,
      repo: config.repo,
      content: markdown,
      encoding: "utf-8",
    });

    return {
      fullPath,
      item,
      markdown: includePages ? markdown : undefined,
      resolvedSourcePage,
      blobSha: blob.data.sha,
    };
  });
  const tree = await octokit.git.createTree({
    owner: config.owner,
    repo: config.repo,
    base_tree: baseTreeSha,
    tree: preparedItems.map((item) => ({
      path: item.fullPath,
      mode: "100644" as const,
      type: "blob" as const,
      sha: item.blobSha,
    })),
  });
  const commit = await octokit.git.createCommit({
    owner: config.owner,
    repo: config.repo,
    message:
      commitMessage?.trim() ||
      `docs: update ${preparedItems.length} localization${preparedItems.length === 1 ? "" : "s"}`,
    tree: tree.data.sha,
    parents: [baseCommitSha],
  });
  await octokit.git.updateRef({
    owner: config.owner,
    repo: config.repo,
    ref: refName,
    sha: commit.data.sha,
  });
  assertGitHubCacheAccess(access);

  const commitMeta = extractCommitMetadata(commit.data);
  const updatedAt = commitMeta.updatedAt ?? new Date().toISOString();
  const mutationAccess = await prepareGitHubCacheMutation(config);
  for (const item of preparedItems) {
    clearLocalizationCaches(config, item.item.localizationPath, item.item.language.code);
  }
  await pruneRenderedMarkdownCache({
    config,
    reason: "localized-page-batch-save",
    targets: preparedItems.map((item) => ({
      languageCode: item.item.language.code,
      slug: item.resolvedSourcePage.slug,
    })),
  });
  assertGitHubCacheAccess(mutationAccess);

  const results = includePages
    ? preparedItems.map((item): SaveGitHubDocResult => {
        if (item.markdown === undefined) {
          throw new Error("Localized document page output was not retained.");
        }

        const page = createLocalizedDocPage({
          commitMeta: {
            updatedAt,
            updatedBy: commitMeta.updatedBy,
          },
          file: {
            sha: item.blobSha,
            markdown: item.markdown,
          },
          languageCode: item.item.language.code,
          localizedRepoPath: item.fullPath,
          sourcePage: item.resolvedSourcePage,
        });

        return {
          path: page.path,
          slug: page.slug,
          commitSha: commit.data.sha,
          page: {
            ...page,
            translationStale: false,
            localizationStatus: "current",
          },
        };
      })
    : [];

  return {
    commitSha: commit.data.sha,
    results,
  };
};
