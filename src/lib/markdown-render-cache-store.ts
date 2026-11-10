import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { MARKDOWN_RENDER_VERSION } from "@/lib/markdown-rendering-shared";
import { processSingleton } from "@/lib/process-singleton.mjs";
import { ensurePrivateDirectory, ensurePrivateFile, secureAtomicWriteFile } from "@/lib/runtime-file-security.mjs";
import type { MarkdownHeading } from "@/lib/types";

/**
 * Persistent cache of rendered Markdown HTML, one file per page variant, under
 * `WIKI_MARKDOWN_CACHE_DIR`:
 *
 * - `pages/<sha256 of the key>.json`: one entry (key, renderer version, HTML, headings).
 * - `index.json`: key, HTML size, heading count, and save time of every entry, so listing,
 *   existence checks, and deletion never open an entry. Writes and deletes keep the index in
 *   memory and persist it at most every few seconds. The first use in a process reconciles the
 *   persisted index with a listing of `pages/`: entries whose file is gone are dropped, and only
 *   files the index does not know are read (a few at a time, yielding to the event loop). A
 *   missing, stale, or corrupt index, or a directory that never had one, is rebuilt that way.
 * - `metadata.json`: the last mutation, shown on the admin card.
 *
 * Public reads open only the entry they serve and never wait for the index.
 */

const MARKDOWN_RENDER_CACHE_ENTRY_VERSION = 1;
const MARKDOWN_RENDER_CACHE_METADATA_VERSION = 1;
const MARKDOWN_RENDER_CACHE_INDEX_VERSION = 1;
const DEFAULT_MARKDOWN_RENDER_CACHE_DIR = path.join(process.cwd(), "data", "markdown-cache");
/** Longest time an index change waits to be persisted; changes in between share one write. */
const INDEX_PERSIST_DELAY_MS = 5_000;
/** Entry files an index rebuild reads at a time. */
const INDEX_REBUILD_CONCURRENCY = 4;
const ENTRY_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
/** Temporary files of `secureAtomicWriteFile` beside an entry: `<entry>.<pid>.<time>.<uuid>.tmp`. */
const ENTRY_TEMP_FILE_PATTERN = /^[a-f0-9]{64}\.json\.(\d+)\.\d+\.[0-9a-f-]{36}\.tmp$/;

export type PersistedRenderedMarkdown = {
  html: string;
  headings: MarkdownHeading[];
};

type PersistedRenderedMarkdownEntry = {
  version: typeof MARKDOWN_RENDER_CACHE_ENTRY_VERSION;
  kind: "rendered-markdown";
  key: string;
  rendererVersion: typeof MARKDOWN_RENDER_VERSION;
  savedAt: string;
  html: string;
  headings: MarkdownHeading[];
};

type PersistedRenderedMarkdownCacheMetadata = {
  version: typeof MARKDOWN_RENDER_CACHE_METADATA_VERSION;
  kind: "rendered-markdown-cache-metadata";
  lastMutation: RenderedMarkdownCacheMutation | null;
};

/** `entries` holds `[key, htmlBytes, headingCount, savedAt]`; file names are derived from the keys. */
type PersistedRenderedMarkdownCacheIndex = {
  version: typeof MARKDOWN_RENDER_CACHE_INDEX_VERSION;
  kind: "rendered-markdown-index";
  entries: Array<[string, number, number, string]>;
};

export type RenderedMarkdownCacheEntryMetadata = {
  headingCount: number;
  htmlBytes: number;
  key: string;
  savedAt: string;
};

export type RenderedMarkdownCacheMutation = {
  at: string;
  deletedEntries: number;
  reason: string;
  scope: "all" | "page" | "pages";
  target?: string;
};

type RenderedMarkdownCacheMutationState = {
  cacheDir: string;
  lastMutation: RenderedMarkdownCacheMutation | null;
};

