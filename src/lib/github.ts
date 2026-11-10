import path from "node:path";

import { getDocsCacheTtlMs } from "@/lib/cache";
import { logAutoTranslateInfo } from "@/lib/auto-translate-logging";
import { decryptSecret } from "@/lib/encryption";
import {
  assertGitHubCacheAccess,
  beginGitHubCacheAccess,
  invalidateAllGitHubRuntimeCaches,
  invalidateGitHubRuntimeCaches,
  prepareGitHubCacheMutation,
} from "@/lib/github-cache-invalidation";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { getGitHubClient, gitHubErrorStatus } from "@/lib/github-client";
import { extractCommitMetadata, hydrateGitHubDocPageMetadata, knownGitHubCommitMetadata, type GitHubCommitMetadata } from "@/lib/github-commit-metadata";
import { fetchGitHubFile, parseGitHubBlobRecord } from "@/lib/github-content-store";
import { docsSourceLogContext } from "@/lib/github-derived-caches";
import {
  applyCommittedGitHubDocPage,
  assertValidGitHubRuntimeConfig,
  createGitHubDocPage,
  loadGitHubDocsSourceView,
  readPublishedGitHubDocsSourceView,
  validateGitHubRuntimeConfig,
  type GitHubDocsSourceView,
} from "@/lib/github-docs-source";
import {
  ensureMarkdownPath,
  joinRepoPath,
  markdownExtensionRegex,
  normalizeDocsPath,
  normalizePathValue,
  prettyNameFromPath,
  relativePathToSlug,
  resolvePathFromInput,
  resolveSlugInput,
  stripRepoRoot,
} from "@/lib/github-paths";
import type { GitHubRepoIndex } from "@/lib/github-repo-index";
import { badRequest, notFound } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { canonicalizePublicDocLocator, type CanonicalPublicDocLocator } from "@/lib/public-doc-path";
import type {
  GitHubDocPage,
  GitHubDocTreeItem,
  GitHubPlaintextDocPage,
  GitHubRuntimeConfig,
  GitHubSettings,
  SaveGitHubDocInput,
  SaveGitHubDocResult,
} from "@/lib/types";

export const toRuntimeConfigCacheKey = (config: GitHubRuntimeConfig): string => gitHubRuntimeCacheKey(config);

