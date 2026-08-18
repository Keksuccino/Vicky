import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { GitHubRuntimeConfig } from "@/lib/types";

const LEGACY_GITHUB_CACHE_EPOCH = "legacy";

const normalizeSourcePart = (value: string): string =>
  value
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

export const normalizeGitHubCacheEpoch = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : LEGACY_GITHUB_CACHE_EPOCH;

export const createGitHubCacheEpoch = (): string => randomUUID();

export const gitHubDocsLogicalSourceKey = (config: GitHubRuntimeConfig): string =>
  [
    normalizeSourcePart(config.owner),
    normalizeSourcePart(config.repo),
    normalizeSourcePart(config.branch),
    normalizeSourcePart(config.docsPath),
  ].join("|");

const credentialFingerprint = (token: string): string =>
  createHash("sha256").update(token.trim(), "utf8").digest("hex");

/**
 * Reproduces the token-agnostic source prefix used by Vicky before store v12.
 * Keep this separate from the current logical key: legacy runtime keys normalized
 * only docsPath, while legacy snapshot filenames normalized every source part.
 */
export const legacyGitHubRuntimeCacheKey = (config: GitHubRuntimeConfig): string => {
  const normalized = config.docsPath.replace(/\\+/g, "/").replace(/\/+/g, "/").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const docsPath = normalized ? path.posix.normalize(normalized) : "";
  return [config.owner, config.repo, config.branch, docsPath].join("|");
};

/**
 * Cache identities deliberately contain a security epoch and a one-way credential
 * fingerprint. The epoch makes a re-used token a new authorization context, while
 * the fingerprint keeps legacy/config objects without an epoch isolated on rotation.
 */
export const gitHubRuntimeCacheKey = (config: GitHubRuntimeConfig): string =>
  [
    gitHubDocsLogicalSourceKey(config),
    `auth-${credentialFingerprint(config.token)}`,
    `epoch-${normalizeGitHubCacheEpoch(config.cacheEpoch)}`,
  ].join("|");
