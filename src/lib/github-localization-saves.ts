import { assertGitHubCacheAccess, beginGitHubCacheAccess, prepareGitHubCacheMutation } from "@/lib/github-cache-invalidation";
import { getGitHubClient, gitHubErrorStatus } from "@/lib/github-client";
import { extractCommitMetadata, hydrateGitHubDocPageMetadata, type GitHubCommitMetadata } from "@/lib/github-commit-metadata";
import { fetchGitHubFile, gitBlobSha, parseGitHubBlobRecord } from "@/lib/github-content-store";
import { pruneRenderedMarkdownCache } from "@/lib/github-derived-caches";
import { applyCommittedGitHubFiles, validateGitHubRuntimeConfig } from "@/lib/github-docs-source";
import { createLocalizedDocPage, mapWithConcurrency } from "@/lib/github-localization";
import { localizedRepoPathForSourcePath } from "@/lib/github-paths";
import { badRequest } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import type { AutoTranslateLanguage, GitHubDocPage, GitHubRuntimeConfig, SaveGitHubDocInput, SaveGitHubDocResult } from "@/lib/types";

/**
 * Localization saves. Like editor saves, they apply the commit to the repository index, the
 * content store, and the commit metadata store, so a saved translation is served at once and the
 * next refresh needs only its tree request.
 */

const BLOB_CREATE_CONCURRENCY = 6;

export type GitHubLocalizedDocSourcePage = Pick<GitHubDocPage, "path" | "slug" | "sha" | "includeInPlaintextExport" | "updatedAt" | "updatedBy"> &
  Partial<Pick<GitHubDocPage, "title" | "description" | "content">>;

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

type MarkdownFields = Pick<GitHubDocPage, "title" | "description" | "content" | "includeInPlaintextExport">;

const isNotFoundError = (error: unknown): boolean => gitHubErrorStatus(error) === 404;

/** Serializes a localized document from the input, falling back to the given fields for anything it omits. */
const serializeLocalizedMarkdown = (input: Omit<SaveGitHubDocInput, "path" | "slug">, fallback: MarkdownFields): string => {
  const base = input.markdown !== undefined ? parseMarkdownDocument(input.markdown) : fallback;
  const markdown = serializeMarkdownDocument({
    title: input.title ?? base.title,
    description: input.description ?? base.description,
    content: input.content ?? base.content,
    includeInPlaintextExport: input.includeInPlaintextExport ?? base.includeInPlaintextExport,
  });

  if (!parseMarkdownDocument(markdown).content.trim()) {
    throw badRequest("Localized document content cannot be empty.");
  }
  return markdown;
};

const commitMetadataOrNow = (commit: unknown): GitHubCommitMetadata => {
  const metadata = extractCommitMetadata(commit);
  return { updatedAt: metadata.updatedAt ?? new Date().toISOString(), updatedBy: metadata.updatedBy };
};

const toSaveResult = (commitSha: string, page: GitHubDocPage): SaveGitHubDocResult => ({
  path: page.path,
  slug: page.slug,
  commitSha,
  page: { ...page, translationStale: false, localizationStatus: "current" },
});

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
  const fullPath = localizedRepoPathForSourcePath(localizationPath, language.code, resolvedSourcePage.path);

  let existing: { markdown: string; sha: string } | null = null;
  try {
    existing = await fetchGitHubFile(config, fullPath);
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const markdown = serializeLocalizedMarkdown(input, existing ? parseMarkdownDocument(existing.markdown) : resolvedSourcePage);
  const writeResult = await getGitHubClient(config).repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: fullPath,
    message: input.commitMessage?.trim() || `docs: update ${language.code} localization for ${resolvedSourcePage.path}`,
    content: Buffer.from(markdown, "utf8").toString("base64"),
    branch: config.branch,
    sha: existing?.sha,
  });
  assertGitHubCacheAccess(access);

  const commitSha = writeResult.data.commit?.sha;
  if (!commitSha) {
    throw new Error("GitHub response did not include a commit SHA.");
  }

  const metadata = commitMetadataOrNow(writeResult.data.commit);
  const sha = writeResult.data.content?.sha ?? gitBlobSha(Buffer.from(markdown, "utf8"));
  const page = createLocalizedDocPage({
    languageCode: language.code,
    localizedRepoPath: fullPath,
    metadata,
    record: parseGitHubBlobRecord(sha, markdown),
    sourcePage: resolvedSourcePage,
  });

  // As for editor saves, the barrier follows GitHub's confirmation: a failed write keeps every cache.
  const mutationAccess = await prepareGitHubCacheMutation(config);
  await applyCommittedGitHubFiles(config, mutationAccess, [{ markdown, metadata, repoPath: fullPath, sha }]);
  await pruneRenderedMarkdownCache({ config, reason: "localized-page-save", targets: [{ languageCode: language.code, slug: page.slug }] });
  assertGitHubCacheAccess(mutationAccess);

  return toSaveResult(commitSha, page);
};

