import path from "node:path";

import { badRequest } from "@/lib/http";

/** Repository path rules shared by every GitHub docs reader and writer. */
export const markdownExtensionRegex = /\.(md|mdx)$/i;

const normalizeSlashes = (value: string): string => value.replace(/\\+/g, "/").replace(/\/+/g, "/");

export const normalizePathValue = (value: string): string => {
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

export const normalizeDocsPath = (docsPath: string): string => {
  if (!docsPath.trim()) {
    return "";
  }

  return normalizePathValue(docsPath);
};

export const normalizeLocalizationRoot = (localizationPath: string): string => {
  const normalized = normalizePathValue(localizationPath || "localizations");
  return normalized || "localizations";
};

export const normalizeLocalizationLanguageCode = (languageCode: string): string => {
  const normalized = languageCode.trim().replace(/_/g, "-");
  if (!normalized) {
    throw badRequest("Localization language code is required.");
  }

  return normalizePathValue(normalized);
};

export const ensureMarkdownPath = (relativePath: string): string => {
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

export const relativePathToSlug = (relativePath: string): string => relativePath.replace(markdownExtensionRegex, "");

export const prettyNameFromPath = (relativePath: string): string => {
  const base = path.posix.basename(relativePath).replace(markdownExtensionRegex, "");
  return base
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

export const joinRepoPath = (root: string, relativePath: string): string => (root ? `${root}/${relativePath}` : relativePath);

/** Returns the path below `root`, "" for the root itself, or null for paths outside it. */
export const stripRepoRoot = (root: string, repoPath: string): string | null => {
  if (!root) {
    return repoPath;
  }

  if (repoPath === root) {
    return "";
  }

  if (!repoPath.startsWith(`${root}/`)) {
    return null;
  }

  return repoPath.slice(root.length + 1);
};

export const resolvePathFromInput = (docsRoot: string, value: string): string => {
  const normalized = normalizePathValue(value);
  const stripped = stripRepoRoot(docsRoot, normalized);

  return ensureMarkdownPath(stripped === null ? normalized : stripped);
};

export const resolveSlugInput = (slug: string): string => normalizePathValue(slug).replace(markdownExtensionRegex, "");

export const localizedRepoPathForSourcePath = (localizationPath: string, languageCode: string, sourcePath: string): string => {
  const root = normalizeLocalizationRoot(localizationPath);
  const language = normalizeLocalizationLanguageCode(languageCode);
  return joinRepoPath(joinRepoPath(root, language), ensureMarkdownPath(sourcePath));
};
