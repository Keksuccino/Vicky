import { docsSourceCache, getDocsCacheTtlMs } from "@/lib/cache";
import {
  assertGitHubCacheAccess,
  beginGitHubCacheAccess,
  trackGitHubCacheWrite,
  type GitHubCacheLease,
} from "@/lib/github-cache-invalidation";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import {
  recordGitHubCommitMetadata,
  resolveGitHubCommitMetadata,
  retainGitHubCommitMetadata,
  type GitHubCommitMetadata,
} from "@/lib/github-commit-metadata";
import {
  loadGitHubBlobs,
  pinGitHubBlobs,
  storeCommittedGitHubBlob,
  sweepUnreferencedGitHubBlobs,
  type GitHubBlobRecord,
} from "@/lib/github-content-store";
import { clearDerivedGitHubDocsCache, clearDerivedGitHubDocsMemory, type GitHubDocsPagesSnapshot } from "@/lib/github-derived-caches";
import { getGitHubDocsCacheDir, removeLegacyDocsSnapshots } from "@/lib/github-docs-cache-files";
import { ensureMarkdownPath, normalizeDocsPath, normalizePathValue, prettyNameFromPath, relativePathToSlug, stripRepoRoot } from "@/lib/github-paths";
import {
  fetchGitHubRepoIndex,
  readPersistentGitHubRepoIndex,
  withCommittedRepoIndexFiles,
  writePersistentGitHubRepoIndex,
  type GitHubRepoIndex,
} from "@/lib/github-repo-index";
import { ApiError, badRequest } from "@/lib/http";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type { GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig, GitHubValidationResult } from "@/lib/types";

/** Earliest retry of a background refresh after it failed (or the refresh interval, if shorter). */
const FAILED_REFRESH_RETRY_MS = 30_000;

/**
 * The published state of one docs source: the repository index and the source pages built from
 * it. Pages reference the parsed blob strings, so the view adds no second copy of page bodies.
 */
export type GitHubDocsSourceView = GitHubDocsPagesSnapshot & {
  /** Last time the index was confirmed against GitHub. */
  checkedAtMs: number;
  /** Sequence number of the refresh that last confirmed the index; 0 when loaded from disk. */
  confirmedBy: number;
  index: GitHubRepoIndex;
  /** Pages by NFC-normalized relative path and slug; the first page wins when two share one. */
  pagesByPath: Map<string, GitHubDocPage>;
  pagesBySlug: Map<string, GitHubDocPage>;
  /** Earliest next background refresh after a failed one. */
  retryAtMs: number;
};

type SourceFile = {
  path: string;
  repoPath: string;
  sha: string;
  slug: string;
};

type SourceRefresh = {
  promise: Promise<GitHubDocsSourceView>;
  /** Sequence number assigned when the refresh starts; infinite while it waits for the one before it. */
  sequence: number;
};

type DocsSourceLoadState = {
  maintenance: Promise<void> | null;
  /** Number of refreshes started in this process; orders refreshes without relying on clock resolution. */
  refreshSequence: number;
  refreshes: Map<string, SourceRefresh>;
  viewLoads: Map<string, Promise<GitHubDocsSourceView>>;
};

const loadState = processSingleton("githubDocsSource.loadState", (): DocsSourceLoadState => ({
  maintenance: null,
  refreshSequence: 0,
  refreshes: new Map(),
  viewLoads: new Map(),
}));

