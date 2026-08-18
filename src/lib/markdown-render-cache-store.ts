import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { MARKDOWN_RENDER_VERSION } from "@/lib/markdown-rendering-shared";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectorySync,
  ensurePrivateFile,
  ensurePrivateFileSync,
  secureAtomicWriteFile,
} from "@/lib/runtime-file-security.mjs";
import type { MarkdownHeading } from "@/lib/types";

const MARKDOWN_RENDER_CACHE_ENTRY_VERSION = 1;
const MARKDOWN_RENDER_CACHE_METADATA_VERSION = 1;
const DEFAULT_MARKDOWN_RENDER_CACHE_DIR = path.join(process.cwd(), "data", "markdown-cache");

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

export type RenderedMarkdownCacheEntryMetadata = {
  fileName: string;
  headingCount: number;
  htmlBytes: number;
  key: string;
  rendererVersion: string;
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

const RENDERED_MARKDOWN_CACHE_MUTATION_STATE_KEY = Symbol.for("vicky.markdownRender.cacheMutationState");

const getRenderedMarkdownCacheMutationState = (): RenderedMarkdownCacheMutationState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, RenderedMarkdownCacheMutationState | undefined>;
  let state = globalState[RENDERED_MARKDOWN_CACHE_MUTATION_STATE_KEY];

  if (!state) {
    state = {
      cacheDir: "",
      lastMutation: null,
    };
    globalState[RENDERED_MARKDOWN_CACHE_MUTATION_STATE_KEY] = state;
  }

  return state;
};

const getMarkdownRenderCacheDir = (): string =>
  process.env.WIKI_MARKDOWN_CACHE_DIR?.trim() || DEFAULT_MARKDOWN_RENDER_CACHE_DIR;

export const getPersistentRenderedMarkdownCacheDir = (): string => getMarkdownRenderCacheDir();

const hashCacheKey = (key: string): string => createHash("sha256").update(key).digest("hex");

const cachePagesDir = (): string => path.join(getMarkdownRenderCacheDir(), "pages");

const cacheMetadataFilePath = (): string => path.join(getMarkdownRenderCacheDir(), "metadata.json");

const cacheFilePath = (key: string): string => path.join(getMarkdownRenderCacheDir(), "pages", `${hashCacheKey(key)}.json`);

const ensurePrivateCacheFile = async (filePath: string): Promise<boolean> => {
  await ensurePrivateDirectory(getMarkdownRenderCacheDir());
  return ensurePrivateFile(filePath);
};

const ensurePrivateCacheFileSync = (filePath: string): boolean => {
  ensurePrivateDirectorySync(getMarkdownRenderCacheDir());
  return ensurePrivateFileSync(filePath);
};

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const warnCacheFailure = (action: string, key: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[markdown] Failed to ${action} persistent rendered markdown cache entry ${hashCacheKey(key)}: ${message}`);
};

const warnCacheFileFailure = (action: string, fileName: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[markdown] Failed to ${action} persistent rendered markdown cache file ${fileName}: ${message}`);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

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

const normalizePersistedRenderedMarkdownMetadata = (
  value: unknown,
  fileName: string,
): RenderedMarkdownCacheEntryMetadata | null => {
  const source = asRecord(value);
  if (!source || source.version !== MARKDOWN_RENDER_CACHE_ENTRY_VERSION || source.kind !== "rendered-markdown") {
    return null;
  }

  const key = asString(source.key);
  const rendererVersion = asString(source.rendererVersion);
  const savedAt = asString(source.savedAt);
  const html = asString(source.html);
  const headingCount = Array.isArray(source.headings) ? source.headings.length : 0;

  if (!key || !rendererVersion || !savedAt || html === null) {
    return null;
  }

  return {
    fileName,
    headingCount,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    key,
    rendererVersion,
    savedAt,
  };
};

const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await ensurePrivateDirectory(getMarkdownRenderCacheDir());
  await secureAtomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    await ensurePrivateCacheFile(filePath);
    const raw = await readFile(filePath, "utf8");
    const source = asRecord(JSON.parse(raw) as unknown);
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
  const state = getRenderedMarkdownCacheMutationState();
  state.cacheDir = getMarkdownRenderCacheDir();
  state.lastMutation = recorded;

  try {
    await writeJsonFile(cacheMetadataFilePath(), {
      version: MARKDOWN_RENDER_CACHE_METADATA_VERSION,
      kind: "rendered-markdown-cache-metadata",
      lastMutation: recorded,
    } satisfies PersistedRenderedMarkdownCacheMetadata);
  } catch (error: unknown) {
    warnCacheFileFailure("write metadata to", "metadata.json", error);
  }

  return recorded;
};

