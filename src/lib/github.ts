import path from "node:path";

import { Octokit } from "@octokit/rest";

import { docsPageCache, docsTreeCache } from "@/lib/cache";
import { decryptSecret } from "@/lib/encryption";
import { badRequest, notFound } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import type {
  GitHubDocPage,
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

const toRuntimeConfigKey = (config: GitHubRuntimeConfig): string =>
  [config.owner, config.repo, config.branch, normalizeDocsPath(config.docsPath)].join("|");

const treeCacheKey = (config: GitHubRuntimeConfig): string => `${toRuntimeConfigKey(config)}|tree`;
const pageCacheKey = (config: GitHubRuntimeConfig, fullPath: string): string => `${toRuntimeConfigKey(config)}|page|${fullPath}`;

const createOctokit = (config: GitHubRuntimeConfig): Octokit =>
  new Octokit({
    auth: config.token,
  });

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
    docsTreeCache.clear();
    docsPageCache.clear();
    return;
  }

  const prefix = `${toRuntimeConfigKey(config)}|`;
  docsTreeCache.deleteWhere((key) => key.startsWith(prefix));
  docsPageCache.deleteWhere((key) => key.startsWith(prefix));
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

export const listMarkdownDocsTree = async (config: GitHubRuntimeConfig): Promise<GitHubDocTreeItem[]> => {
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const cacheKey = treeCacheKey(config);
  const cached = docsTreeCache.get(cacheKey);

  if (cached) {
    return cached as GitHubDocTreeItem[];
  }

  const docs = await listDocsTreeFromGitHub(config);
  docsTreeCache.set(cacheKey, docs);
  return docs;
};

const fetchFileFromGitHub = async (
  config: GitHubRuntimeConfig,
  fullRepoPath: string,
): Promise<{ sha: string; markdown: string }> => {
  const octokit = createOctokit(config);

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
): Promise<{ updatedAt?: string; updatedBy?: string }> => {
  const octokit = createOctokit(config);

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

const resolveExistingPath = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
): Promise<{ relativePath: string; fullPath: string; slug: string }> => {
  const docsRoot = normalizeDocsPath(config.docsPath);

  if (locator.path?.trim()) {
    const relativePath = resolvePathFromInput(docsRoot, locator.path);
    return {
      relativePath,
      fullPath: joinDocsPath(docsRoot, relativePath),
      slug: relativePathToSlug(relativePath),
    };
  }

  if (!locator.slug?.trim()) {
    throw badRequest("A slug or path query parameter is required.");
  }

  const normalizedSlug = resolveSlugInput(locator.slug);
  const tree = await listMarkdownDocsTree(config);
  const match = tree.find((item) => item.slug === normalizedSlug || item.path === normalizedSlug);

  if (!match) {
    throw notFound("Document not found for the provided slug.");
  }

  return {
    relativePath: match.path,
    fullPath: joinDocsPath(docsRoot, match.path),
    slug: match.slug,
  };
};

export const loadGitHubDoc = async (
  config: GitHubRuntimeConfig,
  locator: { slug?: string; path?: string },
): Promise<GitHubDocPage> => {
  const validation = validateGitHubRuntimeConfig(config);

  if (!validation.valid) {
    throw badRequest(validation.errors.join(" "));
  }

  const resolved = await resolveExistingPath(config, locator);
  const cacheKey = pageCacheKey(config, resolved.fullPath);
  const cached = docsPageCache.get(cacheKey);

  if (cached) {
    return cached as GitHubDocPage;
  }

  const file = await fetchFileFromGitHub(config, resolved.fullPath);
  const commitMeta = await fetchLatestCommitMetadata(config, resolved.fullPath);
  const parsed = parseMarkdownDocument(file.markdown);

  const page: GitHubDocPage = {
    path: resolved.relativePath,
    slug: resolved.slug,
    sha: file.sha,
    title: parsed.title,
    description: parsed.description,
    content: parsed.content,
    markdown: file.markdown,
    headings: parsed.headings,
    updatedAt: commitMeta.updatedAt,
    updatedBy: commitMeta.updatedBy,
  };

  docsPageCache.set(cacheKey, page);
  return page;
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

  if (input.markdown !== undefined) {
    const parsedIncoming = parseMarkdownDocument(input.markdown);
    baseTitle = parsedIncoming.title;
    baseDescription = parsedIncoming.description;
    baseContent = parsedIncoming.content;
  } else if (existingMarkdown) {
    const parsedExisting = parseMarkdownDocument(existingMarkdown);
    baseTitle = parsedExisting.title;
    baseDescription = parsedExisting.description;
    baseContent = parsedExisting.content;
  }

  const markdown = serializeMarkdownDocument({
    title: input.title ?? baseTitle,
    description: input.description ?? baseDescription,
    content: input.content ?? baseContent,
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

  clearGitHubDocsCache(config);

  return {
    path: target.relativePath,
    slug: target.slug,
    commitSha,
  };
};