type RenderedMarkdownCacheIndex = {
  cacheDir: string;
  /** Entries by file name; complete once `loaded` is set. */
  entries: Map<string, RenderedMarkdownCacheEntryMetadata>;
  loaded: boolean;
  ready: Promise<void>;
  persist: { dirty: boolean; running: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null };
};

const cacheMutationState = processSingleton("markdownRender.cacheMutationState", (): RenderedMarkdownCacheMutationState => ({
  cacheDir: "",
  lastMutation: null,
}));

// Resolved on every access instead of once at module load, so removing the registration (as
// tests do to simulate a restart) starts from the persisted index again.
const getIndexState = (): { current: RenderedMarkdownCacheIndex | null } =>
  processSingleton("markdownRender.cacheIndex", () => ({ current: null as RenderedMarkdownCacheIndex | null }));

const getMarkdownRenderCacheDir = (): string =>
  process.env.WIKI_MARKDOWN_CACHE_DIR?.trim() || DEFAULT_MARKDOWN_RENDER_CACHE_DIR;

export const getPersistentRenderedMarkdownCacheDir = (): string => getMarkdownRenderCacheDir();

const hashCacheKey = (key: string): string => createHash("sha256").update(key).digest("hex");

const entryFileName = (key: string): string => `${hashCacheKey(key)}.json`;

// Cache entries are mutable runtime files, not build inputs. The directory can also be configured outside the project.
const cachePagesDir = (cacheDir: string): string => path.join(/*turbopackIgnore: true*/ cacheDir, "pages");

const cacheMetadataFilePath = (): string => path.join(/*turbopackIgnore: true*/ getMarkdownRenderCacheDir(), "metadata.json");

const cacheIndexFilePath = (cacheDir: string): string => path.join(/*turbopackIgnore: true*/ cacheDir, "index.json");

const cacheFilePath = (key: string): string => path.join(/*turbopackIgnore: true*/ cachePagesDir(getMarkdownRenderCacheDir()), entryFileName(key));

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const warnCacheFailure = (action: string, key: string, error: unknown): void => {
  console.warn(`[markdown] Failed to ${action} persistent rendered markdown cache entry ${hashCacheKey(key)}: ${errorMessage(error)}`);
};

const warnCacheFileFailure = (action: string, fileName: string, error: unknown): void => {
  console.warn(`[markdown] Failed to ${action} persistent rendered markdown cache file ${fileName}: ${errorMessage(error)}`);
};

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const normalizeHeading = (value: unknown): MarkdownHeading | null => {
  const source = asRecord(value);
  if (!source) {
    return null;
  }

  const depth = source.depth;
  const text = asString(source.text);
  const slug = asString(source.slug);

  if (typeof depth !== "number" || !Number.isFinite(depth) || !text || !slug) {
    return null;
  }

  return {
    depth: Math.max(1, Math.min(6, Math.floor(depth))),
    text,
    slug,
  };
};

const normalizeHeadings = (value: unknown): MarkdownHeading[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const headings: MarkdownHeading[] = [];
  for (const entry of value) {
    const heading = normalizeHeading(entry);
    if (!heading) {
      return null;
    }

    headings.push(heading);
  }

  return headings;
};

const normalizePersistedRenderedMarkdown = (value: unknown, key: string): PersistedRenderedMarkdown | null => {
  const source = asRecord(value);
  if (
    !source ||
    source.version !== MARKDOWN_RENDER_CACHE_ENTRY_VERSION ||
    source.kind !== "rendered-markdown" ||
    source.key !== key ||
    source.rendererVersion !== MARKDOWN_RENDER_VERSION
  ) {
    return null;
  }

  const html = asString(source.html);
  const headings = normalizeHeadings(source.headings);
  if (html === null || !headings) {
    return null;
  }

  return {
    html,
    headings,
  };
};

