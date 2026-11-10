import { docsSearchCorpusCache, docsSnapshotCache } from "@/lib/cache";
import { assertGitHubCacheAccess, beginGitHubCacheAccess, prepareGitHubCacheMutation } from "@/lib/github-cache-invalidation";
import { getGitHubClient, gitHubErrorStatus } from "@/lib/github-client";
import {
  extractCommitMetadata,
  hydrateGitHubDocPageMetadata,
  resolveGitHubCommitMetadata,
  type GitHubCommitMetadata,
} from "@/lib/github-commit-metadata";
import { fetchGitHubFile, parseGitHubBlobRecord } from "@/lib/github-content-store";
import { clearLocalizationCaches, pruneRenderedMarkdownCache } from "@/lib/github-derived-caches";
import {
  ensureMarkdownPath,
  joinRepoPath,
  localizedRepoPathForSourcePath,
  markdownExtensionRegex,
  normalizeLocalizationLanguageCode,
  normalizeLocalizationRoot,
  normalizePathValue,
  prettyNameFromPath,
  relativePathToSlug,
  stripRepoRoot,
} from "@/lib/github-paths";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { createGitHubDocPage, sortTreeItems, treeItemFromPage, validateGitHubRuntimeConfig } from "@/lib/github-docs-source";
import { badRequest } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type {
  AutoTranslateLanguage,
  GitHubDocPage,
  GitHubDocTreeItem,
  GitHubRuntimeConfig,
  SaveGitHubDocInput,
  SaveGitHubDocResult,
} from "@/lib/types";

const FULL_DOCS_LOAD_CONCURRENCY = 6;

type GitHubLocalizationSnapshot = {
  fetchedAt: string;
  expiresAt: string;
  tree: GitHubDocTreeItem[];
  pages: GitHubDocPage[];
};

