import { aiPlaintextDocsCache } from "@/lib/cache";
import { listGitHubDocsForPlaintextExport, toRuntimeConfigCacheKey } from "@/lib/github";
import type { GitHubPlaintextDocPage, GitHubRuntimeConfig } from "@/lib/types";

export const AI_PLAINTEXT_EXPORT_PATH = "/docs.txt";

const PAGE_DIVIDER = "=".repeat(18);

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, "");

const toDocsPageUrl = (origin: string, slug: string): string => `${normalizeOrigin(origin)}/docs/${slug}`;

export const plaintextDocsCacheKey = (config: GitHubRuntimeConfig, origin: string): string =>
  `${toRuntimeConfigCacheKey(config)}|plaintext-export|${normalizeOrigin(origin)}`;

const renderPageBlock = (origin: string, doc: GitHubPlaintextDocPage): string => {
  const pageUrl = toDocsPageUrl(origin, doc.slug);
  const markdown = doc.markdown.replace(/\r\n/g, "\n").trimEnd();

  return [
    `${PAGE_DIVIDER} BEGIN PAGE: ${pageUrl} ${PAGE_DIVIDER}`,
    markdown,
    `${PAGE_DIVIDER} END PAGE: ${pageUrl} ${PAGE_DIVIDER}`,
  ].join("\n\n");
};

export const renderPlaintextDocsExport = (origin: string, docs: GitHubPlaintextDocPage[]): string => {
  const includedDocs = docs.filter((doc) => doc.includeInPlaintextExport);

  if (includedDocs.length === 0) {
    return [
      `${PAGE_DIVIDER} DOCS PLAINTEXT EXPORT ${PAGE_DIVIDER}`,
      `No docs pages are currently included in ${AI_PLAINTEXT_EXPORT_PATH}.`,
      `${PAGE_DIVIDER} END DOCS PLAINTEXT EXPORT ${PAGE_DIVIDER}`,
    ].join("\n\n");
  }

  return includedDocs.map((doc) => renderPageBlock(origin, doc)).join("\n\n");
};

export const getPlaintextDocsExport = async (config: GitHubRuntimeConfig, origin: string): Promise<string> => {
  const cacheKey = plaintextDocsCacheKey(config, origin);
  const cached = aiPlaintextDocsCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const docs = await listGitHubDocsForPlaintextExport(config, { bypassCache: true });
  const rendered = renderPlaintextDocsExport(origin, docs);
  aiPlaintextDocsCache.set(cacheKey, rendered);
  return rendered;
};
