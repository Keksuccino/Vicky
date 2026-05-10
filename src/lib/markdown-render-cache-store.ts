import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { MARKDOWN_RENDER_VERSION } from "@/lib/markdown-rendering-shared";
import type { MarkdownHeading } from "@/lib/types";

const MARKDOWN_RENDER_CACHE_ENTRY_VERSION = 1;
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

const getMarkdownRenderCacheDir = (): string =>
  process.env.WIKI_MARKDOWN_CACHE_DIR?.trim() || DEFAULT_MARKDOWN_RENDER_CACHE_DIR;

const hashCacheKey = (key: string): string => createHash("sha256").update(key).digest("hex");

const cacheFilePath = (key: string): string => path.join(getMarkdownRenderCacheDir(), "pages", `${hashCacheKey(key)}.json`);

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const warnCacheFailure = (action: string, key: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[markdown] Failed to ${action} persistent rendered markdown cache entry ${hashCacheKey(key)}: ${message}`);
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

const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

export const readPersistentRenderedMarkdown = async (key: string): Promise<PersistedRenderedMarkdown | null> => {
  try {
    const raw = await readFile(cacheFilePath(key), "utf8");
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
    const raw = readFileSync(cacheFilePath(key), "utf8");
    return normalizePersistedRenderedMarkdown(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
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
