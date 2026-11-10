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
import {
  deleteAllPersistentGitHubDocsSnapshots,
  deletePersistentGitHubDocsSnapshot,
} from "@/lib/docs-snapshot-store";
import { gitHubDocsLogicalSourceKey, gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { cleanupLegacyGitHubLogicalSourceCaches } from "@/lib/github-legacy-cache-cleanup";
import { ApiError } from "@/lib/http";
import {
  deletePersistentRenderedMarkdownWhere,
  recordRenderedMarkdownCacheMutation,
} from "@/lib/markdown-render-cache-store";
import { processSingleton } from "@/lib/process-singleton.mjs";
import { deletePersistentTranslationCacheWhere } from "@/lib/translation-cache-store";
import type { GitHubRuntimeConfig } from "@/lib/types";

type GitHubCacheRuntimeState = {
  allInvalidating: boolean;
  generations: Map<string, number>;
  mutationBarriers: Map<string, Promise<void>>;
  revoked: Set<string>;
  writes: Map<string, Set<{ generation: number; promise: Promise<unknown> }>>;
};

export type GitHubCacheLease = {
  generation: number;
  runtimeKey: string;
};

export type GitHubCacheInvalidationResult = {
  renderedEntries: number;
  snapshotEntries: number;
  translationEntries: number;
};

const runtimeState = processSingleton("githubCache.runtimeState", (): GitHubCacheRuntimeState => ({
  allInvalidating: false,
  generations: new Map(),
  mutationBarriers: new Map(),
  revoked: new Set(),
  writes: new Map(),
}));

const staleSourceError = (): ApiError =>
  new ApiError(409, "The docs source or authorization changed while this request was running. Retry the request.");

export const beginGitHubCacheAccess = (config: GitHubRuntimeConfig): GitHubCacheLease => {
  const runtimeKey = gitHubRuntimeCacheKey(config);
  if (runtimeState.allInvalidating || runtimeState.revoked.has(runtimeKey)) {
    throw staleSourceError();
  }

  // Register read-only sources too. Global invalidation must advance their generation;
  // otherwise generation-keyed indexes or negative caches could survive a clear-all.
  const generation = runtimeState.generations.get(runtimeKey) ?? 0;
  if (!runtimeState.generations.has(runtimeKey)) {
    runtimeState.generations.set(runtimeKey, generation);
  }

  return { generation, runtimeKey };
};

export const assertGitHubCacheAccess = (lease: GitHubCacheLease): void => {
  if (runtimeState.revoked.has(lease.runtimeKey) || (runtimeState.generations.get(lease.runtimeKey) ?? 0) !== lease.generation) {
    throw staleSourceError();
  }
};

export const assertGitHubRuntimeConfigActive = (config: GitHubRuntimeConfig): void => {
  beginGitHubCacheAccess(config);
};

export const advanceGitHubCacheGeneration = (config: GitHubRuntimeConfig, options?: { revoke?: boolean }): number => {
  const runtimeKey = gitHubRuntimeCacheKey(config);
  const generation = (runtimeState.generations.get(runtimeKey) ?? 0) + 1;
  runtimeState.generations.set(runtimeKey, generation);
  if (options?.revoke) {
    runtimeState.revoked.add(runtimeKey);
  }
  return generation;
};

export const activateGitHubRuntimeConfig = (config: GitHubRuntimeConfig): void => {
  runtimeState.revoked.delete(gitHubRuntimeCacheKey(config));
};

export const trackGitHubCacheWrite = async <T>(lease: GitHubCacheLease, write: Promise<T>): Promise<T> => {
  let writes = runtimeState.writes.get(lease.runtimeKey);
  if (!writes) {
    writes = new Set();
    runtimeState.writes.set(lease.runtimeKey, writes);
  }

  const tracked = { generation: lease.generation, promise: write as Promise<unknown> };
  writes.add(tracked);
  try {
    return await write;
  } finally {
    writes.delete(tracked);
    if (writes.size === 0) {
      runtimeState.writes.delete(lease.runtimeKey);
    }
  }
};

const waitForOlderCacheWrites = async (runtimeKey: string, generation: number): Promise<void> => {
  const writes = runtimeState.writes.get(runtimeKey);
  if (!writes) {
    return;
  }

  const olderWrites = Array.from(writes)
    .filter((entry) => entry.generation < generation)
    .map((entry) => entry.promise);
  await Promise.allSettled(olderWrites);
};

/** Establishes a clean generation boundary after a successful remote mutation. */
export const prepareGitHubCacheMutation = async (config: GitHubRuntimeConfig): Promise<GitHubCacheLease> => {
  const runtimeKey = gitHubRuntimeCacheKey(config);
  const previousBarrier = runtimeState.mutationBarriers.get(runtimeKey) ?? Promise.resolve();
  let releaseBarrier!: () => void;
  const currentTurn = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const currentBarrier = previousBarrier.catch(() => undefined).then(() => currentTurn);
  runtimeState.mutationBarriers.set(runtimeKey, currentBarrier);

  await previousBarrier.catch(() => undefined);
  try {
    if (runtimeState.revoked.has(runtimeKey)) {
      throw staleSourceError();
    }

    const generation = advanceGitHubCacheGeneration(config, { revoke: true });
    await waitForOlderCacheWrites(runtimeKey, generation);

    if (runtimeState.generations.get(runtimeKey) === generation) {
      runtimeState.revoked.delete(runtimeKey);
    }

    return beginGitHubCacheAccess(config);
  } finally {
    releaseBarrier();
    if (runtimeState.mutationBarriers.get(runtimeKey) === currentBarrier) {
      runtimeState.mutationBarriers.delete(runtimeKey);
    }
  }
};

const clearMemoryCachesForPrefix = (prefix: string): void => {
  docsSnapshotCache.deleteWhere((key) => key.startsWith(prefix));
  docsTreeCache.deleteWhere((key) => key.startsWith(prefix));
  docsPageCache.deleteWhere((key) => key.startsWith(prefix));
  docsSearchCorpusCache.deleteWhere((key) => key.startsWith(prefix));
  aiPlaintextDocsCache.deleteWhere((key) => key.startsWith(prefix));
  translatedDocsPageCache.deleteWhere((key) => key.startsWith(prefix));
  translatedDocsTitleCache.deleteWhere((key) => key.startsWith(prefix));
  renderedMarkdownCache.deleteWhere((key) => key.startsWith(prefix));
};

/**
 * Invalidates one exact source/authorization epoch. Advancing the generation before
 * filesystem cleanup ensures concurrent work cannot repopulate entries after deletion.
 */
export const invalidateGitHubRuntimeCaches = async (
  config: GitHubRuntimeConfig,
  options?: { reason?: string; revoke?: boolean },
): Promise<GitHubCacheInvalidationResult> => {
  const runtimeKey = gitHubRuntimeCacheKey(config);
  const prefix = `${runtimeKey}|`;
  const wasRevoked = runtimeState.revoked.has(runtimeKey);
  const generation = advanceGitHubCacheGeneration(config, { revoke: true });
  clearMemoryCachesForPrefix(prefix);
  await waitForOlderCacheWrites(runtimeKey, generation);

  const [snapshotDeleted, renderedEntries, translationEntries] = await Promise.all([
    deletePersistentGitHubDocsSnapshot(config),
    deletePersistentRenderedMarkdownWhere((key) => key.startsWith(prefix)),
    deletePersistentTranslationCacheWhere((key) => key.startsWith(prefix)),
  ]);

  await recordRenderedMarkdownCacheMutation({
    deletedEntries: renderedEntries,
    reason: options?.reason ?? "docs-source-invalidation",
    scope: "all",
    target: gitHubDocsLogicalSourceKey(config),
  });

  if (!options?.revoke && !wasRevoked) {
    activateGitHubRuntimeConfig(config);
  }

  return {
    renderedEntries,
    snapshotEntries: snapshotDeleted ? 1 : 0,
    translationEntries,
  };
};

export const transitionGitHubRuntimeCaches = async (
  previousConfig: GitHubRuntimeConfig,
  nextConfig: GitHubRuntimeConfig,
): Promise<GitHubCacheInvalidationResult> => {
  const previousKey = gitHubRuntimeCacheKey(previousConfig);
  const nextKey = gitHubRuntimeCacheKey(nextConfig);
  activateGitHubRuntimeConfig(nextConfig);
  if (previousKey === nextKey) {
    return { renderedEntries: 0, snapshotEntries: 0, translationEntries: 0 };
  }

  const currentResult = await invalidateGitHubRuntimeCaches(previousConfig, {
    reason: "docs-source-settings-change",
    revoke: true,
  });
  const legacyResult = await cleanupLegacyGitHubLogicalSourceCaches(previousConfig, { recordMutation: false });

  return {
    renderedEntries: legacyResult.renderedEntries + currentResult.renderedEntries,
    snapshotEntries: legacyResult.snapshotEntries + currentResult.snapshotEntries,
    translationEntries: legacyResult.translationEntries + currentResult.translationEntries,
  };
};

export const invalidateAllGitHubRuntimeCaches = async (): Promise<GitHubCacheInvalidationResult> => {
  const previouslyRevoked = new Set(runtimeState.revoked);
  runtimeState.allInvalidating = true;
  const runtimeKeys = new Set([...runtimeState.generations.keys(), ...runtimeState.writes.keys()]);
  const generations = new Map<string, number>();
  for (const runtimeKey of runtimeKeys) {
    const generation = (runtimeState.generations.get(runtimeKey) ?? 0) + 1;
    runtimeState.generations.set(runtimeKey, generation);
    runtimeState.revoked.add(runtimeKey);
    generations.set(runtimeKey, generation);
  }

  try {
    docsSnapshotCache.clear();
    docsTreeCache.clear();
    docsPageCache.clear();
    docsSearchCorpusCache.clear();
    aiPlaintextDocsCache.clear();
    translatedDocsPageCache.clear();
    translatedDocsTitleCache.clear();
    renderedMarkdownCache.clear();

    await Promise.all(Array.from(generations, ([runtimeKey, generation]) => waitForOlderCacheWrites(runtimeKey, generation)));

    const [snapshotEntries, renderedEntries, translationEntries] = await Promise.all([
      deleteAllPersistentGitHubDocsSnapshots(),
      deletePersistentRenderedMarkdownWhere(() => true),
      deletePersistentTranslationCacheWhere(() => true),
    ]);

    await recordRenderedMarkdownCacheMutation({
      deletedEntries: renderedEntries,
      reason: "all-docs-sources-invalidation",
      scope: "all",
    });

    return { renderedEntries, snapshotEntries, translationEntries };
  } finally {
    runtimeState.allInvalidating = false;
    for (const runtimeKey of runtimeKeys) {
      if (!previouslyRevoked.has(runtimeKey)) {
        runtimeState.revoked.delete(runtimeKey);
      }
    }
  }
};
