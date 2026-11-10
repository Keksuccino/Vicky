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

/** Blob downloads one language load (or status scan) runs at a time, so interactive requests keep free slots. */
const LANGUAGE_LOAD_CONCURRENCY = 4;
/** A language load that could not complete is not repeated for the same index before this pause. */
const LANGUAGE_LOAD_RETRY_MS = 30_000;
/** Longest time a title refresh waits for a running language load before answering. */
const TITLE_REFRESH_WAIT_MS = 5_000;

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

/** `undetermined`: the translation records no source version and a commit date is unknown. */
export type GitHubLocalizationState = "current" | "outdated" | "undetermined";

export type GitHubLocalizationStatus = GitHubLocalizedFile & {
  state: GitHubLocalizationState;
  /** Unset when the translation's blob could not be read; its state then comes from commit dates. */
  summary?: GitHubBlobSummary;
};

type LanguageLoad = {
  /** Index files the load was started for; once the index changes, a new load may start at once. Weak, so an old index is not kept alive. */
  files: WeakRef<GitHubDocsSourceView["index"]["files"]>;
  /** Translation blobs downloaded so far of those the store lacked; commit dates are looked up after them. */
  progress: { downloaded: number; total: number };
  promise: Promise<void> | null;
  retryAtMs: number;
};

/** A language load that is still running. */
type RunningLanguageLoad = LanguageLoad & { promise: Promise<void> };