/** What the index keeps of an entry file; `null` for a file that is not an entry stored under its name. */
const normalizePersistedEntryMetadata = (value: unknown, fileName: string): RenderedMarkdownCacheEntryMetadata | null => {
  const source = asRecord(value);
  if (!source || source.version !== MARKDOWN_RENDER_CACHE_ENTRY_VERSION || source.kind !== "rendered-markdown") {
    return null;
  }

  const key = asString(source.key);
  const savedAt = asString(source.savedAt);
  const html = asString(source.html);
  if (!key || !savedAt || html === null || !Array.isArray(source.headings) || entryFileName(key) !== fileName) {
    return null;
  }

  return { headingCount: source.headings.length, htmlBytes: Buffer.byteLength(html, "utf8"), key, savedAt };
};

const normalizeRenderedMarkdownCacheMutation = (value: unknown): RenderedMarkdownCacheMutation | null => {
  const source = asRecord(value);
  if (!source) {
    return null;
  }

  const at = asString(source.at);
  const reason = asString(source.reason);
  const scope = asString(source.scope);
  const deletedEntries = source.deletedEntries;
  const target = asString(source.target);

  if (
    !at ||
    Number.isNaN(Date.parse(at)) ||
    !reason ||
    (scope !== "all" && scope !== "page" && scope !== "pages") ||
    typeof deletedEntries !== "number" ||
    !Number.isFinite(deletedEntries)
  ) {
    return null;
  }

  return {
    at,
    deletedEntries: Math.max(0, Math.floor(deletedEntries)),
    reason,
    scope,
    ...(target ? { target } : {}),
  };
};

const readRenderedMarkdownCacheMetadata = async (): Promise<PersistedRenderedMarkdownCacheMetadata | null> => {
  try {
    const filePath = cacheMetadataFilePath();
    await ensurePrivateDirectory(getMarkdownRenderCacheDir());
    await ensurePrivateFile(filePath);
    const source = asRecord(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    if (
      !source ||
      source.version !== MARKDOWN_RENDER_CACHE_METADATA_VERSION ||
      source.kind !== "rendered-markdown-cache-metadata"
    ) {
      return null;
    }

    return {
      version: MARKDOWN_RENDER_CACHE_METADATA_VERSION,
      kind: "rendered-markdown-cache-metadata",
      lastMutation: normalizeRenderedMarkdownCacheMutation(source.lastMutation),
    };
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFileFailure("read metadata from", "metadata.json", error);
    }

    return null;
  }
};

export const recordRenderedMarkdownCacheMutation = async (
  mutation: Omit<RenderedMarkdownCacheMutation, "at">,
): Promise<RenderedMarkdownCacheMutation> => {
  const recorded = {
    ...mutation,
    at: new Date().toISOString(),
  };
  cacheMutationState.cacheDir = getMarkdownRenderCacheDir();
  cacheMutationState.lastMutation = recorded;

  try {
    await ensurePrivateDirectory(getMarkdownRenderCacheDir());
    await secureAtomicWriteFile(
      cacheMetadataFilePath(),
      JSON.stringify({
        version: MARKDOWN_RENDER_CACHE_METADATA_VERSION,
        kind: "rendered-markdown-cache-metadata",
        lastMutation: recorded,
      } satisfies PersistedRenderedMarkdownCacheMetadata),
      "utf8",
    );
  } catch (error: unknown) {
    warnCacheFileFailure("write metadata to", "metadata.json", error);
  }

  return recorded;
};

export const getRenderedMarkdownCacheLastMutation = async (): Promise<RenderedMarkdownCacheMutation | null> => {
  const cacheDir = getMarkdownRenderCacheDir();
  if (cacheMutationState.cacheDir === cacheDir && cacheMutationState.lastMutation) {
    return cacheMutationState.lastMutation;
  }

  const metadata = await readRenderedMarkdownCacheMetadata();
  cacheMutationState.cacheDir = cacheDir;
  cacheMutationState.lastMutation = metadata?.lastMutation ?? null;
  return cacheMutationState.lastMutation;
};

