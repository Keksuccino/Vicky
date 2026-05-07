import path from "node:path";

import { Octokit } from "@octokit/rest";

import {
  aiPlaintextDocsCache,
  docsPageCache,
  docsSearchCorpusCache,
  docsSnapshotCache,
  docsTreeCache,
  translatedDocsPageCache,
  translatedDocsTitleCache,
} from "@/lib/cache";
import { decryptSecret } from "@/lib/encryption";
import { badRequest, notFound } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import type {
  GitHubDocPage,
  GitHubPlaintextDocPage,
  GitHubDocTreeItem,
  GitHubRuntimeConfig,
  GitHubSettings,
  GitHubValidationResult,
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
  [config.owner, config.repo, config.branch, normalizeDocsPath(config.docsPath)].join("|");

const snapshotCacheKey = (config: GitHubRuntimeConfig): string => `${toRuntimeConfigCacheKey(config)}|snapshot`;
const FULL_DOCS_LOAD_CONCURRENCY = 6;

type GitHubDocsSnapshot = {
  fetchedAt: string;
  expiresAt: string;
  tree: GitHubDocTreeItem[];
  pages: GitHubDocPage[];
};

const translatedDocsPageCachePrefix = (config: GitHubRuntimeConfig): string =>
  `${toRuntimeConfigCacheKey(config)}|auto-translate|page|`;

const translatedDocsTitleCachePrefix = (config: GitHubRuntimeConfig): string =>
  `${toRuntimeConfigCacheKey(config)}|auto-translate|titles|`;

const titleSourceSignature = (items: GitHubDocTreeItem[]): string =>
  JSON.stringify(items.map((item) => ({ slug: item.slug, path: item.path, name: item.name })));

const pruneTranslatedDocsCacheForSnapshotChange = (
  config: GitHubRuntimeConfig,
  previous: GitHubDocsSnapshot,
  next: GitHubDocsSnapshot,
): void => {
  const nextPagesBySlug = new Map(next.pages.map((page) => [page.slug, page]));
  const pageCachePrefix = translatedDocsPageCachePrefix(config);
  const stalePageSlugs = new Set<string>();

  for (const previousPage of previous.pages) {
    const nextPage = nextPagesBySlug.get(previousPage.slug);
    if (nextPage && nextPage.sha === previousPage.sha) {
      continue;
    }

    stalePageSlugs.add(previousPage.slug);
  }

  if (stalePageSlugs.size > 0) {
    const stalePageSlugPrefixes = Array.from(stalePageSlugs, (slug) => `${slug}|`);
    translatedDocsPageCache.deleteWhere((key) => {
      if (!key.startsWith(pageCachePrefix)) {
        return false;
      }

      const cacheEntryKey = key.slice(pageCachePrefix.length);
      if (!/^[a-f0-9]{32}\|/.test(cacheEntryKey)) {
        return false;
      }

      const sourceCacheKey = cacheEntryKey.slice(33);
      return stalePageSlugPrefixes.some((slugPrefix) => sourceCacheKey.startsWith(slugPrefix));
    });
  }

  if (titleSourceSignature(previous.tree) !== titleSourceSignature(next.tree)) {
    const titleCachePrefix = translatedDocsTitleCachePrefix(config);
    translatedDocsTitleCache.deleteWhere((key) => key.startsWith(titleCachePrefix));
  }
};

const docsSnapshotLoads = new Map<string, Promise<GitHubDocsSnapshot>>();

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
  };
};

export const clearGitHubDocsCache = (config?: GitHubRuntimeConfig): void => {
  if (!config) {
    docsSnapshotCache.clear();
    docsTreeCache.clear();
    docsPageCache.clear();
    docsSearchCorpusCache.clear();
    aiPlaintextDocsCache.clear();
    translatedDocsPageCache.clear();
    translatedDocsTitleCache.clear();
    return;
  }

  const prefix = `${toRuntimeConfigCacheKey(config)}|`;
  docsSnapshotCache.deleteWhere((key) => key.startsWith(prefix));
  docsTreeCache.deleteWhere((key) => key.startsWith(prefix));
  docsPageCache.deleteWhere((key) => key.startsWith(prefix));
  docsSearchCorpusCache.deleteWhere((key) => key.startsWith(prefix));
  aiPlaintextDocsCache.deleteWhere((key) => key.startsWith(prefix));
  translatedDocsPageCache.deleteWhere((key) => key.startsWith(prefix));
  translatedDocsTitleCache.deleteWhere((key) => key.startsWith(prefix));
};

const clearDerivedGitHubDocsCache = (
  config: GitHubRuntimeConfig,
  snapshots?: { previous?: GitHubDocsSnapshot; next?: GitHubDocsSnapshot },
): void => {
  const prefix = `${toRuntimeConfigCacheKey(config)}|`;
  docsSearchCorpusCache.deleteWhere((key) => key.startsWith(prefix));
  aiPlaintextDocsCache.deleteWhere((key) => key.startsWith(prefix));

  if (snapshots?.previous && snapshots.next) {
    pruneTranslatedDocsCacheForSnapshotChange(config, snapshots.previous, snapshots.next);
    return;
  }

  translatedDocsPageCache.deleteWhere((key) => key.startsWith(translatedDocsPageCachePrefix(config)));
  translatedDocsTitleCache.deleteWhere((key) => key.startsWith(translatedDocsTitleCachePrefix(config)));
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

const listDocsTreeFromGitHub = async (config: GitHubRuntimeConfig): Promise<GitHubDocTreeItem[]> => {
  const octokit = createOctokit(config);
  const docsRoot = normalizeDocsPath(config.docsPath);

  const branch = await octokit.repos.getBranch({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });

  const treeResponse = await octokit.git.getTree({
    owner: config.owner,
    repo: config.repo,
    tree_sha: branch.data.commit.commit.tree.sha,
    recursive: "1",
  });

  const treeItems: GitHubDocTreeItem[] = [];

  for (const node of treeResponse.data.tree) {
    if (node.type !== "blob" || !node.path) {
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
      path: markdownPath,
      slug: relativePathToSlug(markdownPath),
      name: prettyNameFromPath(markdownPath),
    });
  }

  treeItems.sort((left, right) => left.path.localeCompare(right.path));

  return treeItems;
};