/**
 * Commits several localized documents at once through the Git data API (one blob per document,
 * then one tree, commit, and ref update). `includePages: false` skips building result pages.
 */
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

  const client = getGitHubClient(config);
  const refName = `heads/${config.branch}`;
  const ref = await client.git.getRef({ owner: config.owner, repo: config.repo, ref: refName });
  const baseCommitSha = ref.data.object.sha;
  const baseCommit = await client.git.getCommit({ owner: config.owner, repo: config.repo, commit_sha: baseCommitSha });
  const preparedItems = await mapWithConcurrency(items, BLOB_CREATE_CONCURRENCY, async (item) => {
    const fullPath = localizedRepoPathForSourcePath(item.localizationPath, item.language.code, item.sourcePage.path);
    const markdown = serializeLocalizedMarkdown(item.input, {
      title: item.sourcePage.title ?? "",
      description: item.sourcePage.description ?? "",
      content: item.sourcePage.content ?? "",
      includeInPlaintextExport: item.sourcePage.includeInPlaintextExport,
    });
    const blob = await client.git.createBlob({ owner: config.owner, repo: config.repo, content: markdown, encoding: "utf-8" });
    return { blobSha: blob.data.sha, fullPath, item, markdown };
  });
  const tree = await client.git.createTree({
    owner: config.owner,
    repo: config.repo,
    base_tree: baseCommit.data.tree.sha,
    tree: preparedItems.map((item) => ({ path: item.fullPath, mode: "100644" as const, type: "blob" as const, sha: item.blobSha })),
  });
  const commit = await client.git.createCommit({
    owner: config.owner,
    repo: config.repo,
    message: commitMessage?.trim() || `docs: update ${preparedItems.length} localization${preparedItems.length === 1 ? "" : "s"}`,
    tree: tree.data.sha,
    parents: [baseCommitSha],
  });
  await client.git.updateRef({ owner: config.owner, repo: config.repo, ref: refName, sha: commit.data.sha });
  assertGitHubCacheAccess(access);

  const metadata = commitMetadataOrNow(commit.data);
  const mutationAccess = await prepareGitHubCacheMutation(config);
  await applyCommittedGitHubFiles(
    config,
    mutationAccess,
    preparedItems.map((item) => ({ markdown: item.markdown, metadata, repoPath: item.fullPath, sha: item.blobSha })),
  );
  await pruneRenderedMarkdownCache({
    config,
    reason: "localized-page-batch-save",
    targets: preparedItems.map((item) => ({ languageCode: item.item.language.code, slug: item.item.sourcePage.slug })),
  });
  assertGitHubCacheAccess(mutationAccess);

  const results = includePages
    ? await Promise.all(
        preparedItems.map(async (item) =>
          toSaveResult(
            commit.data.sha,
            createLocalizedDocPage({
              languageCode: item.item.language.code,
              localizedRepoPath: item.fullPath,
              metadata,
              record: parseGitHubBlobRecord(item.blobSha, item.markdown),
              sourcePage: await hydrateGitHubDocPageMetadata(config, item.item.sourcePage),
            }),
          ),
        ),
      )
    : [];

  return { commitSha: commit.data.sha, results };
};