const sourceViewKey = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|source-view`;

const generationKey = (config: GitHubRuntimeConfig, access: GitHubCacheLease): string => `${gitHubRuntimeCacheKey(config)}|generation-${access.generation}`;

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

export const assertValidGitHubRuntimeConfig = (config: GitHubRuntimeConfig): void => {
  const validation = validateGitHubRuntimeConfig(config);
  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }
};

export const createGitHubDocPage = (
  item: Pick<GitHubDocTreeItem, "path" | "slug">,
  record: GitHubBlobRecord,
  metadata: GitHubCommitMetadata,
): GitHubDocPage => ({
  path: item.path,
  slug: item.slug,
  sha: record.sha,
  title: record.title,
  description: record.description,
  content: record.content,
  markdown: record.markdown,
  headings: record.headings,
  includeInPlaintextExport: record.includeInPlaintextExport,
  updatedAt: metadata.updatedAt,
  updatedBy: metadata.updatedBy,
});

export const treeItemFromPage = (page: GitHubDocPage): GitHubDocTreeItem => ({
  path: page.path,
  slug: page.slug,
  name: page.title.trim() || prettyNameFromPath(page.path),
});

export const sortTreeItems = (items: GitHubDocTreeItem[]): GitHubDocTreeItem[] => [...items].sort((left, right) => left.path.localeCompare(right.path));

const listSourceFiles = (config: GitHubRuntimeConfig, index: GitHubRepoIndex): SourceFile[] => {
  const docsRoot = normalizeDocsPath(config.docsPath);
  const files: SourceFile[] = [];

  for (const [repoPath, file] of index.files) {
    try {
      const relativePath = stripRepoRoot(docsRoot, normalizePathValue(repoPath));
      if (!relativePath) {
        continue;
      }

      const markdownPath = ensureMarkdownPath(relativePath);
      files.push({ path: markdownPath, repoPath, sha: file.sha, slug: relativePathToSlug(markdownPath) });
    } catch {
      // Paths that cannot address a docs page are not served.
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const createSourceView = (index: GitHubRepoIndex, pages: GitHubDocPage[], checkedAtMs: number, confirmedBy: number): GitHubDocsSourceView => {
  const pagesByPath = new Map<string, GitHubDocPage>();
  const pagesBySlug = new Map<string, GitHubDocPage>();
  for (const page of pages) {
    const pathKey = page.path.normalize("NFC");
    const slugKey = page.slug.normalize("NFC");
    if (!pagesByPath.has(pathKey)) {
      pagesByPath.set(pathKey, page);
    }
    if (!pagesBySlug.has(slugKey)) {
      pagesBySlug.set(slugKey, page);
    }
  }

  return { checkedAtMs, confirmedBy, index, pages, pagesByPath, pagesBySlug, retryAtMs: 0, tree: pages.map(treeItemFromPage) };
};

/**
 * Builds the pages of an index. Pages of unchanged files are reused from the previous view;
 * every other blob comes from the content store, which downloads only SHAs it does not hold.
 * Commit metadata is resolved for files that lack it, best effort: a failed lookup leaves the
 * page without "last updated" data instead of failing the whole build.
 */
const buildSourceView = async (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  index: GitHubRepoIndex,
  options: { baseDir: string; checkedAtMs: number; confirmedBy: number; overrides?: Map<string, GitHubDocPage>; previous?: GitHubDocsSourceView },
): Promise<GitHubDocsSourceView> => {
  const files = listSourceFiles(config, index);
  const previousByPath = new Map(options.previous?.pages.map((page) => [page.path, page]));
  const reusable = (file: SourceFile): GitHubDocPage | undefined => {
    const override = options.overrides?.get(file.repoPath);
    if (override) {
      return override;
    }
    const previousPage = previousByPath.get(file.path);
    return previousPage?.sha === file.sha && previousPage.slug === file.slug ? previousPage : undefined;
  };

  const [metadata, records] = await Promise.all([
    resolveGitHubCommitMetadata(
      config,
      access,
      files.filter((file) => !reusable(file)?.updatedAt).map((file) => ({ path: file.repoPath, sha: file.sha })),
      options.baseDir,
    ),
    loadGitHubBlobs(config, files.filter((file) => !reusable(file)).map((file) => file.sha), options.baseDir),
  ]);

  const pages = files.map((file): GitHubDocPage => {
    const fileMetadata = metadata.get(file.repoPath);
    const existing = reusable(file);
    if (existing) {
      return existing.updatedAt || !fileMetadata?.updatedAt ? existing : { ...existing, updatedAt: fileMetadata.updatedAt, updatedBy: fileMetadata.updatedBy };
    }

    const record = records.get(file.sha);
    if (!record) {
      throw new Error(`Blob ${file.sha} of ${file.repoPath} is missing from the content store.`);
    }
    return createGitHubDocPage(file, record, fileMetadata ?? {});
  });

  return createSourceView(index, pages, options.checkedAtMs, options.confirmedBy);
};

/** The published view of a source, if one is in memory. Never contacts GitHub. */
export const readPublishedGitHubDocsSourceView = (config: GitHubRuntimeConfig): GitHubDocsSourceView | undefined =>
  docsSourceCache.get(sourceViewKey(config)) as GitHubDocsSourceView | undefined;

const publishView = (config: GitHubRuntimeConfig, access: GitHubCacheLease, view: GitHubDocsSourceView): void => {
  assertGitHubCacheAccess(access);
  docsSourceCache.set(sourceViewKey(config), view);
};

const persistIndex = async (config: GitHubRuntimeConfig, access: GitHubCacheLease, index: GitHubRepoIndex, baseDir: string): Promise<void> => {
  assertGitHubCacheAccess(access);
  await trackGitHubCacheWrite(access, writePersistentGitHubRepoIndex(config, index, baseDir));
};

const blobShas = (view: Pick<GitHubDocsSourceView, "index"> | undefined): Set<string> => new Set(Array.from(view?.index.files.values() ?? [], (file) => file.sha));

/** Prunes what depended on pages that changed, and stored data nothing references anymore. */
const finishSourceChange = async (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  previous: GitHubDocsSourceView | undefined,
  next: GitHubDocsSourceView,
  baseDir: string,
): Promise<void> => {
  if (previous) {
    await clearDerivedGitHubDocsCache(config, { snapshots: { previous, next } });
  } else {
    // Without earlier pages there is nothing to compare; translation and render entries are
    // keyed by source content, so only in-memory derivations need rebuilding.
    clearDerivedGitHubDocsMemory(config);
  }

  await retainGitHubCommitMetadata(config, access, next.index, baseDir);
  const nextShas = blobShas(next);
  if (Array.from(blobShas(previous)).some((sha) => !nextShas.has(sha))) {
    await sweepUnreferencedGitHubBlobs(baseDir);
  }
};

/** Waits until GitHub accepts requests again after a rate limit, otherwise a short, bounded pause. */
const failedRefreshRetryDelayMs = (error: unknown): number => {
  const retryAfterSeconds = error instanceof ApiError ? Number(new Headers(error.headers).get("retry-after")) : Number.NaN;
  const fallbackMs = Math.min(getDocsCacheTtlMs(), FAILED_REFRESH_RETRY_MS);
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.max(fallbackMs, retryAfterSeconds * 1000) : fallbackMs;
};

/**
 * Fetches the index and, only if files changed, builds and publishes a new view atomically:
 * blobs are stored before the index that references them is written, and readers keep the
 * previous view until the new one replaces it. A refresh started for an older cache generation
 * (the source was invalidated or saved meanwhile) is discarded at publication.
 */
const runRefresh = async (config: GitHubRuntimeConfig, access: GitHubCacheLease, baseDir: string, sequence: number): Promise<GitHubDocsSourceView> => {
  const previous = readPublishedGitHubDocsSourceView(config);

  try {
    const { filesChanged, index } = await fetchGitHubRepoIndex(config, previous?.index);
    assertGitHubCacheAccess(access);
    const checkedAtMs = Date.now();

    if (previous && !filesChanged) {
      if (index.treeSha !== previous.index.treeSha || index.etag !== previous.index.etag) {
        await persistIndex(config, access, index, baseDir);
      }
      const next: GitHubDocsSourceView = { ...previous, checkedAtMs, confirmedBy: sequence, index, retryAtMs: 0 };
      publishView(config, access, next);
      return next;
    }

    const unpin = pinGitHubBlobs(blobShas({ index }));
    try {
      const next = await buildSourceView(config, access, index, { baseDir, checkedAtMs, confirmedBy: sequence, previous });
      await persistIndex(config, access, index, baseDir);
      publishView(config, access, next);
      unpin();
      await finishSourceChange(config, access, previous, next, baseDir);
      return next;
    } finally {
      unpin();
    }
  } catch (error: unknown) {
    // A failure caused by the source changing mid-refresh is reported as that change (409).
    assertGitHubCacheAccess(access);
    const current = readPublishedGitHubDocsSourceView(config);
    if (current) {
      current.retryAtMs = Date.now() + failedRefreshRetryDelayMs(error);
    }
    throw error;
  }
};

/**
 * Starts a refresh or joins the running one. With `startedAfter`, a running refresh that started
 * at or before that sequence number does not count: the caller (an explicit refresh) waits for it
 * and gets a new one that every other explicit refresh arriving in the meantime shares.
 */
const refreshSourceView = (config: GitHubRuntimeConfig, access: GitHubCacheLease, baseDir: string, startedAfter?: number): Promise<GitHubDocsSourceView> => {
  const key = generationKey(config, access);
  const running = loadState.refreshes.get(key);
  if (running && (startedAfter === undefined || running.sequence > startedAfter)) {
    return running.promise;
  }

  const refresh: SourceRefresh = { promise: Promise.resolve(undefined as unknown as GitHubDocsSourceView), sequence: Number.POSITIVE_INFINITY };
  const previousRun = running ? running.promise.then(() => undefined, () => undefined) : Promise.resolve();
  refresh.promise = previousRun
    .then(() => {
      loadState.refreshSequence += 1;
      refresh.sequence = loadState.refreshSequence;
      return runRefresh(config, access, baseDir, refresh.sequence);
    })
    .finally(() => {
      if (loadState.refreshes.get(key) === refresh) {
        loadState.refreshes.delete(key);
      }
    });
  loadState.refreshes.set(key, refresh);
  return refresh.promise;
};

const isStaleSourceError = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

const refreshInBackground = (config: GitHubRuntimeConfig, access: GitHubCacheLease, baseDir: string): void => {
  void refreshSourceView(config, access, baseDir).catch((error: unknown) => {
    if (!isStaleSourceError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[docs] Background docs refresh failed; serving the previous docs: ${message}`);
    }
  });
};

