import { docsSourceCache } from "@/lib/cache";
import { assertGitHubCacheAccess, beginGitHubCacheAccess, type GitHubCacheLease } from "@/lib/github-cache-invalidation";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import {
  readStoredGitHubCommitMetadata,
  resolveGitHubCommitMetadata,
  type GitHubCommitMetadata,
  type GitHubFileVersion,
} from "@/lib/github-commit-metadata";
import { loadGitHubBlobs, loadStoredGitHubBlobSummaries, type GitHubBlobRecord, type GitHubBlobSummary } from "@/lib/github-content-store";
import { getGitHubDocsCacheDir } from "@/lib/github-docs-cache-files";
import { createGitHubDocPage, loadGitHubDocsSourceView, type GitHubDocsSourceView } from "@/lib/github-docs-source";
import { joinRepoPath, normalizeDocsPath, normalizeLocalizationLanguageCode, normalizeLocalizationRoot } from "@/lib/github-paths";
import { ApiError } from "@/lib/http";
import type { AutoTranslateLanguage, GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

/**
 * Localization readers. Translations live at `<localizationPath>/<language>/<source page path>`;
 * the repository index behind the source docs view lists them with their blob SHAs, so every
 * reader works from that index, the content store, and the commit metadata store, and none makes
 * a tree request of its own. Only translations of pages in the view are read.
 *
 * Bodies are never held per language: a reader loads the blobs it needs from the store and lets
 * them go. A language's missing blobs and commit metadata are downloaded lazily, in the
 * background, the first time a list of that language (sidebar titles, search) needs them.
 */

/** Blob downloads one language load runs at a time, so interactive requests keep free slots. */
const LANGUAGE_LOAD_CONCURRENCY = 4;
/** A language load that could not complete is not repeated for the same index before this pause. */
const LANGUAGE_LOAD_RETRY_MS = 30_000;
/** Longest time a title refresh waits for a running language load before answering. */
const TITLE_REFRESH_WAIT_MS = 5_000;

export type GitHubLocalizationPageStatus = {
  path: string;
  slug: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type GitHubLocalizedDocResult = {
  sourcePage: GitHubDocPage;
  page: GitHubDocPage | null;
  status: "current" | "outdated" | "missing";
  localizedRepoPath: string;
};

/** A translation of a source page, as the repository index lists it. */
export type GitHubLocalizedFile = {
  repoPath: string;
  sha: string;
  sourcePage: GitHubDocPage;
};

export type GitHubCurrentLocalization = GitHubLocalizedFile & {
  /** Unset while the blob is not in the store. */
  summary?: GitHubBlobSummary;
};

type LanguageLoad = {
  /** Index files the load was started for; once the index changes, a new load may start at once. Weak, so an old index is not kept alive. */
  files: WeakRef<GitHubDocsSourceView["index"]["files"]>;
  promise: Promise<void> | null;
  retryAtMs: number;
};

type KnownLocalizationMetadata = {
  /** Stored commit metadata of the translations and of source pages without "last updated" data. */
  known: Map<string, GitHubCommitMetadata>;
  missing: GitHubFileVersion[];
};

export const mapWithConcurrency = async <T, R>(values: T[], concurrency: number, iteratee: (value: T, index: number) => Promise<R>): Promise<R[]> => {
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

export const localizationLanguageRoot = (localizationPath: string, languageCode: string): string =>
  joinRepoPath(normalizeLocalizationRoot(localizationPath), normalizeLocalizationLanguageCode(languageCode));

/**
 * The single "outdated" rule: a translation is outdated when its source page was committed after
 * it. Both dates come from the commit metadata store; when either is unknown, it counts as current.
 */
export const isLocalizationOutdated = (sourceUpdatedAt: string | undefined, translationUpdatedAt: string | undefined): boolean => {
  const sourceTime = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : Number.NaN;
  const translationTime = translationUpdatedAt ? Date.parse(translationUpdatedAt) : Number.NaN;

  return Number.isFinite(sourceTime) && Number.isFinite(translationTime) && sourceTime > translationTime;
};

/** Lists the translations the index holds for the given source pages (all pages of the view by default). */
const listLocalizedFiles = (view: GitHubDocsSourceView, languageRoot: string, sourcePages: readonly GitHubDocPage[] = view.pages): GitHubLocalizedFile[] => {
  const files: GitHubLocalizedFile[] = [];
  for (const sourcePage of sourcePages) {
    const repoPath = joinRepoPath(languageRoot, sourcePage.path);
    const file = view.index.files.get(repoPath);
    if (file) {
      files.push({ repoPath, sha: file.sha, sourcePage });
    }
  }
  return files;
};

const sourceRepoPath = (config: GitHubRuntimeConfig, page: Pick<GitHubDocPage, "path">): string => joinRepoPath(normalizeDocsPath(config.docsPath), page.path);

const readKnownLocalizationMetadata = async (config: GitHubRuntimeConfig, files: GitHubLocalizedFile[], baseDir: string): Promise<KnownLocalizationMetadata> => {
  const versions = new Map<string, GitHubFileVersion>();
  for (const file of files) {
    versions.set(file.repoPath, { path: file.repoPath, sha: file.sha });
    if (!file.sourcePage.updatedAt) {
      const path = sourceRepoPath(config, file.sourcePage);
      versions.set(path, { path, sha: file.sourcePage.sha });
    }
  }

  const known = await readStoredGitHubCommitMetadata(config, versions.values(), baseDir);
  return { known, missing: Array.from(versions.values()).filter((version) => !known.has(version.path)) };
};

const isCurrentLocalization = (config: GitHubRuntimeConfig, file: GitHubLocalizedFile, known: Map<string, GitHubCommitMetadata>): boolean =>
  !isLocalizationOutdated(file.sourcePage.updatedAt ?? known.get(sourceRepoPath(config, file.sourcePage))?.updatedAt, known.get(file.repoPath)?.updatedAt);

export const createLocalizedDocPage = ({
  languageCode,
  localizedRepoPath,
  metadata,
  record,
  sourcePage,
}: {
  languageCode: string;
  localizedRepoPath: string;
  metadata: GitHubCommitMetadata;
  record: GitHubBlobRecord;
  sourcePage: Pick<GitHubDocPage, "path" | "slug" | "updatedAt">;
}): GitHubDocPage => {
  const page = createGitHubDocPage(sourcePage, record, metadata);

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

const isStaleSourceError = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

/**
 * Starts the background download of what the store lacks to list one language (its translation
 * blobs and the commit metadata needed for the outdated rule) and returns the running load, or
 * null when none is needed or the last one for the same index could not complete just now.
 * Downloads run at bulk priority with a small concurrency; results are content- or
 * version-addressed, so a load outliving a refresh or save stays valid.
 */
const ensureLanguageLoad = (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  view: GitHubDocsSourceView,
  languageRoot: string,
  missing: { shas: string[]; versions: GitHubFileVersion[] },
  baseDir: string,
): Promise<void> | null => {
  const key = `${gitHubRuntimeCacheKey(config)}|localization-load|${languageRoot}`;
  const previous = docsSourceCache.get(key) as LanguageLoad | undefined;
  if (previous?.promise) {
    return previous.promise;
  }
  if ((missing.shas.length === 0 && missing.versions.length === 0) || (previous?.files.deref() === view.index.files && Date.now() < previous.retryAtMs)) {
    return null;
  }

  const load: LanguageLoad = { files: new WeakRef(view.index.files), promise: null, retryAtMs: 0 };
  const promise = (async () => {
    await mapWithConcurrency(missing.shas, LANGUAGE_LOAD_CONCURRENCY, (sha) => loadGitHubBlobs(config, [sha], baseDir));
    assertGitHubCacheAccess(access);
    await resolveGitHubCommitMetadata(config, access, missing.versions, baseDir);
  })()
    .catch((error: unknown) => {
      if (!isStaleSourceError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[docs] Failed to load the translations in ${languageRoot}; serving source pages for them meanwhile: ${message}`);
      }
    })
    .finally(() => {
      load.retryAtMs = Date.now() + LANGUAGE_LOAD_RETRY_MS;
      load.promise = null;
    });
  load.promise = promise;
  docsSourceCache.set(key, load);
  return promise;
};

/** Resolves to whether the promise settled within `ms`. */
const settlesWithin = (promise: Promise<void>, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/**
 * Loads one translated page for a source page of the published view. Never makes an index
 * request: a translation the index does not list is missing. A stored blob costs no request;
 * otherwise this downloads that one blob, at interactive priority. Commit metadata comes from
 * the store, or one batched lookup for both files.
 */
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
  const view = await loadGitHubDocsSourceView(config);
  const localizedRepoPath = joinRepoPath(localizationLanguageRoot(localizationPath, language.code), sourcePage.path);
  const file = view.index.files.get(localizedRepoPath);
  const sourcePath = sourceRepoPath(config, sourcePage);
  const versions: GitHubFileVersion[] = [...(file ? [{ path: localizedRepoPath, sha: file.sha }] : []), ...(sourcePage.updatedAt ? [] : [{ path: sourcePath, sha: sourcePage.sha }])];

  const [records, metadata] = await Promise.all([
    file ? loadGitHubBlobs(config, [file.sha], getGitHubDocsCacheDir(), { priority: "interactive" }) : null,
    versions.length > 0 ? resolveGitHubCommitMetadata(config, access, versions) : null,
  ]);
  assertGitHubCacheAccess(access);

  const sourceMetadata = metadata?.get(sourcePath);
  const resolvedSourcePage = sourceMetadata?.updatedAt ? { ...sourcePage, updatedAt: sourceMetadata.updatedAt, updatedBy: sourceMetadata.updatedBy } : sourcePage;
  const record = file ? records?.get(file.sha) : undefined;
  if (!record) {
    return { sourcePage: resolvedSourcePage, page: null, status: "missing", localizedRepoPath };
  }

  const page = createLocalizedDocPage({
    languageCode: language.code,
    localizedRepoPath,
    metadata: metadata?.get(localizedRepoPath) ?? {},
    record,
    sourcePage: resolvedSourcePage,
  });
  const outdated = isLocalizationOutdated(resolvedSourcePage.updatedAt, page.updatedAt);

  return {
    sourcePage: resolvedSourcePage,
    page: { ...page, translationStale: outdated, localizationStatus: outdated ? "outdated" : "current" },
    status: outdated ? "outdated" : "current",
    localizedRepoPath,
  };
};

/**
 * Translated titles of a language's current translations, by source page slug, for the sidebar.
 * Built from blob summaries, never from page bodies. Titles the store cannot provide yet start a
 * background language load and are reported as pending; `waitForPending` waits a bounded time
 * for that load (title refreshes), the first answer never waits.
 */
export const loadGitHubLocalizedTitles = async ({
  config,
  languageCode,
  localizationPath,
  waitForPending,
}: {
  config: GitHubRuntimeConfig;
  languageCode: string;
  localizationPath: string;
  waitForPending?: boolean;
}): Promise<{ pending: boolean; titles: Map<string, string> }> => {
  const access = beginGitHubCacheAccess(config);
  const baseDir = getGitHubDocsCacheDir();
  const view = await loadGitHubDocsSourceView(config);
  const languageRoot = localizationLanguageRoot(localizationPath, languageCode);
  const files = listLocalizedFiles(view, languageRoot);
  const read = () => Promise.all([loadStoredGitHubBlobSummaries(files.map((file) => file.sha), baseDir), readKnownLocalizationMetadata(config, files, baseDir)]);

  let [summaries, metadata] = await read();
  let load = ensureLanguageLoad(config, access, view, languageRoot, { shas: files.filter((file) => !summaries.has(file.sha)).map((file) => file.sha), versions: metadata.missing }, baseDir);
  if (load && waitForPending && (await settlesWithin(load, TITLE_REFRESH_WAIT_MS))) {
    [summaries, metadata] = await read();
    load = null;
  }
  assertGitHubCacheAccess(access);

  const titles = new Map<string, string>();
  for (const file of files) {
    const title = summaries.get(file.sha)?.title.trim();
    if (title && isCurrentLocalization(config, file, metadata.known)) {
      titles.set(file.sourcePage.slug, title);
    }
  }
  return { pending: Boolean(load), titles };
};

/**
 * Current translated pages of a language that the store holds, for search. `complete` is false
 * while blobs are still missing (a background language load then fetches them), so callers can
 * avoid caching a partial result. The pages reference stored blobs and are meant to be dropped
 * after use.
 */
export const loadGitHubLocalizedPages = async ({
  config,
  languageCode,
  localizationPath,
}: {
  config: GitHubRuntimeConfig;
  languageCode: string;
  localizationPath: string;
}): Promise<{ complete: boolean; pages: GitHubDocPage[] }> => {
  const access = beginGitHubCacheAccess(config);
  const baseDir = getGitHubDocsCacheDir();
  const view = await loadGitHubDocsSourceView(config);
  const languageRoot = localizationLanguageRoot(localizationPath, languageCode);
  const files = listLocalizedFiles(view, languageRoot);
  const [records, metadata] = await Promise.all([
    loadGitHubBlobs(config, files.map((file) => file.sha), baseDir, { storedOnly: true }),
    readKnownLocalizationMetadata(config, files, baseDir),
  ]);
  const missingShas = files.filter((file) => !records.has(file.sha)).map((file) => file.sha);
  const load = ensureLanguageLoad(config, access, view, languageRoot, { shas: missingShas, versions: metadata.missing }, baseDir);
  assertGitHubCacheAccess(access);

  const pages = files.flatMap((file) => {
    const record = records.get(file.sha);
    if (!record || !isCurrentLocalization(config, file, metadata.known)) {
      return [];
    }
    return [createLocalizedDocPage({ languageCode, localizedRepoPath: file.repoPath, metadata: metadata.known.get(file.repoPath) ?? {}, record, sourcePage: file.sourcePage })];
  });
  return { complete: !load && missingShas.length === 0, pages };
};

/**
 * "Last updated" data of a language's translations, by source page path, for the translation
 * job's status. Needs only the index and the commit metadata store; versions without stored
 * metadata are looked up in batched queries.
 */
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
  const view = await loadGitHubDocsSourceView(config);
  const files = listLocalizedFiles(view, localizationLanguageRoot(localizationPath, language.code), sourcePages);
  const metadata = await resolveGitHubCommitMetadata(config, access, files.map((file) => ({ path: file.repoPath, sha: file.sha })));
  assertGitHubCacheAccess(access);

  return new Map(
    files.map((file) => {
      const fileMetadata = metadata.get(file.repoPath);
      return [file.sourcePage.path, { path: file.sourcePage.path, slug: file.sourcePage.slug, updatedAt: fileMetadata?.updatedAt, updatedBy: fileMetadata?.updatedBy }];
    }),
  );
};

/**
 * Current translations of the given languages, by language code and then source page path, with
 * the summaries the store holds. Outdated translations are left out using stored commit
 * metadata only. Never contacts GitHub and never reads page bodies into memory.
 */
export const listCurrentGitHubLocalizations = async ({
  config,
  languageCodes,
  localizationPath,
  view,
}: {
  config: GitHubRuntimeConfig;
  languageCodes: string[];
  localizationPath: string;
  view: GitHubDocsSourceView;
}): Promise<Map<string, Map<string, GitHubCurrentLocalization>>> => {
  const baseDir = getGitHubDocsCacheDir();
  const filesByLanguage = languageCodes.map((languageCode) => [languageCode, listLocalizedFiles(view, localizationLanguageRoot(localizationPath, languageCode))] as const);
  const allFiles = filesByLanguage.flatMap(([, files]) => files);
  const [summaries, metadata] = await Promise.all([
    loadStoredGitHubBlobSummaries(allFiles.map((file) => file.sha), baseDir),
    readKnownLocalizationMetadata(config, allFiles, baseDir),
  ]);

  return new Map(
    filesByLanguage.map(([languageCode, files]) => [
      languageCode,
      new Map(
        files
          .filter((file) => isCurrentLocalization(config, file, metadata.known))
          .map((file) => [file.sourcePage.path, { ...file, summary: summaries.get(file.sha) }] as const),
      ),
    ]),
  );
};
