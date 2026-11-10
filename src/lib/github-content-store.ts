import { createHash } from "node:crypto";

import { LRUCache } from "lru-cache";

import { getGitHubClient, gitHubErrorStatus, type GitHubRequestPriority } from "@/lib/github-client";
import {
  blobFilePath,
  deletePrivateFile,
  listStoredBlobShas,
  readPrivateJsonFile,
  writePrivateJsonFile,
} from "@/lib/github-docs-cache-files";
import { isGitObjectSha } from "@/lib/github-paths";
import { listPersistedRepoIndexBlobShas } from "@/lib/github-repo-index";
import { badRequest, notFound } from "@/lib/http";
import { parseMarkdownDocument } from "@/lib/markdown";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type { GitHubRuntimeConfig, MarkdownHeading, ParsedMarkdownDocument } from "@/lib/types";

const BLOB_RECORD_VERSION = 1;
/** Bump when `parseMarkdownDocument` changes its output, so stored blobs are parsed again (from their stored Markdown, without a download). */
const MARKDOWN_PARSE_VERSION = 2;
/** In-memory budget for blobs outside the published docs; page objects keep their own blobs alive. */
const BLOB_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{32}$/;

/** A Git blob parsed once: its Markdown plus everything page building needs from it. */
export type GitHubBlobRecord = ParsedMarkdownDocument & {
  byteLength: number;
  /** Fingerprint of the page body; the rendered-HTML cache key uses it (see `hashMarkdownContent`). */
  contentHash: string;
  markdown: string;
  sha: string;
};

/** What lists of pages (sidebar titles, cache status, translation status) need from a blob, without its body. */
export type GitHubBlobSummary = Pick<GitHubBlobRecord, "contentHash" | "sourceBlobSha" | "title">;

type PersistedBlobRecord = Omit<GitHubBlobRecord, "content"> & {
  content?: string;
  contentStart?: number;
  kind: "github-blob";
  parseVersion: number;
  version: typeof BLOB_RECORD_VERSION;
};

type ContentStoreState = {
  loads: Map<string, Promise<GitHubBlobRecord>>;
  /** Blobs of indexes that are being built or saved and not persisted yet, with a use count. */
  pins: Map<string, number>;
  records: LRUCache<string, GitHubBlobRecord>;
  /** Summaries of every blob read or stored by this process; tiny, so they outlive evicted records. */
  summaries: Map<string, GitHubBlobSummary>;
  sweep: { rerun: boolean; running: Promise<number> | null };
};

const storeState = processSingleton("githubContentStore.state.v2", (): ContentStoreState => ({
  loads: new Map(),
  pins: new Map(),
  // UTF-16 code units are two bytes; the page body shares the Markdown string, see `shareSuffix`.
  records: new LRUCache({ maxSize: BLOB_MEMORY_BUDGET_BYTES, sizeCalculation: (record) => record.markdown.length * 2 + 256 }),
  summaries: new Map(),
  sweep: { rerun: false, running: null },
}));

/** Git's object ID of a blob: SHA-1 over `blob <size>\0<bytes>`. */
export const gitBlobSha = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

/**
 * Fingerprint of a page body (Markdown without front matter). Rendered HTML is cached under it,
 * and stored blobs keep it, so the cache status of a page is known without reading its body.
 * Changing the function invalidates every rendered-HTML cache entry.
 */
export const hashMarkdownContent = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 32);

/**
 * Returns the page body as a slice of the Markdown when it is its suffix (the usual case), so
 * V8 keeps one character buffer for both instead of two copies of every page body.
 */
const shareSuffix = (markdown: string, content: string): string =>
  markdown.endsWith(content) ? markdown.slice(markdown.length - content.length) : content;

export const parseGitHubBlobRecord = (sha: string, markdown: string, byteLength = Buffer.byteLength(markdown, "utf8")): GitHubBlobRecord => {
  const parsed = parseMarkdownDocument(markdown);
  return {
    byteLength,
    content: shareSuffix(markdown, parsed.content),
    contentHash: hashMarkdownContent(parsed.content),
    description: parsed.description,
    headings: parsed.headings,
    includeInPlaintextExport: parsed.includeInPlaintextExport,
    markdown,
    sha,
    ...(parsed.sourceBlobSha ? { sourceBlobSha: parsed.sourceBlobSha } : {}),
    title: parsed.title,
  };
};