export const getRenderedMarkdownCacheLastMutation = async (): Promise<RenderedMarkdownCacheMutation | null> => {
  const state = getRenderedMarkdownCacheMutationState();
  const cacheDir = getMarkdownRenderCacheDir();
  if (state.cacheDir === cacheDir && state.lastMutation) {
    return state.lastMutation;
  }

  const metadata = await readRenderedMarkdownCacheMetadata();
  state.cacheDir = cacheDir;
  state.lastMutation = metadata?.lastMutation ?? null;
  return state.lastMutation;
};

const listPersistentRenderedMarkdownFileNames = async (): Promise<string[]> => {
  try {
    await ensurePrivateDirectory(getMarkdownRenderCacheDir());
    await ensurePrivateDirectory(cachePagesDir());
    return (await readdir(cachePagesDir())).filter((fileName) => fileName.endsWith(".json"));
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFileFailure("list", "pages", error);
    }

    return [];
  }
};

const readPersistentRenderedMarkdownMetadataFile = async (
  fileName: string,
): Promise<RenderedMarkdownCacheEntryMetadata | null> => {
  const filePath = path.join(cachePagesDir(), fileName);

  try {
    await ensurePrivateCacheFile(filePath);
    const raw = await readFile(filePath, "utf8");
    return normalizePersistedRenderedMarkdownMetadata(JSON.parse(raw) as unknown, fileName);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFileFailure("read metadata from", fileName, error);
    }

    return null;
  }
};

export const readPersistentRenderedMarkdown = async (key: string): Promise<PersistedRenderedMarkdown | null> => {
  try {
    const filePath = cacheFilePath(key);
    await ensurePrivateCacheFile(filePath);
    const raw = await readFile(filePath, "utf8");
    return normalizePersistedRenderedMarkdown(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

export const readPersistentRenderedMarkdownSync = (key: string): PersistedRenderedMarkdown | null => {
  try {
    const filePath = cacheFilePath(key);
    ensurePrivateCacheFileSync(filePath);
    const raw = readFileSync(filePath, "utf8");
    return normalizePersistedRenderedMarkdown(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

export const readPersistentRenderedMarkdownMetadata = async (
  key: string,
): Promise<RenderedMarkdownCacheEntryMetadata | null> => {
  try {
    const filePath = cacheFilePath(key);
    await ensurePrivateCacheFile(filePath);
    const raw = await readFile(filePath, "utf8");
    return normalizePersistedRenderedMarkdownMetadata(JSON.parse(raw) as unknown, `${hashCacheKey(key)}.json`);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read metadata from", key, error);
    }

    return null;
  }
};

export const writePersistentRenderedMarkdown = async (
  key: string,
  rendered: PersistedRenderedMarkdown,
): Promise<boolean> => {
  try {
    const entry: PersistedRenderedMarkdownEntry = {
      version: MARKDOWN_RENDER_CACHE_ENTRY_VERSION,
      kind: "rendered-markdown",
      key,
      rendererVersion: MARKDOWN_RENDER_VERSION,
      savedAt: new Date().toISOString(),
      html: rendered.html,
      headings: rendered.headings,
    };

    await writeJsonFile(cacheFilePath(key), entry);
    return true;
  } catch (error: unknown) {
    warnCacheFailure("write", key, error);
    return false;
  }
};

export const listPersistentRenderedMarkdownCacheEntries = async (
  keyPrefix?: string,
): Promise<RenderedMarkdownCacheEntryMetadata[]> => {
  const fileNames = await listPersistentRenderedMarkdownFileNames();
  const entries: RenderedMarkdownCacheEntryMetadata[] = [];

  for (const fileName of fileNames) {
    const entry = await readPersistentRenderedMarkdownMetadataFile(fileName);
    if (!entry || (keyPrefix && !entry.key.startsWith(keyPrefix))) {
      continue;
    }

    entries.push(entry);
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));
  return entries;
};

export const deletePersistentRenderedMarkdown = async (key: string): Promise<boolean> => {
  try {
    const filePath = cacheFilePath(key);
    await ensurePrivateCacheFile(filePath);
    await unlink(filePath);
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }

    warnCacheFailure("delete", key, error);
    return false;
  }
};

export const deletePersistentRenderedMarkdownWhere = async (
  predicate: (key: string) => boolean,
): Promise<number> => {
  const fileNames = await listPersistentRenderedMarkdownFileNames();
  let deletedEntries = 0;

  for (const fileName of fileNames) {
    const entry = await readPersistentRenderedMarkdownMetadataFile(fileName);
    if (!entry || !predicate(entry.key)) {
      continue;
    }

    try {
      const filePath = path.join(cachePagesDir(), fileName);
      await ensurePrivateCacheFile(filePath);
      await unlink(filePath);
      deletedEntries += 1;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        warnCacheFileFailure("delete", fileName, error);
      }
    }
  }

  return deletedEntries;
};
