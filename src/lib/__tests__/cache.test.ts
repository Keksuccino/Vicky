import { describe, expect, it, vi } from "vitest";

import { TtlCache } from "../cache";

describe("TtlCache", () => {
  it("returns cached value before expiry and expires afterwards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    const cache = new TtlCache<string, string>(1000);
    cache.set("x", "value");

    expect(cache.get("x")).toBe("value");

    vi.advanceTimersByTime(1001);

    expect(cache.get("x")).toBeUndefined();

    vi.useRealTimers();
  });

  it("deletes entries by predicate", () => {
    const cache = new TtlCache<string, number>(10_000);

    cache.set("group:a", 1);
    cache.set("group:b", 2);
    cache.set("other:c", 3);

    cache.deleteWhere((key) => key.startsWith("group:"));

    expect(cache.get("group:a")).toBeUndefined();
    expect(cache.get("group:b")).toBeUndefined();
    expect(cache.get("other:c")).toBe(3);
  });
});