/** Removes obsolete snapshot files and orphaned blobs once per process, before the first load. */
const runDocsCacheMaintenance = (baseDir: string): Promise<void> => {
  loadState.maintenance ??= (async () => {
    await removeLegacyDocsSnapshots(baseDir);
    await sweepUnreferencedGitHubBlobs(baseDir);
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[docs] Docs cache maintenance failed: ${message}`);
  });
  return loadState.maintenance;
};

/** Returns the published view, or loads it from the persisted index, or from GitHub on a cold start. */
const ensureSourceView = (config: GitHubRuntimeConfig, access: GitHubCacheLease, baseDir: string): Promise<GitHubDocsSourceView> => {
  const published = readPublishedGitHubDocsSourceView(config);
  if (published) {
    return Promise.resolve(published);
  }

  const key = generationKey(config, access);
  const pending = loadState.viewLoads.get(key);
  if (pending) {
    return pending;
  }

  const load = (async (): Promise<GitHubDocsSourceView> => {
    await runDocsCacheMaintenance(baseDir);
    const persisted = await readPersistentGitHubRepoIndex(config, baseDir);
    assertGitHubCacheAccess(access);
    if (persisted) {
      try {
        const view = await buildSourceView(config, access, persisted, { baseDir, checkedAtMs: Date.parse(persisted.checkedAt), confirmedBy: 0 });
        publishView(config, access, view);
        return view;
      } catch (error: unknown) {
        if (isStaleSourceError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[docs] Persisted docs index could not be loaded; fetching it again: ${message}`);
      }
    }

    return refreshSourceView(config, access, baseDir);
  })().finally(() => {
    if (loadState.viewLoads.get(key) === load) {
      loadState.viewLoads.delete(key);
    }
  });
  loadState.viewLoads.set(key, load);
  return load;
};