export type GitHubLocalizationPageStatus = {
  path: string;
  slug: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type GitHubLocalizedDocSourcePage = Pick<
  GitHubDocPage,
  "path" | "slug" | "sha" | "includeInPlaintextExport" | "updatedAt" | "updatedBy"
> &
  Partial<Pick<GitHubDocPage, "title" | "description" | "content">>;

export type GitHubLocalizedDocResult = {
  sourcePage: GitHubDocPage;
  page: GitHubDocPage | null;
  status: "current" | "outdated" | "missing";
  localizedRepoPath: string;
};

type GitHubMarkdownTreeEntry = GitHubDocTreeItem & {
  fullPath: string;
  sha: string;
};

const localizationSnapshotLoads = processSingleton("githubLocalization.snapshotLoads", () => new Map<string, Promise<GitHubLocalizationSnapshot>>());

const localizationSnapshotCacheKey = (config: GitHubRuntimeConfig, localizationPath: string, languageCode: string): string =>
  `${gitHubRuntimeCacheKey(config)}|localization-snapshot|${normalizeLocalizationRoot(localizationPath)}|${languageCode.toLowerCase()}`;

const mapWithConcurrency = async <T, R>(values: T[], concurrency: number, iteratee: (value: T, index: number) => Promise<R>): Promise<R[]> => {
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

const listMarkdownTreeEntriesFromGitHub = async (config: GitHubRuntimeConfig, rootPath: string): Promise<GitHubMarkdownTreeEntry[]> => {
  const client = getGitHubClient(config);
  const docsRoot = normalizePathValue(rootPath);

  const branch = await client.repos.getBranch({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });

  const treeResponse = await client.git.getTree({
    owner: config.owner,
    repo: config.repo,
    tree_sha: branch.data.commit.commit.tree.sha,
    recursive: "1",
  });

  const treeItems: GitHubMarkdownTreeEntry[] = [];

  for (const node of treeResponse.data.tree) {
    if (node.type !== "blob" || !node.path || !node.sha) {
      continue;
    }

    const repoPath = normalizePathValue(node.path);
    if (!markdownExtensionRegex.test(repoPath)) {
      continue;
    }

    const relativePath = stripRepoRoot(docsRoot, repoPath);

    if (relativePath === null || !relativePath) {
      continue;
    }

    const markdownPath = ensureMarkdownPath(relativePath);
    treeItems.push({
      fullPath: repoPath,
      path: markdownPath,
      sha: node.sha,
      slug: relativePathToSlug(markdownPath),
      name: prettyNameFromPath(markdownPath),
    });
  }

  treeItems.sort((left, right) => left.path.localeCompare(right.path));
  return treeItems;
};

const languageRootPath = (localizationPath: string, languageCode: string): string =>
  joinRepoPath(normalizeLocalizationRoot(localizationPath), normalizeLocalizationLanguageCode(languageCode));

const createLocalizedDocPage = ({
  commitMeta,
  file,
  languageCode,
  localizedRepoPath,
  sourcePage,
}: {
  commitMeta: GitHubCommitMetadata;
  file: { sha: string; markdown: string };
  languageCode: string;
  localizedRepoPath: string;
  sourcePage: Pick<GitHubDocPage, "path" | "slug" | "updatedAt"> & Partial<Pick<GitHubDocPage, "title">>;
}): GitHubDocPage => {
  const page = createGitHubDocPage(sourcePage, parseGitHubBlobRecord(file.sha, file.markdown), commitMeta);

  return {
    ...page,
    languageCode,
    sourceLanguage: false,
    sourcePath: sourcePage.path,
    sourceSlug: sourcePage.slug,
    sourceUpdatedAt: sourcePage.updatedAt,
    translationPath: localizedRepoPath,
    translationUpdatedAt: page.updatedAt,
  };
};

const isTranslationOutdated = (sourcePage: GitHubDocPage, translatedPage: GitHubDocPage): boolean => {
  const sourceTime = sourcePage.updatedAt ? Date.parse(sourcePage.updatedAt) : Number.NaN;
  const translationTime = translatedPage.updatedAt ? Date.parse(translatedPage.updatedAt) : Number.NaN;

  return Number.isFinite(sourceTime) && Number.isFinite(translationTime) && sourceTime > translationTime;
};

const isNotFoundError = (error: unknown): boolean => gitHubErrorStatus(error) === 404;

export const loadGitHubLocalizedDoc = async ({
  config,
  language,
  localizationPath,
  sourcePage,
}: {
  config: GitHubRuntimeConfig;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePage: GitHubDocPage;
}): Promise<GitHubLocalizedDocResult> => {
  const access = beginGitHubCacheAccess(config);
  const resolvedSourcePage = await hydrateGitHubDocPageMetadata(config, sourcePage);
  const localizedRepoPath = localizedRepoPathForSourcePath(localizationPath, language.code, resolvedSourcePage.path);

  try {
    const file = await fetchGitHubFile(config, localizedRepoPath);
    const commitMeta = (await resolveGitHubCommitMetadata(config, access, [{ path: localizedRepoPath, sha: file.sha }])).get(localizedRepoPath) ?? {};
    assertGitHubCacheAccess(access);
    const page = createLocalizedDocPage({
      commitMeta,
      file,
      languageCode: language.code,
      localizedRepoPath,
      sourcePage: resolvedSourcePage,
    });
    const outdated = isTranslationOutdated(resolvedSourcePage, page);

    return {
      sourcePage: resolvedSourcePage,
      page: {
        ...page,
        translationStale: outdated,
        localizationStatus: outdated ? "outdated" : "current",
      },
      status: outdated ? "outdated" : "current",
      localizedRepoPath,
    };
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    return {
      sourcePage: resolvedSourcePage,
      page: null,
      status: "missing",
      localizedRepoPath,
    };
  }
};

export const loadGitHubLocalizationSnapshot = async ({
  config,
  language,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<GitHubLocalizationSnapshot> => {
  const access = beginGitHubCacheAccess(config);
  const cacheKey = localizationSnapshotCacheKey(config, localizationPath, language.code);
  const loadKey = `${cacheKey}|generation-${access.generation}`;
  const previousSnapshot = docsSnapshotCache.peek(cacheKey) as GitHubLocalizationSnapshot | undefined;
  const cached = docsSnapshotCache.get(cacheKey);
  if (cached) {
    return cached as GitHubLocalizationSnapshot;
  }

  const pending = localizationSnapshotLoads.get(loadKey);
  if (pending) {
    const snapshot = await pending;
    assertGitHubCacheAccess(access);
    return snapshot;
  }

  const loadPromise = (async () => {
    const sourcePageByPath = new Map(sourcePages.map((page) => [page.path, page]));
    const entries = (await listMarkdownTreeEntriesFromGitHub(config, languageRootPath(localizationPath, language.code))).filter((item) =>
      sourcePageByPath.has(item.path),
    );
    const commitMetadata = await resolveGitHubCommitMetadata(config, access, entries.map((item) => ({ path: item.fullPath, sha: item.sha })));
    const pages = await mapWithConcurrency(entries, FULL_DOCS_LOAD_CONCURRENCY, async (item): Promise<GitHubDocPage | null> => {
      const sourcePage = sourcePageByPath.get(item.path);
      if (!sourcePage) {
        return null;
      }

      const file = await fetchGitHubFile(config, item.fullPath);
      return createLocalizedDocPage({
        commitMeta: file.sha === item.sha ? commitMetadata.get(item.fullPath) ?? {} : {},
        file,
        languageCode: language.code,
        localizedRepoPath: item.fullPath,
        sourcePage,
      });
    });
    const filteredPages = pages.filter((page): page is GitHubDocPage => Boolean(page));
    const fetchedAtMs = Date.now();
    const snapshot = {
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      expiresAt: new Date(fetchedAtMs + docsSnapshotCache.getTtlMs()).toISOString(),
      tree: sortTreeItems(filteredPages.map((page) => treeItemFromPage(page))),
      pages: filteredPages,
    };

    if (previousSnapshot) {
      const nextPagesBySlug = new Map(snapshot.pages.map((page) => [page.slug, page]));
      const changedSlugs = previousSnapshot.pages.filter((page) => nextPagesBySlug.get(page.slug)?.content !== page.content).map((page) => page.slug);
      if (changedSlugs.length > 0) {
        await pruneRenderedMarkdownCache({
          config,
          reason: "localization-snapshot-change",
          targets: changedSlugs.map((slug) => ({ languageCode: language.code, slug })),
        });
      }
      docsSearchCorpusCache.deleteWhere((key) => key.startsWith(`${gitHubRuntimeCacheKey(config)}|search-corpus|`));
    }

    assertGitHubCacheAccess(access);
    docsSnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  })().finally(() => {
    if (localizationSnapshotLoads.get(loadKey) === loadPromise) {
      localizationSnapshotLoads.delete(loadKey);
    }
  });

  localizationSnapshotLoads.set(loadKey, loadPromise);
  return loadPromise;
};

export const loadGitHubLocalizationStatusIndex = async ({
  config,
  language,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  language: Pick<AutoTranslateLanguage, "code">;
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<Map<string, GitHubLocalizationPageStatus>> => {
  const access = beginGitHubCacheAccess(config);
  const sourcePaths = new Set(sourcePages.map((page) => page.path));
  const entries = (await listMarkdownTreeEntriesFromGitHub(config, languageRootPath(localizationPath, language.code))).filter((item) => sourcePaths.has(item.path));
  const commitMetadata = await resolveGitHubCommitMetadata(config, access, entries.map((item) => ({ path: item.fullPath, sha: item.sha })));
  assertGitHubCacheAccess(access);

  return new Map(
    entries.map((item) => {
      const metadata = commitMetadata.get(item.fullPath);
      return [item.path, { path: item.path, slug: item.slug, updatedAt: metadata?.updatedAt, updatedBy: metadata?.updatedBy }];
    }),
  );
};

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

  let existingSha: string | undefined;
  let existingMarkdown = "";

  try {
    const existing = await fetchGitHubFile(config, fullPath);
    existingSha = existing.sha;
    existingMarkdown = existing.markdown;
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  let baseTitle = resolvedSourcePage.title;
  let baseDescription = resolvedSourcePage.description;
  let baseContent = resolvedSourcePage.content;
  let baseIncludeInPlaintextExport = resolvedSourcePage.includeInPlaintextExport;

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
    throw badRequest("Localized document content cannot be empty.");
  }

  const commitMessage = input.commitMessage?.trim() || `docs: update ${language.code} localization for ${resolvedSourcePage.path}`;

  const writeResult = await getGitHubClient(config).repos.createOrUpdateFileContents({
    owner: config.owner,
    repo: config.repo,
    path: fullPath,
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
  const page = createLocalizedDocPage({
    commitMeta: {
      updatedAt: commitMeta.updatedAt ?? new Date().toISOString(),
      updatedBy: commitMeta.updatedBy,
    },
    file: {
      sha: writeResult.data.content?.sha ?? existingSha ?? commitSha,
      markdown,
    },
    languageCode: language.code,
    localizedRepoPath: fullPath,
    sourcePage: resolvedSourcePage,
  });

  const mutationAccess = await prepareGitHubCacheMutation(config);
  clearLocalizationCaches(config, localizationPath, language.code);
  await pruneRenderedMarkdownCache({
    config,
    reason: "localized-page-save",
    targets: [{ languageCode: language.code, slug: page.slug }],
  });
  assertGitHubCacheAccess(mutationAccess);

  return {
    path: page.path,
    slug: page.slug,
    commitSha,
    page: {
      ...page,
      translationStale: false,
      localizationStatus: "current",
    },
  };
};

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
  const ref = await client.git.getRef({
    owner: config.owner,
    repo: config.repo,
    ref: refName,
  });
  const baseCommitSha = ref.data.object.sha;
  const baseCommit = await client.git.getCommit({
    owner: config.owner,
    repo: config.repo,
    commit_sha: baseCommitSha,
  });
  const baseTreeSha = baseCommit.data.tree.sha;
  const preparedItems = await mapWithConcurrency(items, FULL_DOCS_LOAD_CONCURRENCY, async (item) => {
    const resolvedSourcePage = await hydrateGitHubDocPageMetadata(config, item.sourcePage);
    const fullPath = localizedRepoPathForSourcePath(item.localizationPath, item.language.code, resolvedSourcePage.path);
    let baseTitle = resolvedSourcePage.title ?? "";
    let baseDescription = resolvedSourcePage.description ?? "";
    let baseContent = resolvedSourcePage.content ?? "";
    let baseIncludeInPlaintextExport = resolvedSourcePage.includeInPlaintextExport;

    if (item.input.markdown !== undefined) {
      const parsedIncoming = parseMarkdownDocument(item.input.markdown);
      baseTitle = parsedIncoming.title;
      baseDescription = parsedIncoming.description;
      baseContent = parsedIncoming.content;
      baseIncludeInPlaintextExport = parsedIncoming.includeInPlaintextExport;
    }

    const markdown = serializeMarkdownDocument({
      title: item.input.title ?? baseTitle,
      description: item.input.description ?? baseDescription,
      content: item.input.content ?? baseContent,
      includeInPlaintextExport: item.input.includeInPlaintextExport ?? baseIncludeInPlaintextExport,
    });
    const parsedOutput = parseMarkdownDocument(markdown);
    if (!parsedOutput.content.trim()) {
      throw badRequest("Localized document content cannot be empty.");
    }

    const blob = await client.git.createBlob({
      owner: config.owner,
      repo: config.repo,
      content: markdown,
      encoding: "utf-8",
    });

    return {
      fullPath,
      item,
      markdown: includePages ? markdown : undefined,
      resolvedSourcePage,
      blobSha: blob.data.sha,
    };
  });
  const tree = await client.git.createTree({
    owner: config.owner,
    repo: config.repo,
    base_tree: baseTreeSha,
    tree: preparedItems.map((item) => ({
      path: item.fullPath,
      mode: "100644" as const,
      type: "blob" as const,
      sha: item.blobSha,
    })),
  });
  const commit = await client.git.createCommit({
    owner: config.owner,
    repo: config.repo,
    message: commitMessage?.trim() || `docs: update ${preparedItems.length} localization${preparedItems.length === 1 ? "" : "s"}`,
    tree: tree.data.sha,
    parents: [baseCommitSha],
  });
  await client.git.updateRef({
    owner: config.owner,
    repo: config.repo,
    ref: refName,
    sha: commit.data.sha,
  });
  assertGitHubCacheAccess(access);

  const commitMeta = extractCommitMetadata(commit.data);
  const updatedAt = commitMeta.updatedAt ?? new Date().toISOString();
  const mutationAccess = await prepareGitHubCacheMutation(config);
  for (const item of preparedItems) {
    clearLocalizationCaches(config, item.item.localizationPath, item.item.language.code);
  }
  await pruneRenderedMarkdownCache({
    config,
    reason: "localized-page-batch-save",
    targets: preparedItems.map((item) => ({
      languageCode: item.item.language.code,
      slug: item.resolvedSourcePage.slug,
    })),
  });
  assertGitHubCacheAccess(mutationAccess);

  const results = includePages
    ? preparedItems.map((item): SaveGitHubDocResult => {
        if (item.markdown === undefined) {
          throw new Error("Localized document page output was not retained.");
        }

        const page = createLocalizedDocPage({
          commitMeta: {
            updatedAt,
            updatedBy: commitMeta.updatedBy,
          },
          file: {
            sha: item.blobSha,
            markdown: item.markdown,
          },
          languageCode: item.item.language.code,
          localizedRepoPath: item.fullPath,
          sourcePage: item.resolvedSourcePage,
        });

        return {
          path: page.path,
          slug: page.slug,
          commitSha: commit.data.sha,
          page: {
            ...page,
            translationStale: false,
            localizationStatus: "current",
          },
        };
      })
    : [];

  return {
    commitSha: commit.data.sha,
    results,
  };
};
