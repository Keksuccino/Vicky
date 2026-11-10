import { LRUCache } from "lru-cache";

import type { PersistedRenderedMarkdown } from "@/lib/markdown-render-cache-store";
import { processSingleton } from "@/lib/process-singleton.mjs";

const FALLBACK_DOCS_CACHE_TTL_MS = 3_600_000;
/**
 * Bounds of the docs refresh interval: 1 minute to 24 hours, the range the admin panel's minutes
 * field offers. Each interval costs at least one conditional tree request to GitHub.
 */
export const MIN_DOCS_CACHE_TTL_MS = 60_000;
export const MAX_DOCS_CACHE_TTL_MS = 86_400_000;
export const AI_PLAINTEXT_EXPORT_CACHE_TTL_MS = 30_000;

export function normalizeDocsCacheTtlMs(value: unknown, fallback = FALLBACK_DOCS_CACHE_TTL_MS): number {
  let numeric = Number.NaN;

  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim()) {
    numeric = Number(value);
  }

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const rounded = Math.round(numeric);
  return Math.min(MAX_DOCS_CACHE_TTL_MS, Math.max(MIN_DOCS_CACHE_TTL_MS, rounded));
}

/** Any positive expiry, in whole milliseconds; the docs refresh bounds apply only to `setDocsCacheTtlMs`. */
const normalizeTtlMs = (value: number, fallback: number): number => (Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : fallback);

/** Approximate bytes of a JavaScript string: two per UTF-16 code unit plus the string header. */
export const approximateStringBytes = (value: string): number => value.length * 2 + 16;

type MemoryCacheBound<V> =
  | {
      maxEntries: number;
    }
  | {
      /** Approximate total size; `sizeOf` estimates one value. */
      maxBytes: number;
      sizeOf: (value: V) => number;
    };

type MemoryCacheOptions<V> = MemoryCacheBound<V> & {
  /** Entries expire this long after they were set (see `setTtlMs`). */
  ttlMs?: number;
};

/**
 * In-memory cache with a fixed bound (entries, or approximate bytes) and least-recently-used
 * eviction. Expired entries are removed by a timer as well, not only when their key is read
 * again. Every value it holds can be loaded again by its owner (from disk, the docs view, or by
 * rendering it), so eviction only costs that work and never affects what is served.
 */
export class MemoryCache<V extends object | string> {
  private readonly entries: LRUCache<string, V>;
  private ttlMs: number | undefined;

  constructor(options: MemoryCacheOptions<V>) {
    this.ttlMs = options.ttlMs === undefined ? undefined : normalizeTtlMs(options.ttlMs, FALLBACK_DOCS_CACHE_TTL_MS);
    const sizeOf = "sizeOf" in options ? options.sizeOf : null;
    this.entries = new LRUCache<string, V>({
      ...("maxBytes" in options ? { maxSize: options.maxBytes, sizeCalculation: (value: V) => Math.max(1, Math.ceil(sizeOf?.(value) ?? 1)) } : { max: options.maxEntries }),
      // Per-entry purge timers, unref'd by lru-cache; the TTL caches hold a few dozen entries.
      ...(this.ttlMs === undefined ? {} : { ttl: this.ttlMs, ttlAutopurge: true }),
      // Wall-clock expiry, like every other expiry in the app.
      perf: { now: () => Date.now() },
    });
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    this.entries.set(key, value, this.ttlMs === undefined ? undefined : { ttl: this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of Array.from(this.entries.keys())) {
      if (predicate(key)) {
        this.entries.delete(key);
      }
    }
  }

  /** Expiry of entries set from now on; 0 for a cache without expiry. */
  getTtlMs(): number {
    return this.ttlMs ?? 0;
  }

  /** Changes the expiry of entries set from now on; no effect on a cache without expiry. */
  setTtlMs(ttlMs: number): void {
    if (this.ttlMs !== undefined) {
      this.ttlMs = normalizeTtlMs(ttlMs, this.ttlMs);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Approximate bytes held; 0 for an entry-bounded cache. */
  get approximateBytes(): number {
    return this.entries.calculatedSize;
  }
}

/** What a byte-bounded cache needs to know about a value whose size its owner computed. */
export type SizedCacheValue = {
  approximateBytes: number;
};

const sizeOfRenderedMarkdown = (rendered: PersistedRenderedMarkdown): number =>
  approximateStringBytes(rendered.html) + rendered.headings.reduce((bytes, heading) => bytes + approximateStringBytes(heading.text) + approximateStringBytes(heading.slug) + 48, 64);

/** Bounds of the caches below; each comment says why. */
const CACHE_BOUNDS = {
  /** One docs view, one commit metadata state, and one load state per language for each source; old sources are removed on invalidation. */
  docsSourceEntries: 256,
  /** A corpus is several times its pages' text (normalized copies and word lists); this holds the source and about a dozen languages of a large site. */
  docsSearchCorpusBytes: 64 * 1024 * 1024,
  /** One export per origin; the origin comes from the request when no custom domain is set, so the number of keys is not under the app's control. */
  aiPlaintextDocsBytes: 16 * 1024 * 1024,
  /** Hot pages stay in memory; everything else is one file read away (`markdown-render-cache-store.ts`). */
  renderedMarkdownBytes: 32 * 1024 * 1024,
};

const defaultTtlMs = normalizeDocsCacheTtlMs(process.env.DOCS_CACHE_TTL_MS);
export const DOCS_CACHE_TTL_MS = defaultTtlMs;

const docsMemoryCaches = processSingleton("cache.docsMemoryCaches.v4", () => ({
  docsSource: new MemoryCache<object>({ maxEntries: CACHE_BOUNDS.docsSourceEntries }),
  docsSearchCorpus: new MemoryCache<SizedCacheValue>({ maxBytes: CACHE_BOUNDS.docsSearchCorpusBytes, sizeOf: (value) => value.approximateBytes, ttlMs: DOCS_CACHE_TTL_MS }),
  aiPlaintextDocs: new MemoryCache<string>({ maxBytes: CACHE_BOUNDS.aiPlaintextDocsBytes, sizeOf: approximateStringBytes, ttlMs: AI_PLAINTEXT_EXPORT_CACHE_TTL_MS }),
  renderedMarkdown: new MemoryCache<PersistedRenderedMarkdown>({ maxBytes: CACHE_BOUNDS.renderedMarkdownBytes, sizeOf: sizeOfRenderedMarkdown }),
}));

/**
 * Published per-source state: the docs view (repository index plus pages), the commit
 * metadata, and per-language localization load state. It does not expire; staleness is tracked
 * by the source loader, which keeps serving the current state while it refreshes. Source
 * invalidation removes entries by key prefix. An evicted view is rebuilt from the persisted index.
 */
export const docsSourceCache = docsMemoryCaches.docsSource;
/** Search corpora; their TTL is the docs refresh interval. */
export const docsSearchCorpusCache = docsMemoryCaches.docsSearchCorpus;
export const aiPlaintextDocsCache = docsMemoryCaches.aiPlaintextDocs;
export const renderedMarkdownCache = docsMemoryCaches.renderedMarkdown;

export const setDocsCacheTtlMs = (ttlMs: number): number => {
  const normalized = normalizeDocsCacheTtlMs(ttlMs, docsSearchCorpusCache.getTtlMs());
  docsSearchCorpusCache.setTtlMs(normalized);
  return normalized;
};

/** The admin-configured docs refresh interval. */
export const getDocsCacheTtlMs = (): number => docsSearchCorpusCache.getTtlMs();
