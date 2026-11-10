import { createHash } from "node:crypto";
import { readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDirectory, ensurePrivateFile, secureAtomicWriteFile } from "@/lib/runtime-file-security.mjs";

/**
 * On-disk layout of the persistent GitHub docs cache:
 *
 * - `blobs/<2 hex>/<blob sha>.json`: content-addressed Markdown blobs with their parsed metadata.
 *   A blob is only ever served through a repository index that lists its SHA, so sharing files
 *   between sources cannot expose content a source is not authorized to read.
 * - `sources/<sha256 of the source cache key>/repo-index.json` and `commit-metadata.json`: the
 *   per-source, per-authorization state. Deleting a source removes exactly this directory.
 *
 * Callers resolve the base directory once per operation and pass it down, so an operation that
 * outlives an environment change keeps working on the directory it started with.
 */
const DEFAULT_DOCS_CACHE_DIR = path.join(process.cwd(), "data", "docs-cache");
const LEGACY_SNAPSHOT_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const BLOB_FILE_PATTERN = /^([a-f0-9]{40}|[a-f0-9]{64})\.json$/;

export type GitHubSourceCacheFile = "commit-metadata" | "repo-index";

export const SOURCE_CACHE_FILES: readonly GitHubSourceCacheFile[] = ["repo-index", "commit-metadata"];

export const getGitHubDocsCacheDir = (): string => process.env.WIKI_DOCS_CACHE_DIR?.trim() || DEFAULT_DOCS_CACHE_DIR;

const hashSourceKey = (sourceKey: string): string => createHash("sha256").update(sourceKey).digest("hex");

export const sourceCacheDirsPath = (baseDir: string): string => path.join(baseDir, "sources");

export const sourceCacheFilePath = (baseDir: string, sourceKey: string, file: GitHubSourceCacheFile): string =>
  path.join(sourceCacheDirsPath(baseDir), hashSourceKey(sourceKey), `${file}.json`);

export const blobsDirPath = (baseDir: string): string => path.join(baseDir, "blobs");

export const blobFilePath = (baseDir: string, sha: string): string => path.join(blobsDirPath(baseDir), sha.slice(0, 2), `${sha}.json`);

export const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";

const warnFileFailure = (action: string, filePath: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[docs] Failed to ${action} docs cache file ${path.basename(filePath)}: ${message}`);
};

/** Reads a private JSON file; a missing, unreadable, or malformed file reads as `null`. */
export const readPrivateJsonFile = async (filePath: string): Promise<unknown> => {
  try {
    await ensurePrivateFile(filePath);
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnFileFailure("read", filePath, error);
    }
    return null;
  }
};

export const writePrivateJsonFile = async (filePath: string, value: unknown): Promise<boolean> => {
  try {
    await secureAtomicWriteFile(filePath, JSON.stringify(value), "utf8");
    return true;
  } catch (error: unknown) {
    warnFileFailure("write", filePath, error);
    return false;
  }
};

export const deletePrivateFile = async (filePath: string): Promise<boolean> => {
  try {
    await ensurePrivateFile(filePath);
    await unlink(filePath);
    return true;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnFileFailure("delete", filePath, error);
    }
    return false;
  }
};

/** Lists entry names of a private cache directory; a missing directory lists as empty and is not created. */
export const listPrivateDirectory = async (directoryPath: string): Promise<string[]> => {
  try {
    // Cache entries are mutable runtime files, not build inputs. The directory can also be configured outside the project.
    const entries = await readdir(/*turbopackIgnore: true*/ directoryPath);
    await ensurePrivateDirectory(directoryPath);
    return entries;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[docs] Failed to list docs cache directory ${path.basename(directoryPath)}: ${message}`);
    }
    return [];
  }
};

const removeEmptyDirectory = async (directoryPath: string): Promise<void> => {
  await rmdir(directoryPath).catch(() => undefined);
};

/** Deletes one source's persisted state. Returns the number of removed files. */
export const deleteSourceCacheFiles = async (baseDir: string, sourceKey: string): Promise<number> => {
  const results = await Promise.all(SOURCE_CACHE_FILES.map((file) => deletePrivateFile(sourceCacheFilePath(baseDir, sourceKey, file))));
  await removeEmptyDirectory(path.dirname(sourceCacheFilePath(baseDir, sourceKey, "repo-index")));
  return results.filter(Boolean).length;
};

/** Lists the blob SHAs present on disk. */
export const listStoredBlobShas = async (baseDir: string): Promise<string[]> => {
  const shards = await listPrivateDirectory(blobsDirPath(baseDir));
  const lists = await Promise.all(
    shards.filter((shard) => /^[a-f0-9]{2}$/.test(shard)).map(async (shard) => {
      const fileNames = await listPrivateDirectory(path.join(blobsDirPath(baseDir), shard));
      return fileNames.flatMap((fileName) => BLOB_FILE_PATTERN.exec(fileName)?.[1] ?? []);
    }),
  );
  return lists.flat();
};

/** Deletes every persisted source state and blob. Returns the number of removed files. */
export const deleteAllDocsCacheFiles = async (baseDir: string): Promise<number> => {
  const sourceDirs = await listPrivateDirectory(sourceCacheDirsPath(baseDir));
  const sourceCounts = await Promise.all(
    sourceDirs.map(async (sourceDir) => {
      const directoryPath = path.join(sourceCacheDirsPath(baseDir), sourceDir);
      const results = await Promise.all(SOURCE_CACHE_FILES.map((file) => deletePrivateFile(path.join(directoryPath, `${file}.json`))));
      await removeEmptyDirectory(directoryPath);
      return results.filter(Boolean).length;
    }),
  );
  const blobShas = await listStoredBlobShas(baseDir);
  const blobResults = await Promise.all(blobShas.map((sha) => deletePrivateFile(blobFilePath(baseDir, sha))));
  return sourceCounts.reduce((sum, count) => sum + count, 0) + blobResults.filter(Boolean).length;
};

/**
 * Removes whole-docs snapshot files, the persistence format that preceded the repository
 * index and blob store. Nothing reads them anymore, and they hold full page copies, so every
 * file in the snapshot directory goes regardless of the source it belonged to.
 */
export const removeLegacyDocsSnapshots = async (baseDir: string): Promise<number> => {
  const snapshotDir = process.env.WIKI_DOCS_SNAPSHOT_DIR?.trim() || path.join(baseDir, "snapshots");
  const fileNames = await listPrivateDirectory(snapshotDir);
  const results = await Promise.all(
    fileNames.filter((fileName) => LEGACY_SNAPSHOT_FILE_PATTERN.test(fileName)).map((fileName) => deletePrivateFile(path.join(snapshotDir, fileName))),
  );
  await removeEmptyDirectory(snapshotDir);
  return results.filter(Boolean).length;
};
