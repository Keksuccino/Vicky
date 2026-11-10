import { docsSourceCache } from "@/lib/cache";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import {
  assertGitHubCacheAccess,
  beginGitHubCacheAccess,
  trackGitHubCacheWrite,
  type GitHubCacheLease,
} from "@/lib/github-cache-invalidation";
import { getGitHubClient } from "@/lib/github-client";
import { getGitHubDocsCacheDir, readPrivateJsonFile, sourceCacheFilePath, writePrivateJsonFile } from "@/lib/github-docs-cache-files";
import { joinRepoPath, normalizeDocsPath } from "@/lib/github-paths";
import type { GitHubRepoIndex } from "@/lib/github-repo-index";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type { GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

const COMMIT_METADATA_VERSION = 1;
/** History lookups per GraphQL query. One query costs one GraphQL rate-limit point. */
const LOOKUP_BATCH_SIZE = 50;
/** A failed lookup is not repeated for this long, so public page-metadata requests cannot amplify failures. */
const FAILED_LOOKUP_RETRY_MS = 5 * 60_000;

/** "Last updated at/by" of a file version: the latest commit on the branch that touched the path. */
export type GitHubCommitMetadata = {
  updatedAt?: string;
  updatedBy?: string;
};

export type GitHubFileVersion = {
  path: string;
  sha: string;
};

type CommitMetadataEntry = GitHubCommitMetadata & { sha: string };

/**
 * Entries are keyed by repository path and valid only for the blob SHA they were looked up for.
 * Keeping one entry per path (not per version) also makes a file that returns to an earlier blob
 * get looked up again instead of reusing the older commit.
 */
type CommitMetadataState = {
  baseDir: string;
  entries: Map<string, CommitMetadataEntry>;
  failures: Map<string, number>;
  persist: { chain: Promise<void>; queued: boolean };
  ready: Promise<void>;
};

type PersistedCommitMetadata = {
  entries: Array<[path: string, sha: string, updatedAt: string | null, updatedBy: string | null]>;
  kind: "github-commit-metadata";
  savedAt: string;
  sourceKey: string;
  version: typeof COMMIT_METADATA_VERSION;
};

type GitActor = {
  date?: string | null;
  name?: string | null;
  user?: { login?: string | null } | null;
} | null;

type HistoryConnection = { nodes?: Array<{ author?: GitActor; committer?: GitActor } | null> | null } | null;

const lookups = processSingleton("githubCommitMetadata.lookups", () => new Map<string, Promise<GitHubCommitMetadata | undefined>>());

const stateKey = (config: GitHubRuntimeConfig): string => `${gitHubRuntimeCacheKey(config)}|commit-metadata`;

const toMetadata = (entry: CommitMetadataEntry): GitHubCommitMetadata => ({
  ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
});

const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const toIsoTimestamp = (value: unknown): string | undefined => {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().replace(/\.000Z$/, "Z");
};

const readPersistedEntries = async (config: GitHubRuntimeConfig, baseDir: string): Promise<Map<string, CommitMetadataEntry>> => {
  const sourceKey = gitHubRuntimeCacheKey(config);
  const value = (await readPrivateJsonFile(sourceCacheFilePath(baseDir, sourceKey, "commit-metadata"))) as Partial<PersistedCommitMetadata> | null;
  const entries = new Map<string, CommitMetadataEntry>();
  if (!value || value.version !== COMMIT_METADATA_VERSION || value.kind !== "github-commit-metadata" || value.sourceKey !== sourceKey || !Array.isArray(value.entries)) {
    return entries;
  }

  for (const entry of value.entries) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      entries.set(entry[0], { sha: entry[1], updatedAt: optionalString(entry[2]), updatedBy: optionalString(entry[3]) });
    }
  }
  return entries;
};

const loadState = async (config: GitHubRuntimeConfig, baseDir: string): Promise<CommitMetadataState> => {
  const key = stateKey(config);
  let state = docsSourceCache.get(key) as CommitMetadataState | undefined;
  if (!state) {
    const created: CommitMetadataState = {
      baseDir,
      entries: new Map(),
      failures: new Map(),
      persist: { chain: Promise.resolve(), queued: false },
      ready: Promise.resolve(),
    };
    created.ready = readPersistedEntries(config, baseDir).then((persisted) => {
      for (const [repoPath, entry] of persisted) {
        if (!created.entries.has(repoPath)) {
          created.entries.set(repoPath, entry);
        }
      }
    });
    docsSourceCache.set(key, created);
    state = created;
  }

  await state.ready;
  return state;
};

/**
 * Writes the whole state once per burst of changes. Source invalidation removes the state from
 * memory before it deletes the file, so a write that starts afterwards is skipped instead of
 * recreating the file; the tracked promise lets invalidation wait for a write already running.
 */