/** What the outdated rule needs for a set of translations. */
type LocalizationEvidence = {
  /** Commit metadata of the versions the date rule needs (see `dateRuleVersions`). */
  metadata: Map<string, GitHubCommitMetadata>;
  /** Versions the date rule needs that have no metadata yet. */
  missingVersions: GitHubFileVersion[];
  summaries: Map<string, GitHubBlobSummary>;
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
 * The single "outdated" rule. A translation that records the blob SHA of the source version it
 * was made from is current exactly when that SHA is the source page's current blob SHA. One that
 * records none falls back to commit dates: outdated when the source page was committed after it,
 * undetermined when either date is unknown. Readers serve undetermined translations as current.
 */
export const localizationState = ({
  recordedSourceSha,
  sourceSha,
  sourceUpdatedAt,
  translationUpdatedAt,
}: {
  recordedSourceSha?: string;
  sourceSha: string;
  sourceUpdatedAt?: string;
  translationUpdatedAt?: string;
}): GitHubLocalizationState => {
  if (recordedSourceSha) {
    return recordedSourceSha === sourceSha ? "current" : "outdated";
  }

  const sourceTime = sourceUpdatedAt ? Date.parse(sourceUpdatedAt) : Number.NaN;
  const translationTime = translationUpdatedAt ? Date.parse(translationUpdatedAt) : Number.NaN;
  if (!Number.isFinite(sourceTime) || !Number.isFinite(translationTime)) {
    return "undetermined";
  }
  return sourceTime > translationTime ? "outdated" : "current";
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

/**
 * Versions whose commit dates the date rule needs: translations that record no source version
 * (or whose blob is not known yet), and their source pages that lack "last updated" data.
 */
const dateRuleVersions = (config: GitHubRuntimeConfig, files: GitHubLocalizedFile[], summaries: Map<string, GitHubBlobSummary>): GitHubFileVersion[] => {
  const versions = new Map<string, GitHubFileVersion>();
  for (const file of files) {
    if (summaries.get(file.sha)?.sourceBlobSha) {
      continue;
    }
    versions.set(file.repoPath, { path: file.repoPath, sha: file.sha });
    if (!file.sourcePage.updatedAt) {
      const path = sourceRepoPath(config, file.sourcePage);
      versions.set(path, { path, sha: file.sourcePage.sha });
    }
  }
  return Array.from(versions.values());
};

/** Reads the evidence the store holds, never contacting GitHub. */
const readLocalizationEvidence = async (config: GitHubRuntimeConfig, files: GitHubLocalizedFile[], baseDir: string): Promise<LocalizationEvidence> => {
  const summaries = await loadStoredGitHubBlobSummaries(files.map((file) => file.sha), baseDir);
  const versions = dateRuleVersions(config, files, summaries);
  const metadata = await readStoredGitHubCommitMetadata(config, versions, baseDir);
  return { metadata, missingVersions: versions.filter((version) => !metadata.has(version.path)), summaries };
};

/**
 * Completes the evidence: downloads the blobs the store lacks (bulk priority, a few at a time),
 * then looks up only the commit metadata the date rule still needs, in batched queries. A blob
 * that cannot be downloaded is left out, so its translation is judged by commit dates.
 */
const downloadLocalizationEvidence = async (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  files: GitHubLocalizedFile[],
  baseDir: string,
  onDownloadProgress?: (downloaded: number, total: number) => void,
): Promise<LocalizationEvidence> => {
  const shas = Array.from(new Set(files.map((file) => file.sha)));
  const stored = await loadStoredGitHubBlobSummaries(shas, baseDir);
  const missing = shas.filter((sha) => !stored.has(sha));
  let failed = 0;
  let downloaded = 0;
  let firstError = "";
  if (missing.length > 0) {
    onDownloadProgress?.(0, missing.length);
  }
  await mapWithConcurrency(missing, LANGUAGE_LOAD_CONCURRENCY, async (sha) => {
    try {
      await loadGitHubBlobs(config, [sha], baseDir);
    } catch (error: unknown) {
      failed += 1;
      firstError ||= error instanceof Error ? error.message : String(error);
    }
    downloaded += 1;
    onDownloadProgress?.(downloaded, missing.length);
  });
  assertGitHubCacheAccess(access);
  if (failed > 0) {
    console.warn(`[docs] ${failed} translation${failed === 1 ? "" : "s"} could not be downloaded; judging ${failed === 1 ? "it" : "them"} by commit dates: ${firstError}`);
  }

  const summaries = missing.length > 0 ? await loadStoredGitHubBlobSummaries(shas, baseDir) : stored;
  const versions = dateRuleVersions(config, files, summaries);
  const metadata = await resolveGitHubCommitMetadata(config, access, versions, baseDir);
  return { metadata, missingVersions: versions.filter((version) => !metadata.has(version.path)), summaries };
};

const stateOf = (config: GitHubRuntimeConfig, file: GitHubLocalizedFile, evidence: LocalizationEvidence): GitHubLocalizationState =>
  localizationState({
    recordedSourceSha: evidence.summaries.get(file.sha)?.sourceBlobSha,
    sourceSha: file.sourcePage.sha,
    sourceUpdatedAt: file.sourcePage.updatedAt ?? evidence.metadata.get(sourceRepoPath(config, file.sourcePage))?.updatedAt,
    translationUpdatedAt: evidence.metadata.get(file.repoPath)?.updatedAt,
  });

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
 * blobs and the commit metadata the date rule needs) and returns the running load, or null when
 * none is needed or the last one for the same index could not complete just now. Downloads run
 * at bulk priority with a small concurrency; results are content- or version-addressed, so a
 * load outliving a refresh or save stays valid. The load counts its blob downloads in `progress`.
 */
const ensureLanguageLoad = (
  config: GitHubRuntimeConfig,
  access: GitHubCacheLease,
  view: GitHubDocsSourceView,
  languageRoot: string,
  files: GitHubLocalizedFile[],
  evidence: LocalizationEvidence,
  baseDir: string,
): RunningLanguageLoad | null => {
  const key = `${gitHubRuntimeCacheKey(config)}|localization-load|${languageRoot}`;
  const previous = docsSourceCache.get(key) as LanguageLoad | undefined;
  if (previous?.promise) {
    return previous as RunningLanguageLoad;
  }
  const complete = evidence.missingVersions.length === 0 && files.every((file) => evidence.summaries.has(file.sha));
  if (complete || (previous?.files.deref() === view.index.files && Date.now() < previous.retryAtMs)) {
    return null;
  }

  const load: LanguageLoad = { files: new WeakRef(view.index.files), progress: { downloaded: 0, total: 0 }, promise: null, retryAtMs: 0 };
  const promise = downloadLocalizationEvidence(config, access, files, baseDir, (downloaded, total) => {
    load.progress = { downloaded, total };
  })
    .then(() => undefined)
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
  return load as RunningLanguageLoad;
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
 * otherwise this downloads that one blob, at interactive priority. Commit metadata (shown as
 * "last updated") comes from the store, or one batched lookup for both files.
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
  const outdated =
    localizationState({ recordedSourceSha: record.sourceBlobSha, sourceSha: sourcePage.sha, sourceUpdatedAt: resolvedSourcePage.updatedAt, translationUpdatedAt: page.updatedAt }) === "outdated";

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

  let evidence = await readLocalizationEvidence(config, files, baseDir);
  let load = ensureLanguageLoad(config, access, view, languageRoot, files, evidence, baseDir);
  if (load && waitForPending && (await settlesWithin(load.promise, TITLE_REFRESH_WAIT_MS))) {
    evidence = await readLocalizationEvidence(config, files, baseDir);
    load = null;
  }
  assertGitHubCacheAccess(access);

  const titles = new Map<string, string>();
  for (const file of files) {
    const title = evidence.summaries.get(file.sha)?.title.trim();
    if (title && stateOf(config, file, evidence) !== "outdated") {
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
  const records = await loadGitHubBlobs(config, files.map((file) => file.sha), baseDir, { storedOnly: true });
  const evidence = await readLocalizationEvidence(config, files, baseDir);
  const missingShas = files.filter((file) => !records.has(file.sha)).map((file) => file.sha);
  const load = ensureLanguageLoad(config, access, view, languageRoot, files, evidence, baseDir);
  assertGitHubCacheAccess(access);

  const pages = files.flatMap((file) => {
    const record = records.get(file.sha);
    if (!record || stateOf(config, file, evidence) === "outdated") {
      return [];
    }
    return [createLocalizedDocPage({ languageCode, localizedRepoPath: file.repoPath, metadata: evidence.metadata.get(file.repoPath) ?? {}, record, sourcePage: file.sourcePage })];
  });
  return { complete: !load && missingShas.length === 0, pages };
};

/**
 * Status of every translation the index holds for the given languages and source pages (all
 * pages of the view by default), by language code and then source page path; missing
 * translations are absent. For the translation job and the source-version stamping: blobs the
 * store lacks are downloaded once and kept as summaries, and commit metadata is looked up only
 * for translations that record no source version. Never holds page bodies beyond the store's
 * memory budget.
 */
export const loadGitHubLocalizationStatuses = async ({
  config,
  languageCodes,
  localizationPath,
  onDownloadProgress,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  languageCodes: string[];
  localizationPath: string;
  /** Reports blob downloads (translations the store did not hold yet), first with 0 downloaded. */
  onDownloadProgress?: (downloaded: number, total: number) => void;
  sourcePages?: readonly GitHubDocPage[];
}): Promise<Map<string, Map<string, GitHubLocalizationStatus>>> => {
  const access = beginGitHubCacheAccess(config);
  const view = await loadGitHubDocsSourceView(config);
  const filesByLanguage = languageCodes.map((languageCode) => [languageCode, listLocalizedFiles(view, localizationLanguageRoot(localizationPath, languageCode), sourcePages)] as const);
  const evidence = await downloadLocalizationEvidence(config, access, filesByLanguage.flatMap(([, files]) => files), getGitHubDocsCacheDir(), onDownloadProgress);
  assertGitHubCacheAccess(access);

  return new Map(
    filesByLanguage.map(([languageCode, files]) => [
      languageCode,
      new Map(files.map((file) => [file.sourcePage.path, { ...file, state: stateOf(config, file, evidence), summary: evidence.summaries.get(file.sha) }] as const)),
    ]),
  );
};

export type GitHubLanguageLocalizationOverview = {
  /** Translations whose state the stored evidence decides, by source page path; missing ones are absent. */
  statuses: Map<string, GitHubLocalizationStatus>;
  /** Source page paths whose translation the running language load still has to fetch before its state is known. */
  pendingPaths: Set<string>;
  /** The running language load's blob downloads, or null when none runs. */
  loading: { downloaded: number; total: number } | null;
};

/**
 * Status of every translation of the given languages for the admin overview, from the repository
 * index and the store alone: no page body is read and nothing waits for GitHub. A language whose
 * blobs or commit dates the store lacks gets the same background language load the sidebar
 * starts; until it finished, the translations it fetches are pending and `loading` reports its
 * progress. With a warm index and store this makes no GitHub request.
 */
export const loadGitHubLocalizationOverview = async ({
  config,
  languageCodes,
  localizationPath,
}: {
  config: GitHubRuntimeConfig;
  languageCodes: string[];
  localizationPath: string;
}): Promise<{ languages: Map<string, GitHubLanguageLocalizationOverview>; sourcePages: readonly GitHubDocPage[] }> => {
  const access = beginGitHubCacheAccess(config);
  const baseDir = getGitHubDocsCacheDir();
  const view = await loadGitHubDocsSourceView(config);
  const languages = new Map<string, GitHubLanguageLocalizationOverview>();

  for (const languageCode of languageCodes) {
    const languageRoot = localizationLanguageRoot(localizationPath, languageCode);
    const files = listLocalizedFiles(view, languageRoot);
    const evidence = await readLocalizationEvidence(config, files, baseDir);
    const load = ensureLanguageLoad(config, access, view, languageRoot, files, evidence, baseDir);
    const overview: GitHubLanguageLocalizationOverview = { statuses: new Map(), pendingPaths: new Set(), loading: load ? { ...load.progress } : null };
    for (const file of files) {
      const summary = evidence.summaries.get(file.sha);
      const state = stateOf(config, file, evidence);
      // A running load is fetching exactly what the store lacks: the blob, or the commit dates an
      // unrecorded translation is judged by. Without a load such a translation is decided as the
      // readers decide it (an unreadable blob by commit dates, unknown dates as current).
      if (load && (!summary || state === "undetermined")) {
        overview.pendingPaths.add(file.sourcePage.path);
      } else {
        overview.statuses.set(file.sourcePage.path, { ...file, state, summary });
      }
    }
    languages.set(languageCode, overview);
  }
  assertGitHubCacheAccess(access);

  return { languages, sourcePages: view.pages };
};

/**
 * Current translations of the given languages, by language code and then source page path, with
 * the summaries the store holds. Outdated translations are left out using stored data only.
 * Never contacts GitHub and never reads page bodies into memory.
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
  const filesByLanguage = languageCodes.map((languageCode) => [languageCode, listLocalizedFiles(view, localizationLanguageRoot(localizationPath, languageCode))] as const);
  const evidence = await readLocalizationEvidence(config, filesByLanguage.flatMap(([, files]) => files), getGitHubDocsCacheDir());

  return new Map(
    filesByLanguage.map(([languageCode, files]) => [
      languageCode,
      new Map(
        files
          .filter((file) => stateOf(config, file, evidence) !== "outdated")
          .map((file) => [file.sourcePage.path, { ...file, summary: evidence.summaries.get(file.sha) }] as const),
      ),
    ]),
  );
};
