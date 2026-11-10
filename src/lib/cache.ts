import { processSingleton } from "@/lib/process-singleton.mjs";

const FALLBACK_DOCS_CACHE_TTL_MS = 3_600_000;
export const MIN_DOCS_CACHE_TTL_MS = 1_000;
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

export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = normalizeDocsCacheTtlMs(ttlMs);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  getTtlMs(): number {
    return this.ttlMs;
  }

  setTtlMs(ttlMs: number): void {
    this.ttlMs = normalizeDocsCacheTtlMs(ttlMs, this.ttlMs);
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
      }
    }
  }
}

export class MemoryCache<K, V> {
  private readonly entries = new Map<K, V>();

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    this.entries.set(key, value);
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
      }
    }
  }
}

const defaultTtlMs = normalizeDocsCacheTtlMs(process.env.DOCS_CACHE_TTL_MS);
export const DOCS_CACHE_TTL_MS = defaultTtlMs;

const docsMemoryCaches = processSingleton("cache.docsMemoryCaches", () => ({
  docsSnapshot: new TtlCache<string, unknown>(DOCS_CACHE_TTL_MS),
  docsTree: new TtlCache<string, unknown>(DOCS_CACHE_TTL_MS),
  docsPage: new TtlCache<string, unknown>(DOCS_CACHE_TTL_MS),
  docsSearchCorpus: new TtlCache<string, unknown>(DOCS_CACHE_TTL_MS),
  aiPlaintextDocs: new TtlCache<string, string>(AI_PLAINTEXT_EXPORT_CACHE_TTL_MS),
  translatedDocsPage: new MemoryCache<string, unknown>(),
  translatedDocsTitle: new MemoryCache<string, unknown>(),
  renderedMarkdown: new MemoryCache<string, unknown>(),
}));

export const docsSnapshotCache = docsMemoryCaches.docsSnapshot;
export const docsTreeCache = docsMemoryCaches.docsTree;
export const docsPageCache = docsMemoryCaches.docsPage;
export const docsSearchCorpusCache = docsMemoryCaches.docsSearchCorpus;
export const aiPlaintextDocsCache = docsMemoryCaches.aiPlaintextDocs;
export const translatedDocsPageCache = docsMemoryCaches.translatedDocsPage;
export const translatedDocsTitleCache = docsMemoryCaches.translatedDocsTitle;
export const renderedMarkdownCache = docsMemoryCaches.renderedMarkdown;

export const setDocsCacheTtlMs = (ttlMs: number): number => {
  const normalized = normalizeDocsCacheTtlMs(ttlMs, docsSnapshotCache.getTtlMs());
  docsSnapshotCache.setTtlMs(normalized);
  docsTreeCache.setTtlMs(normalized);
  docsPageCache.setTtlMs(normalized);
  docsSearchCorpusCache.setTtlMs(normalized);
  return normalized;
};