const toSummary = (record: GitHubBlobRecord): GitHubBlobSummary => ({
  contentHash: record.contentHash,
  ...(record.sourceBlobSha ? { sourceBlobSha: record.sourceBlobSha } : {}),
  title: record.title,
});

const toPersistedRecord = (record: GitHubBlobRecord): PersistedBlobRecord => {
  const contentStart = record.markdown.length - record.content.length;
  const sharesMarkdown = contentStart >= 0 && record.markdown.endsWith(record.content);
  return {
    byteLength: record.byteLength,
    ...(sharesMarkdown ? { contentStart } : { content: record.content }),
    contentHash: record.contentHash,
    description: record.description,
    headings: record.headings,
    includeInPlaintextExport: record.includeInPlaintextExport,
    kind: "github-blob",
    markdown: record.markdown,
    parseVersion: MARKDOWN_PARSE_VERSION,
    sha: record.sha,
    ...(record.sourceBlobSha ? { sourceBlobSha: record.sourceBlobSha } : {}),
    title: record.title,
    version: BLOB_RECORD_VERSION,
  };
};

const isHeading = (value: unknown): value is MarkdownHeading => {
  const heading = value as Partial<MarkdownHeading> | null;
  return typeof heading === "object" && heading !== null && typeof heading.depth === "number" && typeof heading.text === "string" && typeof heading.slug === "string";
};

const fromPersistedRecord = (value: unknown, sha: string): { record: GitHubBlobRecord; current: boolean } | null => {
  const source = typeof value === "object" && value !== null ? (value as Partial<PersistedBlobRecord>) : null;
  if (!source || source.version !== BLOB_RECORD_VERSION || source.kind !== "github-blob" || source.sha !== sha || typeof source.markdown !== "string") {
    return null;
  }

  const byteLength = typeof source.byteLength === "number" ? source.byteLength : Buffer.byteLength(source.markdown, "utf8");
  // A record that lacks any parsed field is parsed again from its Markdown and rewritten, without a download.
  const parsedFieldsValid =
    source.parseVersion === MARKDOWN_PARSE_VERSION &&
    typeof source.contentHash === "string" &&
    CONTENT_HASH_PATTERN.test(source.contentHash) &&
    typeof source.title === "string" &&
    typeof source.description === "string" &&
    typeof source.includeInPlaintextExport === "boolean" &&
    (source.sourceBlobSha === undefined || isGitObjectSha(source.sourceBlobSha)) &&
    Array.isArray(source.headings) &&
    source.headings.every(isHeading) &&
    (typeof source.content === "string" || (typeof source.contentStart === "number" && source.contentStart >= 0 && source.contentStart <= source.markdown.length));
  if (!parsedFieldsValid) {
    return { current: false, record: parseGitHubBlobRecord(sha, source.markdown, byteLength) };
  }

  return {
    current: true,
    record: {
      byteLength,
      content: typeof source.content === "string" ? source.content : source.markdown.slice(source.contentStart),
      contentHash: source.contentHash as string,
      description: source.description as string,
      headings: source.headings as MarkdownHeading[],
      includeInPlaintextExport: source.includeInPlaintextExport as boolean,
      markdown: source.markdown,
      sha,
      ...(source.sourceBlobSha ? { sourceBlobSha: source.sourceBlobSha } : {}),
      title: source.title as string,
    },
  };
};

const rememberSummary = (record: GitHubBlobRecord): GitHubBlobSummary => {
  const known = storeState.summaries.get(record.sha);
  if (known) {
    return known;
  }
  const summary = toSummary(record);
  storeState.summaries.set(record.sha, summary);
  return summary;
};

const rememberRecord = (record: GitHubBlobRecord): GitHubBlobRecord => {
  storeState.records.set(record.sha, record);
  rememberSummary(record);
  return record;
};