/** Persisted index entries by file name; empty when the index is missing, unreadable, or of another version. */
const readPersistedIndex = async (cacheDir: string): Promise<Map<string, RenderedMarkdownCacheEntryMetadata>> => {
  const entries = new Map<string, RenderedMarkdownCacheEntryMetadata>();
  try {
    const filePath = cacheIndexFilePath(cacheDir);
    await ensurePrivateFile(filePath);
    const source = asRecord(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    if (!source || source.version !== MARKDOWN_RENDER_CACHE_INDEX_VERSION || source.kind !== "rendered-markdown-index" || !Array.isArray(source.entries)) {
      return entries;
    }

    for (const entry of source.entries as unknown[]) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0] && isCount(entry[1]) && isCount(entry[2]) && typeof entry[3] === "string") {
        entries.set(entryFileName(entry[0]), { headingCount: entry[2], htmlBytes: entry[1], key: entry[0], savedAt: entry[3] });
      }
    }
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFileFailure("read the index from", "index.json", error);
    }
  }
  return entries;
};

/** File names in `pages/`, or `null` when the directory does not exist. */
const listEntryDirectory = async (cacheDir: string): Promise<string[] | null> => {
  const pagesDir = cachePagesDir(cacheDir);
  try {
    await ensurePrivateDirectory(cacheDir);
    const fileNames = await readdir(pagesDir);
    await ensurePrivateDirectory(pagesDir);
    return fileNames;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    warnCacheFileFailure("list", "pages", error);
    return [];
  }
};

/** Reads one entry file for the index. A file that is not a valid entry is deleted: it could never be served. */
const readEntryMetadataForIndex = async (cacheDir: string, fileName: string): Promise<RenderedMarkdownCacheEntryMetadata | null> => {
  const filePath = path.join(/*turbopackIgnore: true*/ cachePagesDir(cacheDir), fileName);
  let raw: string;
  try {
    await ensurePrivateFile(filePath);
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFileFailure("read", fileName, error);
    }
    return null;
  }

  let entry: RenderedMarkdownCacheEntryMetadata | null = null;
  try {
    entry = normalizePersistedEntryMetadata(JSON.parse(raw) as unknown, fileName);
  } catch {
    entry = null;
  }
  if (!entry) {
    await unlink(filePath).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        warnCacheFileFailure("delete", fileName, error);
      }
    });
  }
  return entry;
};

/** Removes temporary files of atomic writes another process left behind (one process owns the runtime directory). */
const removeAbandonedTempFile = async (cacheDir: string, fileName: string): Promise<void> => {
  const pid = ENTRY_TEMP_FILE_PATTERN.exec(fileName)?.[1];
  if (pid && Number(pid) !== process.pid) {
    await unlink(path.join(/*turbopackIgnore: true*/ cachePagesDir(cacheDir), fileName)).catch(() => undefined);
  }
};

const writeIndexFile = async (index: RenderedMarkdownCacheIndex): Promise<void> => {
  // A directory that no longer exists has nothing to index, and must not be recreated for it.
  if (getIndexState().current !== index || !(await stat(cachePagesDir(index.cacheDir)).then(() => true, () => false))) {
    return;
  }

  const persisted: PersistedRenderedMarkdownCacheIndex = {
    version: MARKDOWN_RENDER_CACHE_INDEX_VERSION,
    kind: "rendered-markdown-index",
    entries: Array.from(index.entries.values(), (entry) => [entry.key, entry.htmlBytes, entry.headingCount, entry.savedAt]),
  };
  try {
    await secureAtomicWriteFile(cacheIndexFilePath(index.cacheDir), JSON.stringify(persisted), "utf8");
  } catch (error: unknown) {
    warnCacheFileFailure("write the index to", "index.json", error);
  }
};

/** Writes the index now; changes made meanwhile are persisted by another write after it. */
const startIndexWrite = (index: RenderedMarkdownCacheIndex): Promise<void> => {
  index.persist.dirty = false;
  const running = writeIndexFile(index).finally(() => {
    index.persist.running = null;
    if (index.persist.dirty) {
      scheduleIndexPersist(index);
    }
  });
  index.persist.running = running;
  return running;
};