export const listMarkdownDocsTree = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocTreeItem[]> => {
  const snapshot = await loadGitHubDocsSnapshot(config, options);
  return snapshot.tree;
};

export const listMarkdownDocsTreeWithTitles = async (config: GitHubRuntimeConfig): Promise<GitHubDocTreeItem[]> => {
  const snapshot = await loadGitHubDocsSnapshot(config);
  return snapshot.tree;
};

export const listMarkdownDocsTreePagesWithTitles = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
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

const loadFreshGitHubDocsSnapshot = async (config: GitHubRuntimeConfig): Promise<GitHubDocsSnapshot> => {
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const baseTree = await listDocsTreeFromGitHub(config);
  const docsRoot = normalizeDocsPath(config.docsPath);
  const octokit = createOctokit(config);

  const pages = await mapWithConcurrency(
    baseTree,
    FULL_DOCS_LOAD_CONCURRENCY,
    async (item): Promise<GitHubDocPage> => {
      const fullPath = joinDocsPath(docsRoot, item.path);
      const file = await fetchFileFromGitHub(config, fullPath, octokit);
      const commitMeta = await fetchLatestCommitMetadata(config, fullPath, octokit);
      return createGitHubDocPage(item, file, commitMeta);
    },
  );

  const fetchedAtMs = Date.now();
  const tree = sortTreeItems(pages.map((page) => treeItemFromPage(page)));

  return {
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    expiresAt: new Date(fetchedAtMs + docsSnapshotCache.getTtlMs()).toISOString(),
    tree,
    pages,
  };
};

const loadGitHubDocsSnapshot = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
): Promise<GitHubDocsSnapshot> => {
  const cacheKey = snapshotCacheKey(config);
  const previousSnapshot = docsSnapshotCache.peek(cacheKey) as GitHubDocsSnapshot | undefined;
  const cached = options?.bypassCache ? undefined : docsSnapshotCache.get(cacheKey);

  if (cached) {
    return cached as GitHubDocsSnapshot;
  }

  const pending = docsSnapshotLoads.get(cacheKey);
  if (pending) {
    return pending;
  }

  const loadPromise = loadFreshGitHubDocsSnapshot(config)
    .then((snapshot) => {
      docsSnapshotCache.set(cacheKey, snapshot);
      clearDerivedGitHubDocsCache(config, { previous: previousSnapshot, next: snapshot });
      return snapshot;
    })
    .finally(() => {
      if (docsSnapshotLoads.get(cacheKey) === loadPromise) {
        docsSnapshotLoads.delete(cacheKey);
      }
    });

  docsSnapshotLoads.set(cacheKey, loadPromise);
  return loadPromise;
};

const findPageInSnapshot = (
  config: GitHubRuntimeConfig,
  snapshot: GitHubDocsSnapshot,
  locator: { slug?: string; path?: string },
): GitHubDocPage | null => {
  if (locator.path?.trim()) {
    const docsRoot = normalizeDocsPath(config.docsPath);
    const relativePath = resolvePathFromInput(docsRoot, locator.path);
    return snapshot.pages.find((page) => page.path === relativePath || page.slug === relativePathToSlug(relativePath)) ?? null;
  }

  if (!locator.slug?.trim()) {
    throw badRequest("A slug or path query parameter is required.");
  }

  const normalizedSlug = resolveSlugInput(locator.slug);
  return (
    snapshot.pages.find(
      (page) => page.slug === normalizedSlug || page.path === normalizedSlug || relativePathToSlug(page.path) === normalizedSlug,
    ) ?? null
  );
};

const upsertGitHubDocPageInSnapshotCache = (config: GitHubRuntimeConfig, page: GitHubDocPage): void => {
  const cacheKey = snapshotCacheKey(config);
  const cached = docsSnapshotCache.get(cacheKey) as GitHubDocsSnapshot | undefined;

  if (!cached) {
    clearDerivedGitHubDocsCache(config);
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
  clearDerivedGitHubDocsCache(config, { previous: cached, next: nextSnapshot });
};

export const refreshGitHubDocsCache = async (
  config: GitHubRuntimeConfig,
): Promise<{ pageCount: number; fetchedAt: string; expiresAt: string }> => {
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
  const snapshot = await loadGitHubDocsSnapshot(config, options);
  const page = findPageInSnapshot(config, snapshot, locator);

  if (!page) {
    throw notFound("Document not found for the provided slug.");
  }

  return page;
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

  upsertGitHubDocPageInSnapshotCache(config, page);

  return {
    path: target.relativePath,
    slug: target.slug,
    commitSha,
    page,
  };
};