const isRefreshDue = (view: GitHubDocsSourceView, now = Date.now()): boolean =>
  now >= view.checkedAtMs + getDocsCacheTtlMs() && now >= view.retryAtMs;

/**
 * Returns the current docs view. Once the refresh interval has passed, the current view is still
 * returned while a background refresh runs (stale-while-revalidate). `forceRefresh` waits for a
 * refresh that starts after the call, unless the view was just fetched for this call.
 */
export const loadGitHubDocsSourceView = async (config: GitHubRuntimeConfig, options?: { forceRefresh?: boolean }): Promise<GitHubDocsSourceView> => {
  const requestedAfter = loadState.refreshSequence;
  const access = beginGitHubCacheAccess(config);
  assertValidGitHubRuntimeConfig(config);
  const baseDir = getGitHubDocsCacheDir();
  const view = await ensureSourceView(config, access, baseDir);
  assertGitHubCacheAccess(access);

  if (options?.forceRefresh && view.confirmedBy <= requestedAfter) {
    const refreshed = await refreshSourceView(config, access, baseDir, requestedAfter);
    assertGitHubCacheAccess(access);
    return refreshed;
  }

  if (isRefreshDue(view)) {
    refreshInBackground(config, access, baseDir);
  }
  return view;
};

/**
 * Applies a committed source page to the index, the content store, the commit metadata, and the
 * published view, so the page is served immediately without asking GitHub again. Without a
 * published view, only the persisted index (if any) is updated for the next load.
 */