/** Persists the index once after a burst of changes; one write at a time. */
const scheduleIndexPersist = (index: RenderedMarkdownCacheIndex): void => {
  index.persist.dirty = true;
  if (index.persist.timer || index.persist.running) {
    return;
  }

  index.persist.timer = setTimeout(() => {
    index.persist.timer = null;
    void startIndexWrite(index);
  }, INDEX_PERSIST_DELAY_MS);
  // A pending index write must not keep an otherwise idle process alive; the next start reconciles.
  index.persist.timer.unref?.();
};

/** Persists pending index changes now instead of after the delay, for example once a bulk operation finished. */
export const flushRenderedMarkdownCacheIndex = async (): Promise<void> => {
  const index = getIndexState().current;
  if (!index) {
    return;
  }

  await index.ready;
  await index.persist.running;
  if (index.persist.timer) {
    clearTimeout(index.persist.timer);
    index.persist.timer = null;
  }
  if (index.persist.dirty && !index.persist.running) {
    await startIndexWrite(index);
  }
};

/** Builds the in-memory index from the persisted one and a listing of the entry directory (see the module comment). */
const loadIndex = async (index: RenderedMarkdownCacheIndex): Promise<void> => {
  const [persisted, fileNames] = await Promise.all([readPersistedIndex(index.cacheDir), listEntryDirectory(index.cacheDir)]);
  const onDisk = new Set<string>();
  const unknownFiles: string[] = [];
  for (const fileName of fileNames ?? []) {
    if (ENTRY_FILE_PATTERN.test(fileName)) {
      onDisk.add(fileName);
      if (!persisted.has(fileName)) {
        unknownFiles.push(fileName);
      }
    } else {
      await removeAbandonedTempFile(index.cacheDir, fileName);
    }
  }

  let changed = unknownFiles.length > 0;
  for (const [fileName, entry] of persisted) {
    if (onDisk.has(fileName)) {
      index.entries.set(fileName, entry);
    } else {
      changed = true;
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(INDEX_REBUILD_CONCURRENCY, unknownFiles.length) }, async () => {
      while (next < unknownFiles.length) {
        const fileName = unknownFiles[next];
        next += 1;
        // Parsing an entry is synchronous; yielding keeps a rebuild of many files from blocking requests.
        await yieldToEventLoop();
        const entry = await readEntryMetadataForIndex(index.cacheDir, fileName);
        if (entry) {
          index.entries.set(fileName, entry);
        }
      }
    }),
  );

  if (changed) {
    scheduleIndexPersist(index);
  }
};

/** The index of the current cache directory, loading it on first use. */
const getIndex = (): RenderedMarkdownCacheIndex => {
  const state = getIndexState();
  const cacheDir = getMarkdownRenderCacheDir();
  if (state.current?.cacheDir === cacheDir) {
    return state.current;
  }

  if (state.current?.persist.timer) {
    clearTimeout(state.current.persist.timer);
  }
  const index: RenderedMarkdownCacheIndex = {
    cacheDir,
    entries: new Map(),
    loaded: false,
    ready: Promise.resolve(),
    persist: { dirty: false, running: null, timer: null },
  };
  index.ready = loadIndex(index)
    .catch((error: unknown) => {
      // Unreadable files stay out of the index; the next start reconciles again.
      warnCacheFileFailure("load the index of", "pages", error);
    })
    .finally(() => {
      index.loaded = true;
    });
  state.current = index;
  return index;
};

const loadedIndex = async (): Promise<RenderedMarkdownCacheIndex> => {
  const index = getIndex();
  await index.ready;
  return index;
};

/**
 * Applies a change to the index: at once when it is loaded, otherwise once loading finished, in
 * call order. Writers never wait for a rebuild.
 */
const updateIndex = (change: (index: RenderedMarkdownCacheIndex) => void): void => {
  const index = getIndex();
  if (index.loaded) {
    change(index);
    return;
  }

  void index.ready.then(() => {
    if (getIndexState().current === index) {
      change(index);
    }
  });
};

