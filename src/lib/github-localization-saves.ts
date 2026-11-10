import { assertGitHubCacheAccess, beginGitHubCacheAccess, prepareGitHubCacheMutation } from "@/lib/github-cache-invalidation";
import { getGitHubClient, gitHubErrorStatus } from "@/lib/github-client";
import { extractCommitMetadata, hydrateGitHubDocPageMetadata, type GitHubCommitMetadata } from "@/lib/github-commit-metadata";
import { fetchGitHubFile, gitBlobSha, parseGitHubBlobRecord } from "@/lib/github-content-store";
import { pruneRenderedMarkdownCache } from "@/lib/github-derived-caches";
import { applyCommittedGitHubFiles, validateGitHubRuntimeConfig } from "@/lib/github-docs-source";
import { createLocalizedDocPage } from "@/lib/github-localization";
import { localizedRepoPathForSourcePath } from "@/lib/github-paths";
import { badRequest } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import type { AutoTranslateLanguage, GitHubDocPage, GitHubRuntimeConfig, SaveGitHubDocInput, SaveGitHubDocResult } from "@/lib/types";

/**
 * Localization saves. Like editor saves, they apply the commit to the repository index, the
 * content store, and the commit metadata store, so a saved translation is served at once and the
 * next refresh needs only its tree request.
 */

/**
 * Most files and inline content bytes one tree request carries. GitHub writes inline content as
 * blobs itself, so committing N files costs ceil(N / chunk) tree requests instead of N blob
 * requests, which keeps bulk commits far below GitHub's limits of 80 content-generating requests
 * per minute and 500 per hour. The byte cap keeps each request well inside GitHub's 10-second
 * processing limit.
 */
const TREE_CHUNK_MAX_FILES = 100;
const TREE_CHUNK_MAX_BYTES = 1024 * 1024;

export type GitHubBranchHead = {
  commitSha: string;
  treeSha: string;
};

export type GitHubMarkdownCommitFile = {
  markdown: string;
  repoPath: string;
};

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

/**
 * Serializes a localized document from the input, falling back to the given fields for anything
 * it omits. Unmanaged front-matter keys and the recorded source version come from the Markdown
 * sent, or else from the translation being replaced.
 */
const serializeLocalizedMarkdown = (input: Omit<SaveGitHubDocInput, "path" | "slug">, fallback: MarkdownFields, existingMarkdown?: string): string => {
  const base = input.markdown !== undefined ? parseMarkdownDocument(input.markdown) : fallback;
  const markdown = serializeMarkdownDocument(
    {
      title: input.title ?? base.title,
      description: input.description ?? base.description,
      content: input.content ?? base.content,
      includeInPlaintextExport: input.includeInPlaintextExport ?? base.includeInPlaintextExport,
    },
    input.markdown ?? existingMarkdown,
  );

  if (!parseMarkdownDocument(markdown).content.trim()) {
    throw badRequest("Localized document content cannot be empty.");
  }
  return markdown;
};

const commitMetadataOrNow = (commit: unknown): GitHubCommitMetadata => {
  const metadata = extractCommitMetadata(commit);
  return { updatedAt: metadata.updatedAt ?? new Date().toISOString(), updatedBy: metadata.updatedBy };
};

/** Reads the branch head and its root tree (two bulk requests). */
export const readGitHubBranchHead = async (config: GitHubRuntimeConfig): Promise<GitHubBranchHead> => {
  const client = getGitHubClient(config);
  const ref = await client.git.getRef({ owner: config.owner, repo: config.repo, ref: `heads/${config.branch}`, request: { priority: "bulk" } });
  const commit = await client.git.getCommit({ owner: config.owner, repo: config.repo, commit_sha: ref.data.object.sha, request: { priority: "bulk" } });
  return { commitSha: ref.data.object.sha, treeSha: commit.data.tree.sha };
};