const persistState = (config: GitHubRuntimeConfig, access: GitHubCacheLease, state: CommitMetadataState): void => {
  if (state.persist.queued) {
    return;
  }

  state.persist.queued = true;
  const key = stateKey(config);
  const sourceKey = gitHubRuntimeCacheKey(config);
  state.persist.chain = state.persist.chain.then(async () => {
    state.persist.queued = false;
    if (docsSourceCache.get(key) !== state) {
      return;
    }

    const entry: PersistedCommitMetadata = {
      entries: Array.from(state.entries, ([repoPath, value]) => [repoPath, value.sha, value.updatedAt ?? null, value.updatedBy ?? null]),
      kind: "github-commit-metadata",
      savedAt: new Date().toISOString(),
      sourceKey,
      version: COMMIT_METADATA_VERSION,
    };
    await writePrivateJsonFile(sourceCacheFilePath(state.baseDir, sourceKey, "commit-metadata"), entry);
  });
  void trackGitHubCacheWrite(access, state.persist.chain).catch(() => undefined);
};

const metadataFromHistory = (history: HistoryConnection | undefined): GitHubCommitMetadata => {
  const node = history?.nodes?.[0];
  const updatedAt = toIsoTimestamp(node?.author?.date) ?? toIsoTimestamp(node?.committer?.date);
  const updatedBy =
    optionalString(node?.author?.user?.login) ??
    optionalString(node?.author?.name) ??
    optionalString(node?.committer?.user?.login) ??
    optionalString(node?.committer?.name);
  return { ...(updatedAt ? { updatedAt } : {}), ...(updatedBy ? { updatedBy } : {}) };
};

/** Looks up the latest commit of up to `LOOKUP_BATCH_SIZE` paths with one GraphQL query. */
const lookUpBatch = async (config: GitHubRuntimeConfig, paths: string[]): Promise<GitHubCommitMetadata[]> => {
  const variables: Record<string, string> = { expression: config.branch, name: config.repo, owner: config.owner };
  const declarations = ["$owner: String!", "$name: String!", "$expression: String!"];
  const fields = paths.map((repoPath, index) => {
    variables[`path${index}`] = repoPath;
    declarations.push(`$path${index}: String!`);
    return `file${index}: history(first: 1, path: $path${index}) { nodes { author { name date user { login } } committer { name date user { login } } } }`;
  });
  const query = `query (${declarations.join(", ")}) { repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Commit { ${fields.join(" ")} } } } }`;
  const data = await getGitHubClient(config).graphql<{ repository?: { object?: Record<string, HistoryConnection> | null } | null }>(query, {
    ...variables,
    request: { idempotent: true, priority: "bulk" },
  });

  const commit = data.repository?.object;
  if (!commit) {
    throw new Error("The configured branch was not found.");
  }
  return paths.map((_, index) => metadataFromHistory(commit[`file${index}`]));
};

type PendingLookup = GitHubFileVersion & {
  key: string;
  resolve: (metadata: GitHubCommitMetadata | undefined) => void;
};