export const resolveRuntimeConfig = (settings: GitHubSettings, tokenOverride?: string): GitHubRuntimeConfig => {
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
    const client = getGitHubClient(config);
    const repoResponse = await client.repos.get({
      owner: config.owner,
      repo: config.repo,
    });

    await client.repos.getBranch({
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

/** Adds commit metadata that became known after the page object was built. */
const withKnownMetadata = (config: GitHubRuntimeConfig, page: GitHubDocPage): GitHubDocPage => {
  if (page.updatedAt) {
    return page;
  }

  const metadata = knownGitHubCommitMetadata(config, joinRepoPath(normalizeDocsPath(config.docsPath), page.path), page.sha);
  return metadata?.updatedAt ? { ...page, updatedAt: metadata.updatedAt, updatedBy: metadata.updatedBy } : page;
};

/** The repository index behind the current docs view: every Markdown file of the branch with its blob SHA. */
export const loadGitHubRepoIndex = async (config: GitHubRuntimeConfig, options?: { bypassCache?: boolean }): Promise<GitHubRepoIndex> =>
  (await loadGitHubDocsSourceView(config, { forceRefresh: options?.bypassCache })).index;

export const listMarkdownDocsTree = async (config: GitHubRuntimeConfig, options?: { bypassCache?: boolean }): Promise<GitHubDocTreeItem[]> =>
  (await loadGitHubDocsSourceView(config, { forceRefresh: options?.bypassCache })).tree;

export const listMarkdownDocsTreePagesWithTitles = async (
  config: GitHubRuntimeConfig,
  options?: { bypassCache?: boolean },
): Promise<{ items: GitHubDocTreeItem[]; pages: GitHubDocPage[] }> => {
  const view = await loadGitHubDocsSourceView(config, { forceRefresh: options?.bypassCache });
  return {
    items: view.tree,
    pages: view.pages,
  };
};

export const getCachedGitHubDocPage = (config: GitHubRuntimeConfig, relativePath: string): GitHubDocPage | null => {
  beginGitHubCacheAccess(config);
  try {
    const page = readPublishedGitHubDocsSourceView(config)?.pagesByPath.get(ensureMarkdownPath(relativePath).normalize("NFC"));
    return page ? withKnownMetadata(config, page) : null;
  } catch {
    return null;
  }
};

/** Explicit admin refresh: the public site keeps the current pages until the new ones replace them. */
export const refreshGitHubDocsCache = async (config: GitHubRuntimeConfig): Promise<{ pageCount: number; fetchedAt: string; expiresAt: string }> => {
  const view = await loadGitHubDocsSourceView(config, { forceRefresh: true });
  return {
    pageCount: view.pages.length,
    fetchedAt: new Date(view.checkedAtMs).toISOString(),
    expiresAt: new Date(view.checkedAtMs + getDocsCacheTtlMs()).toISOString(),
  };
};

/** An editor locator: an exact relative Markdown path when one was given, and its slug. */
type EditorDocLocator = {
  path?: string;
  slug: string;
};

/** Validates an editor locator (slug, relative path, or repository path) before any GitHub request. */
const resolveEditorDocLocator = (config: GitHubRuntimeConfig, locator: { slug?: string; path?: string }): EditorDocLocator => {
  if (locator.path?.trim()) {
    const normalizedPath = normalizePathValue(locator.path);
    const stripped = stripRepoRoot(normalizeDocsPath(config.docsPath), normalizedPath);
    const relativePath = stripped === null ? normalizedPath : stripped;
    if (!relativePath) {
      throw badRequest("Document path is required.");
    }

    if (path.posix.extname(relativePath)) {
      const markdownPath = ensureMarkdownPath(relativePath);
      return { path: markdownPath, slug: relativePathToSlug(markdownPath) };
    }
    return { slug: resolveSlugInput(relativePath) };
  }

  const slug = locator.slug?.trim() ? resolveSlugInput(locator.slug) : "";
  if (!slug) {
    throw badRequest("A slug or path query parameter is required.");
  }
  return { slug };
};

const findIndexedDocPage = (view: GitHubDocsSourceView, locator: EditorDocLocator): GitHubDocPage | undefined =>
  (locator.path ? view.pagesByPath.get(locator.path.normalize("NFC")) : undefined) ?? view.pagesBySlug.get(locator.slug.normalize("NFC"));

const isNotFoundError = (error: unknown): boolean => gitHubErrorStatus(error) === 404;

/**
 * Editors may open a page that reached GitHub after the last refresh, so a page missing from
 * the index is read directly. Public reads never come here (see `loadPublicGitHubDoc`).
 */
const loadUnindexedGitHubDoc = async (config: GitHubRuntimeConfig, locator: EditorDocLocator): Promise<GitHubDocPage> => {
  const docsRoot = normalizeDocsPath(config.docsPath);
  const candidates = locator.path ? [locator.path] : [`${locator.slug}.md`, `${locator.slug}.mdx`];

  for (const relativePath of candidates) {
    try {
      const file = await fetchGitHubFile(config, joinRepoPath(docsRoot, relativePath));
      const page = createGitHubDocPage({ path: relativePath, slug: relativePathToSlug(relativePath) }, parseGitHubBlobRecord(file.sha, file.markdown), {});
      return withKnownMetadata(config, page);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  throw notFound("Document not found.");
};

export const loadGitHubDoc = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
  options?: { bypassCache?: boolean },
): Promise<GitHubDocPage> => {
  const access = beginGitHubCacheAccess(config);
  assertValidGitHubRuntimeConfig(config);
  const editorLocator = resolveEditorDocLocator(config, locator);
  const view = await loadGitHubDocsSourceView(config, { forceRefresh: options?.bypassCache });
  const indexed = findIndexedDocPage(view, editorLocator);
  if (indexed) {
    return withKnownMetadata(config, indexed);
  }

  const page = await loadUnindexedGitHubDoc(config, editorLocator);
  assertGitHubCacheAccess(access);
  return page;
};

const publicDocLookup = (config: GitHubRuntimeConfig, locator: CanonicalPublicDocLocator): { key: string; mode: "path" | "slug" } => {
  if (locator.kind !== "path") {
    return { key: locator.slug, mode: "slug" };
  }

  const stripped = stripRepoRoot(normalizeDocsPath(config.docsPath), locator.path);
  const relativePath = stripped === null ? locator.path : stripped;
  if (!relativePath) {
    throw badRequest("Document path is required.");
  }

  return markdownExtensionRegex.test(relativePath) ? { key: relativePath, mode: "path" } : { key: relativePathToSlug(relativePath), mode: "slug" };
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

/**
 * Public reads are deliberately index-authorized. Unlike the editor-capable loader above, an
 * unknown user-controlled locator is never converted into a speculative GitHub request: it is
 * answered from the published view alone. Callers may stop awaiting a shared load without
 * cancelling it for other visitors.
 */
export const loadPublicGitHubDoc = async (config: GitHubRuntimeConfig, locator: { slug?: string; path?: string }, options?: { signal?: AbortSignal }): Promise<GitHubDocPage> => {
  const canonicalLocator = canonicalizePublicDocLocator(locator);
  const access = beginGitHubCacheAccess(config);
  assertValidGitHubRuntimeConfig(config);
  const lookup = publicDocLookup(config, canonicalLocator);

  const view = await awaitWithAbort(loadGitHubDocsSourceView(config), options?.signal);
  assertGitHubCacheAccess(access);
  const page = lookup.mode === "path" ? view.pagesByPath.get(lookup.key) : view.pagesBySlug.get(lookup.key);
  if (!page) {
    throw notFound("Document not found.");
  }

  return withKnownMetadata(config, page);
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

export const listGitHubDocsForPlaintextExport = async (config: GitHubRuntimeConfig, options?: { bypassCache?: boolean }): Promise<GitHubPlaintextDocPage[]> => {
  const view = await loadGitHubDocsSourceView(config, { forceRefresh: options?.bypassCache });

  return view.pages.map((page): GitHubPlaintextDocPage => ({
    path: page.path,
    slug: page.slug,
    title: page.title.trim() || prettyNameFromPath(page.path),
    markdown: page.markdown,
    includeInPlaintextExport: page.includeInPlaintextExport,
  }));
};

const resolveSavePath = (config: GitHubRuntimeConfig, input: SaveGitHubDocInput): { relativePath: string; fullPath: string; slug: string } => {
  const docsRoot = normalizeDocsPath(config.docsPath);

  if (input.path?.trim()) {
    const relativePath = resolvePathFromInput(docsRoot, input.path);
    return {
      relativePath,
      fullPath: joinRepoPath(docsRoot, relativePath),
      slug: relativePathToSlug(relativePath),
    };
  }

  if (input.slug?.trim()) {
    const slug = resolveSlugInput(input.slug);
    const relativePath = ensureMarkdownPath(slug);

    return {
      relativePath,
      fullPath: joinRepoPath(docsRoot, relativePath),
      slug,
    };
  }

  throw badRequest("Either path or slug must be provided when saving a document.");
};

export const saveGitHubDoc = async (config: GitHubRuntimeConfig, input: SaveGitHubDocInput): Promise<SaveGitHubDocResult> => {
  const access = beginGitHubCacheAccess(config);
  assertValidGitHubRuntimeConfig(config);

  const target = resolveSavePath(config, input);

  let existingSha: string | undefined;
  let existingMarkdown = "";

  try {
    const existing = await fetchGitHubFile(config, target.fullPath);
    existingSha = existing.sha;
    existingMarkdown = existing.markdown;
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
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

  const record = parseGitHubBlobRecord("", markdown);
  if (!record.content.trim()) {
    throw badRequest("Document content cannot be empty.");
  }

  const commitMessage = input.commitMessage?.trim() || `docs: update ${target.relativePath}`;

  const writeResult = await getGitHubClient(config).repos.createOrUpdateFileContents({
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
  const metadata: GitHubCommitMetadata = {
    updatedAt: commitMeta.updatedAt ?? new Date().toISOString(),
    updatedBy: commitMeta.updatedBy,
  };
  const page = createGitHubDocPage(
    { path: target.relativePath, slug: target.slug },
    { ...record, sha: writeResult.data.content?.sha ?? existingSha ?? commitSha },
    metadata,
  );

  // The barrier is deliberately after GitHub confirms the commit. Failed remote
  // writes preserve the still-valid cache; successful writes invalidate old readers.
  const mutationAccess = await prepareGitHubCacheMutation(config);
  await applyCommittedGitHubDocPage(config, mutationAccess, { metadata, page, repoPath: target.fullPath });

  return {
    path: target.relativePath,
    slug: target.slug,
    commitSha,
    page,
  };
};