const writeRecord = (baseDir: string, record: GitHubBlobRecord): Promise<boolean> =>
  writePrivateJsonFile(blobFilePath(baseDir, record.sha), toPersistedRecord(record));

const readRecordFromDisk = async (baseDir: string, sha: string): Promise<GitHubBlobRecord | null> => {
  const stored = fromPersistedRecord(await readPrivateJsonFile(blobFilePath(baseDir, sha)), sha);
  if (!stored) {
    return null;
  }
  if (!stored.current) {
    await writeRecord(baseDir, stored.record);
  }
  return stored.record;
};

const decodeUtf8 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

/** Downloads one blob through the Git data API, which serves files of up to 100 MB. */
const downloadBlob = async (config: GitHubRuntimeConfig, sha: string, priority: GitHubRequestPriority): Promise<GitHubBlobRecord> => {
  const response = await getGitHubClient(config).git.getBlob({
    owner: config.owner,
    repo: config.repo,
    file_sha: sha,
    mediaType: { format: "raw" },
    request: { parseSuccessResponseBody: false, priority },
  });
  const bytes = new Uint8Array(await new Response(response.data as unknown as ReadableStream<Uint8Array>).arrayBuffer());
  if (gitBlobSha(bytes) !== sha) {
    throw new Error(`GitHub returned content that does not match blob ${sha}.`);
  }

  return parseGitHubBlobRecord(sha, decodeUtf8(bytes), bytes.byteLength);
};

const loadBlob = (config: GitHubRuntimeConfig, sha: string, baseDir: string, priority: GitHubRequestPriority): Promise<GitHubBlobRecord> => {
  const pending = storeState.loads.get(sha);
  if (pending) {
    return pending;
  }

  const load = (async () => {
    const stored = await readRecordFromDisk(baseDir, sha);
    if (stored) {
      return rememberRecord(stored);
    }

    const downloaded = rememberRecord(await downloadBlob(config, sha, priority));
    await writeRecord(baseDir, downloaded);
    return downloaded;
  })().finally(() => {
    if (storeState.loads.get(sha) === load) {
      storeState.loads.delete(sha);
    }
  });
  storeState.loads.set(sha, load);
  return load;
};

/**
 * Returns the parsed blobs for the given SHAs from memory, disk, or GitHub, in that order. Only
 * SHAs missing from the store cause requests, and concurrent callers share each download.
 * `storedOnly` never contacts GitHub and never waits for a running download: blobs the store
 * does not hold yet are left out of the result.
 */
export const loadGitHubBlobs = async (
  config: GitHubRuntimeConfig,
  shas: Iterable<string>,
  baseDir: string,
  options?: { priority?: GitHubRequestPriority; storedOnly?: boolean },
): Promise<Map<string, GitHubBlobRecord>> => {
  const records = new Map<string, GitHubBlobRecord>();
  const loads: Array<Promise<void>> = [];
  for (const sha of new Set(shas)) {
    const cached = storeState.records.get(sha);
    if (cached) {
      records.set(sha, cached);
      continue;
    }

    const load = options?.storedOnly
      ? readRecordFromDisk(baseDir, sha).then((record) => (record ? rememberRecord(record) : null))
      : loadBlob(config, sha, baseDir, options?.priority ?? "bulk");
    loads.push(load.then((record) => {
      if (record) {
        records.set(sha, record);
      }
    }));
  }

  await Promise.all(loads);
  return records;
};

/**
 * Returns the summaries of the given blobs that the store holds, never contacting GitHub. Blobs
 * read from disk for this are summarized without keeping their body in memory.
 */
export const loadStoredGitHubBlobSummaries = async (shas: Iterable<string>, baseDir: string): Promise<Map<string, GitHubBlobSummary>> => {
  const summaries = new Map<string, GitHubBlobSummary>();
  const reads: Array<Promise<void>> = [];
  for (const sha of new Set(shas)) {
    const known = storeState.summaries.get(sha);
    if (known) {
      summaries.set(sha, known);
      continue;
    }

    reads.push(readRecordFromDisk(baseDir, sha).then((record) => {
      if (record) {
        summaries.set(sha, rememberSummary(record));
      }
    }));
  }

  await Promise.all(reads);
  return summaries;
};

