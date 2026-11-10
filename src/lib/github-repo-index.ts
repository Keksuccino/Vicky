import path from "node:path";

import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { getGitHubClient, gitHubErrorStatus } from "@/lib/github-client";
import {
  listPrivateDirectory,
  readPrivateJsonFile,
  sourceCacheDirsPath,
  sourceCacheFilePath,
  writePrivateJsonFile,
} from "@/lib/github-docs-cache-files";
import { isGitObjectSha, markdownExtensionRegex } from "@/lib/github-paths";
import type { GitHubRuntimeConfig } from "@/lib/types";

const REPO_INDEX_VERSION = 1;

export type GitHubRepoIndexFile = {
  sha: string;
  size: number;
};

/**
 * Every Markdown file of the configured branch, source docs and localizations alike, keyed by
 * its exact repository path. One recursive tree request produces it, and a refresh whose tree
 * SHA (or ETag) is unchanged costs that single request.
 */
export type GitHubRepoIndex = {
  checkedAt: string;
  etag?: string;
  files: ReadonlyMap<string, GitHubRepoIndexFile>;
  /** Root tree the files were listed from; unknown after local commits until the next listing. */
  treeSha?: string;
};

export type GitHubRepoIndexFetchResult = {
  /** Whether any indexed file was added, removed, or changed its blob. */
  filesChanged: boolean;
  index: GitHubRepoIndex;
};

type GitTreeNode = {
  path?: string;
  sha?: string;
  size?: number;
  type?: string;
};

type PersistedRepoIndex = {
  checkedAt: string;
  etag?: string;
  files: Array<[path: string, sha: string, size: number]>;
  kind: "github-repo-index";
  savedAt: string;
  sourceKey: string;
  treeSha?: string;
  version: typeof REPO_INDEX_VERSION;
};

const addMarkdownFiles = (files: Map<string, GitHubRepoIndexFile>, nodes: GitTreeNode[], prefix: string): void => {
  for (const node of nodes) {
    if (node.type === "blob" && node.path && isGitObjectSha(node.sha) && markdownExtensionRegex.test(node.path)) {
      files.set(`${prefix}${node.path}`, { sha: node.sha, size: typeof node.size === "number" ? node.size : 0 });
    }
  }
};

const sameFiles = (left: ReadonlyMap<string, GitHubRepoIndexFile>, right: ReadonlyMap<string, GitHubRepoIndexFile>): boolean => {
  if (left.size !== right.size) {
    return false;
  }
  for (const [repoPath, file] of left) {
    if (right.get(repoPath)?.sha !== file.sha) {
      return false;
    }
  }
  return true;
};

/**
 * Lists a tree whose recursive listing GitHub truncated (more than 100,000 entries or 7 MB):
 * this level non-recursively, then every subtree recursively, splitting further wherever a
 * subtree is truncated too. A non-recursive level that is still truncated cannot be listed
 * completely, so the refresh fails instead of publishing an index that silently lacks pages.
 */
const listTruncatedTree = async (config: GitHubRuntimeConfig, treeSha: string, prefix: string, files: Map<string, GitHubRepoIndexFile>): Promise<void> => {
  const client = getGitHubClient(config);
  const level = await client.git.getTree({ owner: config.owner, repo: config.repo, tree_sha: treeSha, request: { priority: "bulk" } });
  if (level.data.truncated) {
    throw new Error(`GitHub truncated the listing of ${prefix || "the repository root"}; the docs index cannot be built completely.`);
  }

  addMarkdownFiles(files, level.data.tree, prefix);
  await Promise.all(
    level.data.tree.map(async (node) => {
      if (node.type !== "tree" || !node.path || !isGitObjectSha(node.sha)) {
        return;
      }

      const subtreePrefix = `${prefix}${node.path}/`;
      const subtree = await client.git.getTree({ owner: config.owner, repo: config.repo, tree_sha: node.sha, recursive: "1", request: { priority: "bulk" } });
      if (subtree.data.truncated) {
        await listTruncatedTree(config, node.sha, subtreePrefix, files);
        return;
      }
      addMarkdownFiles(files, subtree.data.tree, subtreePrefix);
    }),
  );
};

/**
 * Lists the branch's Markdown files with one recursive tree request. The request is conditional
 * on the previous ETag; a 304 answer or an unchanged root tree SHA keeps the previous files.
 */
export const fetchGitHubRepoIndex = async (config: GitHubRuntimeConfig, previous?: GitHubRepoIndex): Promise<GitHubRepoIndexFetchResult> => {
  const client = getGitHubClient(config);
  const checkedAt = new Date().toISOString();
  let response: Awaited<ReturnType<typeof client.git.getTree>>;

  try {
    response = await client.git.getTree({
      owner: config.owner,
      repo: config.repo,
      tree_sha: config.branch,
      recursive: "1",
      ...(previous?.etag ? { headers: { "if-none-match": previous.etag } } : {}),
    });
  } catch (error: unknown) {
    if (previous && gitHubErrorStatus(error) === 304) {
      return { filesChanged: false, index: { ...previous, checkedAt } };
    }
    throw error;
  }

  const treeSha = response.data.sha;
  const etag = typeof response.headers.etag === "string" ? response.headers.etag : undefined;
  if (previous && previous.treeSha === treeSha) {
    return { filesChanged: false, index: { ...previous, checkedAt, etag } };
  }

  const files = new Map<string, GitHubRepoIndexFile>();
  if (response.data.truncated) {
    await listTruncatedTree(config, treeSha, "", files);
  } else {
    addMarkdownFiles(files, response.data.tree, "");
  }

  if (previous && sameFiles(previous.files, files)) {
    return { filesChanged: false, index: { ...previous, checkedAt, etag, treeSha } };
  }

  return { filesChanged: true, index: { checkedAt, etag, files, treeSha } };
};