export const applyCommittedGitHubDocPage = async (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  committed: { metadata: GitHubCommitMetadata; page: GitHubDocPage; repoPath: string },
): Promise<void> => {
  const baseDir = getGitHubDocsCacheDir();
  const unpin = pinGitHubBlobs([committed.page.sha]);
  try {
    const record = await storeCommittedGitHubBlob(committed.page.sha, committed.page.markdown, baseDir);
    await recordGitHubCommitMetadata(config, access, [{ metadata: committed.metadata, path: committed.repoPath, sha: committed.page.sha }], baseDir);
    const committedFile = { repoPath: committed.repoPath, sha: committed.page.sha, size: record?.byteLength ?? Buffer.byteLength(committed.page.markdown, "utf8") };
    assertGitHubCacheAccess(access);

    const previous = readPublishedGitHubDocsSourceView(config);
    if (!previous) {
      const persisted = await readPersistentGitHubRepoIndex(config, baseDir);
      if (persisted) {
        await persistIndex(config, access, withCommittedRepoIndexFiles(persisted, [committedFile]), baseDir);
      }
      unpin();
      await clearDerivedGitHubDocsCache(config, { changedSourceSlugs: [committed.page.slug] });
      return;
    }

    const index = withCommittedRepoIndexFiles(previous.index, [committedFile]);
    const next = await buildSourceView(config, access, index, {
      baseDir,
      checkedAtMs: previous.checkedAtMs,
      confirmedBy: previous.confirmedBy,
      overrides: new Map([[committed.repoPath, committed.page]]),
      previous,
    });
    next.retryAtMs = previous.retryAtMs;
    await persistIndex(config, access, index, baseDir);
    publishView(config, access, next);
    unpin();
    await finishSourceChange(config, access, previous, next, baseDir);
  } finally {
    unpin();
  }
};
