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

const GITHUB_CACHE_RUNTIME_STATE_KEY = Symbol.for("vicky.githubCache.runtimeState");

const getRuntimeState = (): GitHubCacheRuntimeState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, GitHubCacheRuntimeState | undefined>;
  let state = globalState[GITHUB_CACHE_RUNTIME_STATE_KEY];

  if (!state) {
    state = {
      allInvalidating: false,
      generations: new Map(),
      mutationBarriers: new Map(),
      revoked: new Set(),
      writes: new Map(),
    };
    globalState[GITHUB_CACHE_RUNTIME_STATE_KEY] = state;
  }

  return state;
};

const staleSourceError = (): ApiError =>
  new ApiError(409, "The docs source or authorization changed while this request was running. Retry the request.");

export const beginGitHubCacheAccess = (config: GitHubRuntimeConfig): GitHubCacheLease => {
  const runtimeKey = gitHubRuntimeCacheKey(config);
  const state = getRuntimeState();
  if (state.allInvalidating || state.revoked.has(runtimeKey)) {
    throw staleSourceError();
  }

  // Register read-only sources too. Global invalidation must advance their generation;
  // otherwise generation-keyed indexes or negative caches could survive a clear-all.
  const generation = state.generations.get(runtimeKey) ?? 0;
  if (!state.generations.has(runtimeKey)) {
    state.generations.set(runtimeKey, generation);
  }

  return { generation, runtimeKey };
};

export const assertGitHubCacheAccess = (lease: GitHubCacheLease): void => {
  const state = getRuntimeState();
  if (state.revoked.has(lease.runtimeKey) || (state.generations.get(lease.runtimeKey) ?? 0) !== lease.generation) {
    throw staleSourceError();
  }
};

export const assertGitHubRuntimeConfigActive = (config: GitHubRuntimeConfig): void => {
  beginGitHubCacheAccess(config);
};

export const advanceGitHubCacheGeneration = (config: GitHubRuntimeConfig, options?: { revoke?: boolean }): number => {
  const runtimeKey = gitHubRuntimeCacheKey(config);
  const state = getRuntimeState();
  const generation = (state.generations.get(runtimeKey) ?? 0) + 1;
  state.generations.set(runtimeKey, generation);
  if (options?.revoke) {
    state.revoked.add(runtimeKey);
  }
  return generation;
};

export const activateGitHubRuntimeConfig = (config: GitHubRuntimeConfig): void => {
  getRuntimeState().revoked.delete(gitHubRuntimeCacheKey(config));
};

export const trackGitHubCacheWrite = async <T>(lease: GitHubCacheLease, write: Promise<T>): Promise<T> => {
  const state = getRuntimeState();
  let writes = state.writes.get(lease.runtimeKey);
  if (!writes) {
    writes = new Set();
    state.writes.set(lease.runtimeKey, writes);
  }

  const tracked = { generation: lease.generation, promise: write as Promise<unknown> };
  writes.add(tracked);
  try {
    return await write;
  } finally {
    writes.delete(tracked);
    if (writes.size === 0) {
      state.writes.delete(lease.runtimeKey);
    }
  }
};

const waitForOlderCacheWrites = async (runtimeKey: string, generation: number): Promise<void> => {
  const writes = getRuntimeState().writes.get(runtimeKey);
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
  const state = getRuntimeState();
  const previousBarrier = state.mutationBarriers.get(runtimeKey) ?? Promise.resolve();
  let releaseBarrier!: () => void;
  const currentTurn = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const currentBarrier = previousBarrier.catch(() => undefined).then(() => currentTurn);
  state.mutationBarriers.set(runtimeKey, currentBarrier);

  await previousBarrier.catch(() => undefined);
  try {
    if (state.revoked.has(runtimeKey)) {
      throw staleSourceError();
    }

    const generation = advanceGitHubCacheGeneration(config, { revoke: true });
    await waitForOlderCacheWrites(runtimeKey, generation);

    if (state.generations.get(runtimeKey) === generation) {
      state.revoked.delete(runtimeKey);
    }

    return beginGitHubCacheAccess(config);
  } finally {
    releaseBarrier();
    if (state.mutationBarriers.get(runtimeKey) === currentBarrier) {
      state.mutationBarriers.delete(runtimeKey);
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
  const wasRevoked = getRuntimeState().revoked.has(runtimeKey);
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
  const state = getRuntimeState();
  const previouslyRevoked = new Set(state.revoked);
  state.allInvalidating = true;
  const runtimeKeys = new Set([...state.generations.keys(), ...state.writes.keys()]);
  const generations = new Map<string, number>();
  for (const runtimeKey of runtimeKeys) {
    const generation = (state.generations.get(runtimeKey) ?? 0) + 1;
    state.generations.set(runtimeKey, generation);
    state.revoked.add(runtimeKey);
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
    state.allInvalidating = false;
    for (const runtimeKey of runtimeKeys) {
      if (!previouslyRevoked.has(runtimeKey)) {
        state.revoked.delete(runtimeKey);
      }
    }
  }
};