/**
 * Applies files this app just committed. The root tree SHA and ETag are dropped because the
 * commit may also contain remote changes the index has not seen; the next refresh therefore
 * compares the full listing instead of trusting an unchanged-tree shortcut.
 */
export const withCommittedRepoIndexFiles = (index: GitHubRepoIndex, committed: Array<{ repoPath: string; sha: string; size: number }>): GitHubRepoIndex => {
  const files = new Map(index.files);
  for (const file of committed) {
    files.set(file.repoPath, { sha: file.sha, size: file.size });
  }
  return { checkedAt: index.checkedAt, files };
};

export const repoIndexBlobSha = (index: GitHubRepoIndex, repoPath: string): string | undefined => index.files.get(repoPath)?.sha;

/** Lists indexed files below a repository directory (all files for an empty prefix), sorted by path. */
export const listRepoIndexFiles = (index: GitHubRepoIndex, directory: string): Array<GitHubRepoIndexFile & { path: string }> => {
  const prefix = directory.replace(/^\/+|\/+$/g, "");
  const files: Array<GitHubRepoIndexFile & { path: string }> = [];
  for (const [repoPath, file] of index.files) {
    if (!prefix || repoPath.startsWith(`${prefix}/`)) {
      files.push({ path: repoPath, ...file });
    }
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
};

const parsePersistedFiles = (value: unknown): Map<string, GitHubRepoIndexFile> | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const files = new Map<string, GitHubRepoIndexFile>();
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0] || !isGitObjectSha(entry[1])) {
      return null;
    }
    files.set(entry[0], { sha: entry[1], size: typeof entry[2] === "number" && entry[2] >= 0 ? entry[2] : 0 });
  }
  return files;
};

const parsePersistedIndex = (value: unknown, sourceKey?: string): GitHubRepoIndex | null => {
  const source = typeof value === "object" && value !== null ? (value as Partial<PersistedRepoIndex>) : null;
  if (!source || source.version !== REPO_INDEX_VERSION || source.kind !== "github-repo-index" || (sourceKey !== undefined && source.sourceKey !== sourceKey)) {
    return null;
  }

  const files = parsePersistedFiles(source.files);
  if (!files || typeof source.checkedAt !== "string" || Number.isNaN(Date.parse(source.checkedAt))) {
    return null;
  }

  return {
    checkedAt: source.checkedAt,
    ...(typeof source.etag === "string" && source.etag ? { etag: source.etag } : {}),
    files,
    ...(isGitObjectSha(source.treeSha) ? { treeSha: source.treeSha } : {}),
  };
};

export const readPersistentGitHubRepoIndex = async (config: GitHubRuntimeConfig, baseDir: string): Promise<GitHubRepoIndex | null> => {
  const sourceKey = gitHubRuntimeCacheKey(config);
  return parsePersistedIndex(await readPrivateJsonFile(sourceCacheFilePath(baseDir, sourceKey, "repo-index")), sourceKey);
};

export const writePersistentGitHubRepoIndex = async (config: GitHubRuntimeConfig, index: GitHubRepoIndex, baseDir: string): Promise<boolean> => {
  const sourceKey = gitHubRuntimeCacheKey(config);
  const entry: PersistedRepoIndex = {
    checkedAt: index.checkedAt,
    ...(index.etag ? { etag: index.etag } : {}),
    files: Array.from(index.files, ([repoPath, file]) => [repoPath, file.sha, file.size]),
    kind: "github-repo-index",
    savedAt: new Date().toISOString(),
    sourceKey,
    ...(index.treeSha ? { treeSha: index.treeSha } : {}),
    version: REPO_INDEX_VERSION,
  };
  return writePrivateJsonFile(sourceCacheFilePath(baseDir, sourceKey, "repo-index"), entry);
};

/** Blob SHAs referenced by any persisted index, of any source; used to collect unreferenced blobs. */
export const listPersistedRepoIndexBlobShas = async (baseDir: string): Promise<Set<string>> => {
  const shas = new Set<string>();
  const sourceDirs = await listPrivateDirectory(sourceCacheDirsPath(baseDir));
  await Promise.all(
    sourceDirs.map(async (sourceDir) => {
      const index = parsePersistedIndex(await readPrivateJsonFile(path.join(sourceCacheDirsPath(baseDir), sourceDir, "repo-index.json")));
      index?.files.forEach((file) => shas.add(file.sha));
    }),
  );
  return shas;
};