const chunkCommitFiles = (files: GitHubMarkdownCommitFile[]): GitHubMarkdownCommitFile[][] => {
  const chunks: GitHubMarkdownCommitFile[][] = [];
  let current: GitHubMarkdownCommitFile[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.markdown, "utf8");
    if (current.length > 0 && (current.length >= TREE_CHUNK_MAX_FILES || currentBytes + bytes > TREE_CHUNK_MAX_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

/**
 * Commits Markdown files on top of `head` through the Git data API: one tree request per chunk
 * with the content inline, each tree based on the previous one, then one commit and a ref update.
 * The update is not forced, so a branch that moved meanwhile rejects the commit (422) instead of
 * losing the other change. Trees and commits are content-addressed objects that nothing
 * references until the ref moves, so those requests are retried like reads. Blob SHAs are
 * computed locally: Git hashes exactly the UTF-8 bytes sent.
 */
export const commitGitHubMarkdownFiles = async ({
  config,
  files,
  head,
  message,
  onTreeChunk,
}: {
  config: GitHubRuntimeConfig;
  files: GitHubMarkdownCommitFile[];
  head: GitHubBranchHead;
  message: string;
  /** Called after each tree request with the number of files sent so far. */
  onTreeChunk?: (sentFiles: number) => void;
}): Promise<{ blobShas: string[]; commitSha: string; metadata: GitHubCommitMetadata }> => {
  const client = getGitHubClient(config);
  let treeSha = head.treeSha;
  let sentFiles = 0;
  for (const chunk of chunkCommitFiles(files)) {
    const tree = await client.git.createTree({
      owner: config.owner,
      repo: config.repo,
      base_tree: treeSha,
      tree: chunk.map((file) => ({ path: file.repoPath, mode: "100644" as const, type: "blob" as const, content: file.markdown })),
      request: { idempotent: true, priority: "bulk" },
    });
    treeSha = tree.data.sha;
    sentFiles += chunk.length;
    onTreeChunk?.(sentFiles);
  }

  const commit = await client.git.createCommit({
    owner: config.owner,
    repo: config.repo,
    message,
    tree: treeSha,
    parents: [head.commitSha],
    request: { idempotent: true, priority: "bulk" },
  });
  await client.git.updateRef({ owner: config.owner, repo: config.repo, ref: `heads/${config.branch}`, sha: commit.data.sha, request: { priority: "bulk" } });

  return {
    blobShas: files.map((file) => gitBlobSha(Buffer.from(file.markdown, "utf8"))),
    commitSha: commit.data.sha,
    metadata: commitMetadataOrNow(commit.data),
  };
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

  const markdown = serializeLocalizedMarkdown(input, existing ? parseMarkdownDocument(existing.markdown) : resolvedSourcePage, existing?.markdown);
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
 * Commits several localized documents as one commit (see `commitGitHubMarkdownFiles`): two reads,
 * one tree request per chunk, one commit, one ref update, all at bulk priority. `includePages:
 * false` skips building result pages.
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

  const prepared = items.map((item) => ({
    item,
    markdown: serializeLocalizedMarkdown(item.input, {
      title: item.sourcePage.title ?? "",
      description: item.sourcePage.description ?? "",
      content: item.sourcePage.content ?? "",
      includeInPlaintextExport: item.sourcePage.includeInPlaintextExport,
    }),
    repoPath: localizedRepoPathForSourcePath(item.localizationPath, item.language.code, item.sourcePage.path),
  }));
  const head = await readGitHubBranchHead(config);
  const commit = await commitGitHubMarkdownFiles({
    config,
    files: prepared,
    head,
    message: commitMessage?.trim() || `docs: update ${prepared.length} localization${prepared.length === 1 ? "" : "s"}`,
  });
  assertGitHubCacheAccess(access);

  const { metadata } = commit;
  const mutationAccess = await prepareGitHubCacheMutation(config);
  await applyCommittedGitHubFiles(
    config,
    mutationAccess,
    prepared.map((entry, index) => ({ markdown: entry.markdown, metadata, repoPath: entry.repoPath, sha: commit.blobShas[index] })),
  );
  await pruneRenderedMarkdownCache({
    config,
    reason: "localized-page-batch-save",
    targets: prepared.map((entry) => ({ languageCode: entry.item.language.code, slug: entry.item.sourcePage.slug })),
  });
  assertGitHubCacheAccess(mutationAccess);

  const results = includePages
    ? await Promise.all(
        prepared.map(async (entry, index) =>
          toSaveResult(
            commit.commitSha,
            createLocalizedDocPage({
              languageCode: entry.item.language.code,
              localizedRepoPath: entry.repoPath,
              metadata,
              record: parseGitHubBlobRecord(commit.blobShas[index], entry.markdown),
              sourcePage: await hydrateGitHubDocPageMetadata(config, entry.item.sourcePage),
            }),
          ),
        ),
      )
    : [];

  return { commitSha: commit.commitSha, results };
};
