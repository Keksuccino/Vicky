import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryCache } from "../cache";

describe("MemoryCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a cached value before expiry and expires it afterwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const cache = new MemoryCache<string>({ maxEntries: 10, ttlMs: 1000 });
    cache.set("x", "value");

    expect(cache.get("x")).toBe("value");

    vi.advanceTimersByTime(1001);

    expect(cache.get("x")).toBeUndefined();
  });

  it("removes expired entries even when nobody reads them again", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<string>({ maxBytes: 1_000, sizeOf: (value) => value.length, ttlMs: 1000 });
    cache.set("never-read-again", "value");
    cache.set("other", "value");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(1001);

    expect(cache.size).toBe(0);
    expect(cache.approximateBytes).toBe(0);
  });

  it("applies a changed expiry to entries set afterwards", () => {
    vi.useFakeTimers();
    const cache = new MemoryCache<string>({ maxEntries: 10, ttlMs: 1000 });
    cache.set("short", "value");
    cache.setTtlMs(5000);
    cache.set("long", "value");

    vi.advanceTimersByTime(2000);

    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("value");
    expect(cache.getTtlMs()).toBe(5000);
  });

  it("evicts the least recently used values beyond its byte bound", () => {
    const cache = new MemoryCache<string>({ maxBytes: 100, sizeOf: (value) => value.length });
    cache.set("a", "a".repeat(40));
    cache.set("b", "b".repeat(40));
    expect(cache.get("a")).toBeDefined();

    cache.set("c", "c".repeat(40));

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.approximateBytes).toBe(80);

    // A value larger than the whole bound is not kept, and does not displace the others.
    cache.set("huge", "h".repeat(101));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("evicts the least recently used entries beyond its entry bound", () => {
    const cache = new MemoryCache<object>({ maxEntries: 2 });
    const first = {};
    cache.set("first", first);
    cache.set("second", {});
    cache.get("first");
    cache.set("third", {});

    expect(cache.get("first")).toBe(first);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("deletes entries by predicate", () => {
    const cache = new MemoryCache<string>({ maxEntries: 10, ttlMs: 10_000 });

    cache.set("group:a", "1");
    cache.set("group:b", "2");
    cache.set("other:c", "3");

    cache.deleteWhere((key) => key.startsWith("group:"));

    expect(cache.get("group:a")).toBeUndefined();
    expect(cache.get("group:b")).toBeUndefined();
    expect(cache.get("other:c")).toBe("3");
  });
});