/** Drops the index entry of a file a read found missing, if the index is loaded already. */
const forgetMissingEntry = (key: string): void => {
  const index = getIndexState().current;
  if (index?.loaded && index.cacheDir === getMarkdownRenderCacheDir() && index.entries.delete(entryFileName(key))) {
    scheduleIndexPersist(index);
  }
};

export const readPersistentRenderedMarkdown = async (key: string): Promise<PersistedRenderedMarkdown | null> => {
  try {
    const filePath = cacheFilePath(key);
    await ensurePrivateDirectory(getMarkdownRenderCacheDir());
    await ensurePrivateFile(filePath);
    return normalizePersistedRenderedMarkdown(JSON.parse(await readFile(filePath, "utf8")) as unknown, key);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      forgetMissingEntry(key);
    } else {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

/** Whether an entry is stored under the key, from the index alone. */
export const hasPersistentRenderedMarkdown = async (key: string): Promise<boolean> => (await loadedIndex()).entries.has(entryFileName(key));

export const writePersistentRenderedMarkdown = async (
  key: string,
  rendered: PersistedRenderedMarkdown,
): Promise<boolean> => {
  const entry: PersistedRenderedMarkdownEntry = {
    version: MARKDOWN_RENDER_CACHE_ENTRY_VERSION,
    kind: "rendered-markdown",
    key,
    rendererVersion: MARKDOWN_RENDER_VERSION,
    savedAt: new Date().toISOString(),
    html: rendered.html,
    headings: rendered.headings,
  };

  try {
    await ensurePrivateDirectory(getMarkdownRenderCacheDir());
    await secureAtomicWriteFile(cacheFilePath(key), JSON.stringify(entry), "utf8");
  } catch (error: unknown) {
    warnCacheFailure("write", key, error);
    return false;
  }

  const metadata: RenderedMarkdownCacheEntryMetadata = { headingCount: entry.headings.length, htmlBytes: Buffer.byteLength(entry.html, "utf8"), key, savedAt: entry.savedAt };
  updateIndex((index) => {
    index.entries.set(entryFileName(key), metadata);
    scheduleIndexPersist(index);
  });
  return true;
};

/** Every stored entry (optionally only keys with the prefix), sorted by key, from the index alone. */
export const listPersistentRenderedMarkdownCacheEntries = async (
  keyPrefix?: string,
): Promise<RenderedMarkdownCacheEntryMetadata[]> => {
  const index = await loadedIndex();
  const entries: RenderedMarkdownCacheEntryMetadata[] = [];
  for (const entry of index.entries.values()) {
    if (!keyPrefix || entry.key.startsWith(keyPrefix)) {
      entries.push({ ...entry });
    }
  }

  return entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
};

/** Deletes every entry whose key matches; finds them in the index, so no entry is opened. Returns the number of deleted files. */
export const deletePersistentRenderedMarkdownWhere = async (
  predicate: (key: string) => boolean,
): Promise<number> => {
  const index = await loadedIndex();
  const matches: string[] = [];
  for (const [fileName, entry] of index.entries) {
    if (predicate(entry.key)) {
      matches.push(fileName);
    }
  }
  if (matches.length === 0) {
    return 0;
  }

  // Removed from the index before the files, so a listing meanwhile never reports them.
  for (const fileName of matches) {
    index.entries.delete(fileName);
  }
  scheduleIndexPersist(index);

  const pagesDir = cachePagesDir(index.cacheDir);
  let deletedEntries = 0;
  for (const fileName of matches) {
    try {
      await unlink(path.join(/*turbopackIgnore: true*/ pagesDir, fileName));
      deletedEntries += 1;
    } catch (error: unknown) {
      // A file that could not be deleted is read back into the index by the next reconciliation.
      if (!isMissingFileError(error)) {
        warnCacheFileFailure("delete", fileName, error);
      }
    }
  }

  return deletedEntries;
};
