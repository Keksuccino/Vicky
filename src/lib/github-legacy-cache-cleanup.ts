import { aiPlaintextDocsCache, docsSearchCorpusCache, renderedMarkdownCache } from "@/lib/cache";
import { gitHubDocsLogicalSourceKey, legacyGitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { getGitHubDocsCacheDir, removeLegacyDocsSnapshots } from "@/lib/github-docs-cache-files";
import { deletePersistentRenderedMarkdownWhere, recordRenderedMarkdownCacheMutation } from "@/lib/markdown-render-cache-store";
import type { GitHubRuntimeConfig } from "@/lib/types";

export type LegacyGitHubCacheCleanupResult = {
  docsCacheFiles: number;
  renderedEntries: number;
};

const matchesLegacyNamespace = (key: string, prefix: string, namespaces: string[]): boolean =>
  namespaces.some((namespace) => key === `${prefix}${namespace}` || key.startsWith(`${prefix}${namespace}|`));

/**
 * Removes the token-agnostic cache formats written before store v12. Namespace
 * matching is intentional: a broad logical-source prefix would also match and
 * delete current auth-fingerprint/epoch entries for the same repository.
 * Whole-docs snapshots of every source are obsolete, so all of them are removed.
 */
export const cleanupLegacyGitHubLogicalSourceCaches = async (config: GitHubRuntimeConfig, options?: { recordMutation?: boolean }): Promise<LegacyGitHubCacheCleanupResult> => {
  const prefix = `${legacyGitHubRuntimeCacheKey(config)}|`;

  docsSearchCorpusCache.deleteWhere((key) => matchesLegacyNamespace(key, prefix, ["search-corpus"]));
  aiPlaintextDocsCache.deleteWhere((key) => matchesLegacyNamespace(key, prefix, ["plaintext-export"]));
  renderedMarkdownCache.deleteWhere((key) => matchesLegacyNamespace(key, prefix, ["markdown-render"]));

  const [docsCacheFiles, renderedEntries] = await Promise.all([
    removeLegacyDocsSnapshots(getGitHubDocsCacheDir()),
    deletePersistentRenderedMarkdownWhere((key) => matchesLegacyNamespace(key, prefix, ["markdown-render"])),
  ]);

  if (options?.recordMutation !== false) {
    await recordRenderedMarkdownCacheMutation({
      deletedEntries: renderedEntries,
      reason: "legacy-docs-cache-migration",
      scope: "all",
      target: gitHubDocsLogicalSourceKey(config),
    });
  }

  return {
    docsCacheFiles,
    renderedEntries,
  };
};
