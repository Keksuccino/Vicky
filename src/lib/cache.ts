export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

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

  set(key: K, value: V): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
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

const defaultTtlMs = Number(process.env.DOCS_CACHE_TTL_MS ?? "30000");
export const DOCS_CACHE_TTL_MS = Number.isFinite(defaultTtlMs) && defaultTtlMs > 0 ? defaultTtlMs : 30000;

export const docsTreeCache = new TtlCache<string, unknown>(DOCS_CACHE_TTL_MS);
export const docsPageCache = new TtlCache<string, unknown>(DOCS_CACHE_TTL_MS);