const runLookupBatch = async (config: GitHubRuntimeConfig, access: GitHubCacheLease, state: CommitMetadataState, batch: PendingLookup[]): Promise<void> => {
  try {
    const results = await lookUpBatch(config, batch.map((item) => item.path));
    batch.forEach((item, index) => {
      const metadata = results[index] ?? {};
      state.entries.set(item.path, { sha: item.sha, ...metadata });
      item.resolve(metadata);
    });
    persistState(config, access, state);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[docs] Failed to look up commit metadata for ${batch.length} file${batch.length === 1 ? "" : "s"}: ${message}`);
    const retryAt = Date.now() + FAILED_LOOKUP_RETRY_MS;
    for (const item of batch) {
      state.failures.set(item.key, retryAt);
      item.resolve(undefined);
    }
  } finally {
    for (const item of batch) {
      lookups.delete(item.key);
    }
  }
};

/**
 * Returns the commit metadata of the given file versions. Versions without a stored entry are
 * looked up in batched GraphQL queries through the shared client, once per path and blob SHA;
 * concurrent callers share lookups. Failures leave a version out of the result.
 */
export const resolveGitHubCommitMetadata = async (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  files: GitHubFileVersion[],
  baseDir = getGitHubDocsCacheDir(),
): Promise<Map<string, GitHubCommitMetadata>> => {
  const state = await loadState(config, baseDir);
  const sourceKey = gitHubRuntimeCacheKey(config);
  const result = new Map<string, GitHubCommitMetadata>();
  const waits: Array<Promise<void>> = [];
  const missing: PendingLookup[] = [];
  const now = Date.now();

  for (const file of files) {
    const entry = state.entries.get(file.path);
    if (entry?.sha === file.sha) {
      result.set(file.path, toMetadata(entry));
      continue;
    }

    const key = `${sourceKey}\n${file.path}\n${file.sha}`;
    if ((state.failures.get(key) ?? 0) > now) {
      continue;
    }

    let lookup = lookups.get(key);
    if (!lookup) {
      let resolve!: PendingLookup["resolve"];
      lookup = new Promise((resolveLookup) => {
        resolve = resolveLookup;
      });
      lookups.set(key, lookup);
      missing.push({ ...file, key, resolve });
    }
    waits.push(lookup.then((metadata) => {
      if (metadata) {
        result.set(file.path, metadata);
      }
    }));
  }

  for (let start = 0; start < missing.length; start += LOOKUP_BATCH_SIZE) {
    void runLookupBatch(config, access, state, missing.slice(start, start + LOOKUP_BATCH_SIZE));
  }

  await Promise.all(waits);
  return result;
};

/** Returns the stored metadata of the given file versions (loading the store if needed) without looking anything up. */
export const readStoredGitHubCommitMetadata = async (
  config: GitHubRuntimeConfig,
  files: Iterable<GitHubFileVersion>,
  baseDir = getGitHubDocsCacheDir(),
): Promise<Map<string, GitHubCommitMetadata>> => {
  const state = await loadState(config, baseDir);
  const result = new Map<string, GitHubCommitMetadata>();
  for (const file of files) {
    const entry = state.entries.get(file.path);
    if (entry?.sha === file.sha) {
      result.set(file.path, toMetadata(entry));
    }
  }
  return result;
};

/** Returns stored metadata of a file version without loading or looking anything up. */
export const knownGitHubCommitMetadata = (config: GitHubRuntimeConfig, repoPath: string, sha: string): GitHubCommitMetadata | undefined => {
  const entry = (docsSourceCache.get(stateKey(config)) as CommitMetadataState | undefined)?.entries.get(repoPath);
  return entry?.sha === sha ? toMetadata(entry) : undefined;
};

/** Records metadata known from a commit this app created, so it is never looked up. */
export const recordGitHubCommitMetadata = async (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  files: Array<GitHubFileVersion & { metadata: GitHubCommitMetadata }>,
  baseDir = getGitHubDocsCacheDir(),
): Promise<void> => {
  const state = await loadState(config, baseDir);
  for (const file of files) {
    state.entries.set(file.path, { sha: file.sha, ...file.metadata });
  }
  persistState(config, access, state);
};

/**
 * Drops entries of files that the index no longer lists in that version, then waits until every
 * scheduled write is on disk, so a restart right after a refresh finds what it looked up.
 */
export const retainGitHubCommitMetadata = async (config: GitHubRuntimeConfig, access: GitHubCacheLease, index: GitHubRepoIndex, baseDir = getGitHubDocsCacheDir()): Promise<void> => {
  const state = await loadState(config, baseDir);
  let removed = false;
  for (const [repoPath, entry] of state.entries) {
    if (index.files.get(repoPath)?.sha !== entry.sha) {
      state.entries.delete(repoPath);
      removed = true;
    }
  }
  if (removed) {
    persistState(config, access, state);
  }
  await state.persist.chain;
};

const readStringField = (source: Record<string, unknown>, key: string): string | undefined => optionalString(source[key]);

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** Reads author metadata from a REST commit object, such as the one a contents write returns. */
export const extractCommitMetadata = (commit: unknown): GitHubCommitMetadata => {
  const commitRecord = asRecord(commit);
  const author = asRecord(commitRecord.author);
  const committer = asRecord(commitRecord.committer);
  const nestedCommit = asRecord(commitRecord.commit);
  const nestedAuthor = asRecord(nestedCommit.author);
  const nestedCommitter = asRecord(nestedCommit.committer);

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

/** Adds "last updated" metadata to a source page that does not carry it yet. */
export const hydrateGitHubDocPageMetadata = async <T extends Pick<GitHubDocPage, "path" | "sha" | "updatedAt" | "updatedBy">>(
  config: GitHubRuntimeConfig,
  page: T,
): Promise<T> => {
  const access = beginGitHubCacheAccess(config);
  if (page.updatedAt) {
    return page;
  }

  const repoPath = joinRepoPath(normalizeDocsPath(config.docsPath), page.path);
  const metadata = (await resolveGitHubCommitMetadata(config, access, [{ path: repoPath, sha: page.sha }])).get(repoPath);
  assertGitHubCacheAccess(access);
  if (!metadata) {
    return page;
  }

  return {
    ...page,
    updatedAt: metadata.updatedAt ?? page.updatedAt,
    updatedBy: metadata.updatedBy ?? page.updatedBy,
  };
};