/** Stores content this app just committed, after verifying it hashes to the SHA GitHub reported. */
export const storeCommittedGitHubBlob = async (sha: string, markdown: string, baseDir: string): Promise<GitHubBlobRecord | null> => {
  const bytes = Buffer.from(markdown, "utf8");
  if (!isGitObjectSha(sha) || gitBlobSha(bytes) !== sha) {
    return null;
  }

  const record = rememberRecord(parseGitHubBlobRecord(sha, markdown, bytes.byteLength));
  await writeRecord(baseDir, record);
  return record;
};

type GitHubContentsFile = {
  content?: string;
  encoding?: string;
  sha: string;
  size?: number;
  type: string;
};

/**
 * Reads one file by path through the contents API. Files over 1 MB come back without content
 * (`encoding: "none"`), so those are loaded by blob SHA instead.
 */
export const fetchGitHubFile = async (config: GitHubRuntimeConfig, repoPath: string): Promise<{ markdown: string; sha: string }> => {
  let file: GitHubContentsFile;
  try {
    const response = await getGitHubClient(config).repos.getContent({ owner: config.owner, repo: config.repo, path: repoPath, ref: config.branch });
    if (Array.isArray(response.data) || response.data.type !== "file") {
      throw badRequest("Document path does not point to a file.");
    }
    file = response.data as GitHubContentsFile;
  } catch (error: unknown) {
    if (gitHubErrorStatus(error) === 404) {
      throw notFound("Document not found.");
    }
    throw error;
  }

  if (file.encoding === "base64" && typeof file.content === "string") {
    return { markdown: decodeUtf8(Buffer.from(file.content, "base64")), sha: file.sha };
  }

  return { markdown: (await downloadBlob(config, file.sha, "interactive")).markdown, sha: file.sha };
};

/**
 * Protects the blobs of an index from sweeps until the index is persisted. Call the returned
 * function once the index is written (or abandoned).
 */
export const pinGitHubBlobs = (shas: Iterable<string>): (() => void) => {
  const pinned = Array.from(new Set(shas));
  for (const sha of pinned) {
    storeState.pins.set(sha, (storeState.pins.get(sha) ?? 0) + 1);
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    for (const sha of pinned) {
      const remaining = (storeState.pins.get(sha) ?? 1) - 1;
      if (remaining > 0) {
        storeState.pins.set(sha, remaining);
      } else {
        storeState.pins.delete(sha);
      }
    }
  };
};

const runBlobSweep = async (baseDir: string): Promise<number> => {
  const [referenced, stored] = await Promise.all([listPersistedRepoIndexBlobShas(baseDir), listStoredBlobShas(baseDir)]);
  const unreferenced = stored.filter((sha) => !referenced.has(sha) && !storeState.pins.has(sha) && !storeState.loads.has(sha));
  const results = await Promise.all(
    unreferenced.map(async (sha) => {
      storeState.records.delete(sha);
      storeState.summaries.delete(sha);
      return deletePrivateFile(blobFilePath(baseDir, sha));
    }),
  );
  return results.filter(Boolean).length;
};

/**
 * Deletes stored blobs that no persisted index references, from disk and memory. Pinned blobs
 * and blobs being loaded are kept: they belong to an index that is not written yet. Sweeps run
 * one at a time; a request during a sweep runs one more sweep afterwards.
 */
export const sweepUnreferencedGitHubBlobs = (baseDir: string): Promise<number> => {
  const sweep = storeState.sweep;
  if (sweep.running) {
    sweep.rerun = true;
    return sweep.running;
  }

  const running = (async () => {
    let deleted = 0;
    do {
      sweep.rerun = false;
      deleted += await runBlobSweep(baseDir);
    } while (sweep.rerun);
    return deleted;
  })().finally(() => {
    sweep.running = null;
  });
  sweep.running = running;
  return running;
};

export const clearGitHubBlobMemory = (): void => {
  storeState.records.clear();
  storeState.summaries.clear();
};
