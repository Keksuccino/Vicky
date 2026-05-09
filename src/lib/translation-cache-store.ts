import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GitHubDocPage, MarkdownHeading } from "@/lib/types";

const TRANSLATION_CACHE_VERSION = 1;
const DEFAULT_TRANSLATION_CACHE_DIR = path.join(process.cwd(), "data", "translation-cache");

type TranslationCacheKind = "pages" | "titles";

type PersistedPageTranslation = {
  version: typeof TRANSLATION_CACHE_VERSION;
  kind: "pages";
  key: string;
  savedAt: string;
  page: GitHubDocPage;
};

type PersistedTitleTranslations = {
  version: typeof TRANSLATION_CACHE_VERSION;
  kind: "titles";
  key: string;
  savedAt: string;
  translations: Array<{
    slug: string;
    title: string;
  }>;
};

const getTranslationCacheDir = (): string => process.env.WIKI_TRANSLATION_CACHE_DIR?.trim() || DEFAULT_TRANSLATION_CACHE_DIR;

const hashCacheKey = (key: string): string => createHash("sha256").update(key).digest("hex");

const cacheFilePath = (kind: TranslationCacheKind, key: string): string =>
  path.join(getTranslationCacheDir(), kind, `${hashCacheKey(key)}.json`);

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

const warnCacheFailure = (action: string, key: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[auto-translate] Failed to ${action} persistent translation cache entry ${hashCacheKey(key)}: ${message}`);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asOptionalString = (value: unknown): string | undefined => {
  const text = asString(value);
  return text && text.trim() ? text : undefined;
};

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
    depth,
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

const normalizeGitHubDocPage = (value: unknown): GitHubDocPage | null => {
  const source = asRecord(value);
  if (!source) {
    return null;
  }

  const pathValue = asString(source.path);
  const slug = asString(source.slug);
  const sha = asString(source.sha);
  const title = asString(source.title);
  const description = asString(source.description);
  const content = asString(source.content);
  const markdown = asString(source.markdown);
  const headings = normalizeHeadings(source.headings);

  if (
    !pathValue ||
    !slug ||
    !sha ||
    title === null ||
    description === null ||
    content === null ||
    markdown === null ||
    !headings ||
    typeof source.includeInPlaintextExport !== "boolean"
  ) {
    return null;
  }

  return {
    path: pathValue,
    slug,
    sha,
    title,
    description,
    content,
    markdown,
    headings,
    includeInPlaintextExport: source.includeInPlaintextExport,
    updatedAt: asOptionalString(source.updatedAt),
    updatedBy: asOptionalString(source.updatedBy),
  };
};

const normalizePersistedPage = (value: unknown, key: string): GitHubDocPage | null => {
  const source = asRecord(value);
  if (!source || source.version !== TRANSLATION_CACHE_VERSION || source.kind !== "pages" || source.key !== key) {
    return null;
  }

  return normalizeGitHubDocPage(source.page);
};

const normalizePersistedTitles = (value: unknown, key: string): Map<string, string> | null => {
  const source = asRecord(value);
  if (!source || source.version !== TRANSLATION_CACHE_VERSION || source.kind !== "titles" || source.key !== key) {
    return null;
  }

  if (!Array.isArray(source.translations)) {
    return null;
  }

  const translations = new Map<string, string>();
  for (const entry of source.translations) {
    const record = asRecord(entry);
    const slug = record ? asString(record.slug)?.trim() : "";
    const title = record ? asString(record.title)?.trim() : "";
    if (!slug || !title) {
      return null;
    }

    translations.set(slug, title);
  }

  return translations;
};

const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
};

export const readPersistentTranslatedPage = async (key: string): Promise<GitHubDocPage | null> => {
  try {
    const raw = await readFile(cacheFilePath("pages", key), "utf8");
    return normalizePersistedPage(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

export const readPersistentTranslatedPageSync = (key: string): GitHubDocPage | null => {
  try {
    const raw = readFileSync(cacheFilePath("pages", key), "utf8");
    return normalizePersistedPage(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

export const writePersistentTranslatedPage = async (key: string, page: GitHubDocPage): Promise<boolean> => {
  try {
    const entry: PersistedPageTranslation = {
      version: TRANSLATION_CACHE_VERSION,
      kind: "pages",
      key,
      savedAt: new Date().toISOString(),
      page,
    };

    await writeJsonFile(cacheFilePath("pages", key), entry);
    return true;
  } catch (error: unknown) {
    warnCacheFailure("write", key, error);
    return false;
  }
};

export const readPersistentTitleTranslations = async (key: string): Promise<Map<string, string> | null> => {
  try {
    const raw = await readFile(cacheFilePath("titles", key), "utf8");
    return normalizePersistedTitles(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

export const readPersistentTitleTranslationsSync = (key: string): Map<string, string> | null => {
  try {
    const raw = readFileSync(cacheFilePath("titles", key), "utf8");
    return normalizePersistedTitles(JSON.parse(raw) as unknown, key);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      warnCacheFailure("read", key, error);
    }

    return null;
  }
};

export const writePersistentTitleTranslations = async (
  key: string,
  translations: Map<string, string>,
): Promise<boolean> => {
  try {
    const entry: PersistedTitleTranslations = {
      version: TRANSLATION_CACHE_VERSION,
      kind: "titles",
      key,
      savedAt: new Date().toISOString(),
      translations: Array.from(translations, ([slug, title]) => ({ slug, title })),
    };

    await writeJsonFile(cacheFilePath("titles", key), entry);
    return true;
  } catch (error: unknown) {
    warnCacheFailure("write", key, error);
    return false;
  }
};
