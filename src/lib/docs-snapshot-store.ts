import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GitHubDocPage, GitHubDocTreeItem, GitHubRuntimeConfig } from "@/lib/types";

const DOCS_SNAPSHOT_ENTRY_VERSION = 1;
const DEFAULT_DOCS_SNAPSHOT_DIR = path.join(process.cwd(), "data", "docs-cache", "snapshots");

export type PersistedGitHubDocsSnapshot = {
  branchCommitSha?: string;
  treeSha?: string;
  fetchedAt: string;
  expiresAt: string;
  tree: GitHubDocTreeItem[];
  pages: GitHubDocPage[];
};

type PersistedGitHubDocsSnapshotEntry = PersistedGitHubDocsSnapshot & {
  version: typeof DOCS_SNAPSHOT_ENTRY_VERSION;
  kind: "github-docs-snapshot";
  sourceKey: string;
  savedAt: string;
};

const normalizeSourcePart = (value: string): string =>
  value
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

export const gitHubDocsSnapshotSourceKey = (config: GitHubRuntimeConfig): string =>
  [
    normalizeSourcePart(config.owner),
    normalizeSourcePart(config.repo),
    normalizeSourcePart(config.branch),
    normalizeSourcePart(config.docsPath),
  ].join("|");

const getDocsSnapshotDir = (): string => process.env.WIKI_DOCS_SNAPSHOT_DIR?.trim() || DEFAULT_DOCS_SNAPSHOT_DIR;

const hashSourceKey = (sourceKey: string): string => createHash("sha256").update(sourceKey).digest("hex");

const snapshotFilePath = (config: GitHubRuntimeConfig): string =>
  path.join(getDocsSnapshotDir(), `${hashSourceKey(gitHubDocsSnapshotSourceKey(config))}.json`);

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeTreeItem = (value: unknown): GitHubDocTreeItem | null => {
  const source = asRecord(value);
  const pathValue = source ? asString(source.path) : undefined;
  const slug = source ? asString(source.slug) : undefined;
  const name = source ? asString(source.name) : undefined;

  if (!pathValue || !slug || !name) {
    return null;
  }

  return {
    path: pathValue,
    slug,
    name,
  };
};

const normalizePage = (value: unknown): GitHubDocPage | null => {
  const source = asRecord(value);
  const pathValue = source ? asString(source.path) : undefined;
  const slug = source ? asString(source.slug) : undefined;
  const sha = source ? asString(source.sha) : undefined;
  const title = source ? asString(source.title) ?? "" : "";
  const description = source ? asString(source.description) ?? "" : "";
  const content = source ? asString(source.content) ?? "" : "";
  const markdown = source ? asString(source.markdown) ?? "" : "";

  if (!source || !pathValue || !slug || !sha || !markdown) {
    return null;
  }

  const headings = Array.isArray(source.headings) ? source.headings : [];

  return {
    path: pathValue,
    slug,
    sha,
    title,
    description,
    content,
    markdown,
    headings: headings
      .map((heading) => {
        const headingSource = asRecord(heading);
        const depth = headingSource?.depth;
        const text = headingSource ? asString(headingSource.text) : undefined;
        const headingSlug = headingSource ? asString(headingSource.slug) : undefined;

        if (typeof depth !== "number" || !Number.isFinite(depth) || !text || !headingSlug) {
          return null;
        }

        return {
          depth: Math.max(1, Math.min(6, Math.floor(depth))),
          text,
          slug: headingSlug,
        };
      })
      .filter((heading): heading is GitHubDocPage["headings"][number] => Boolean(heading)),
    includeInPlaintextExport:
      typeof source.includeInPlaintextExport === "boolean" ? source.includeInPlaintextExport : true,
    updatedAt: asString(source.updatedAt),
    updatedBy: asString(source.updatedBy),
  };
};

const normalizeSnapshot = (
  value: unknown,
  sourceKey: string,
): PersistedGitHubDocsSnapshot | null => {
  const source = asRecord(value);
  if (
    !source ||
    source.version !== DOCS_SNAPSHOT_ENTRY_VERSION ||
    source.kind !== "github-docs-snapshot" ||
    source.sourceKey !== sourceKey
  ) {
    return null;
  }

  const fetchedAt = asString(source.fetchedAt);
  const expiresAt = asString(source.expiresAt);
  if (!fetchedAt || !expiresAt || Number.isNaN(Date.parse(fetchedAt)) || Number.isNaN(Date.parse(expiresAt))) {
    return null;
  }

  const tree = (Array.isArray(source.tree) ? source.tree : [])
    .map((item) => normalizeTreeItem(item))
    .filter((item): item is GitHubDocTreeItem => Boolean(item));
  const pages = (Array.isArray(source.pages) ? source.pages : [])
    .map((page) => normalizePage(page))
    .filter((page): page is GitHubDocPage => Boolean(page));

  if (pages.length === 0 && tree.length === 0) {
    return null;
  }

  return {
    branchCommitSha: asString(source.branchCommitSha),
    treeSha: asString(source.treeSha),
    fetchedAt,
    expiresAt,
    tree,
    pages,
  };
};

const warnSnapshotFailure = (action: string, config: GitHubRuntimeConfig, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[docs] Failed to ${action} persistent docs snapshot ${gitHubDocsSnapshotSourceKey(config)}: ${message}`);
};

const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

export const readPersistentGitHubDocsSnapshot = async (
  config: GitHubRuntimeConfig,
  options?: { allowExpired?: boolean },
): Promise<PersistedGitHubDocsSnapshot | null> => {
  try {
    const raw = await readFile(snapshotFilePath(config), "utf8");
    const snapshot = normalizeSnapshot(JSON.parse(raw) as unknown, gitHubDocsSnapshotSourceKey(config));
    if (!snapshot) {
      return null;
    }

    if (!options?.allowExpired && Date.now() >= Date.parse(snapshot.expiresAt)) {
      return null;
    }

    return snapshot;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnSnapshotFailure("read", config, error);
    }

    return null;
  }
};

export const writePersistentGitHubDocsSnapshot = async (
  config: GitHubRuntimeConfig,
  snapshot: PersistedGitHubDocsSnapshot,
): Promise<boolean> => {
  try {
    const entry: PersistedGitHubDocsSnapshotEntry = {
      version: DOCS_SNAPSHOT_ENTRY_VERSION,
      kind: "github-docs-snapshot",
      sourceKey: gitHubDocsSnapshotSourceKey(config),
      savedAt: new Date().toISOString(),
      ...snapshot,
    };

    await writeJsonFile(snapshotFilePath(config), entry);
    return true;
  } catch (error: unknown) {
    warnSnapshotFailure("write", config, error);
    return false;
  }
};

export const deletePersistentGitHubDocsSnapshot = async (config: GitHubRuntimeConfig): Promise<boolean> => {
  try {
    await unlink(snapshotFilePath(config));
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }

    warnSnapshotFailure("delete", config, error);
    return false;
  }
};

export const deleteAllPersistentGitHubDocsSnapshots = async (): Promise<number> => {
  let deleted = 0;

  try {
    const fileNames = await readdir(getDocsSnapshotDir());
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }

      try {
        await unlink(path.join(getDocsSnapshotDir(), fileName));
        deleted += 1;
      } catch {
        // Best-effort cleanup only.
      }
    }
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[docs] Failed to list persistent docs snapshots: ${message}`);
    }
  }

  return deleted;
};
