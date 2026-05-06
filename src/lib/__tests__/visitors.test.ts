import { describe, expect, it } from "vitest";

import { DEFAULT_VISITOR_STATS } from "@/lib/defaults";
import { createVisitorStatsSummary, recordVisitorInStats } from "@/lib/visitors";

describe("visitor stats", () => {
  it("counts visits while keeping unique visitors deduped per scope and page", () => {
    const stats = DEFAULT_VISITOR_STATS();
    const visitedAt = new Date("2026-05-05T10:00:00.000Z");

    expect(
      recordVisitorInStats(stats, { path: "/home", slug: "home", title: "Home" }, "visitor-a", visitedAt),
    ).toBe(true);
    expect(
      recordVisitorInStats(stats, { path: "/home", slug: "home", title: "Home" }, "visitor-a", visitedAt),
    ).toBe(true);
    expect(
      recordVisitorInStats(stats, { path: "/guide", slug: "guide", title: "Guide" }, "visitor-a", visitedAt),
    ).toBe(true);

    const summary = createVisitorStatsSummary(stats, visitedAt, [
      { path: "/home", slug: "home", title: "Home" },
      { path: "/guide", slug: "guide", title: "Guide" },
      { path: "/empty", slug: "empty", title: "Empty" },
    ]);

    expect(summary.scopes.allTime.totalVisits).toBe(3);
    expect(summary.scopes.allTime.totalVisitors).toBe(1);
    expect(summary.scopes.allTime.periods).toEqual([
      { key: "2026-05-05", label: "May 5", visits: 3, visitors: 1, current: true },
    ]);
    expect(summary.scopes.daily.totalVisits).toBe(3);
    expect(summary.scopes.daily.totalVisitors).toBe(1);
    expect(summary.scopes.allTime.pages).toEqual([
      { path: "/home", slug: "home", title: "Home", visits: 2, visitors: 1 },
      { path: "/guide", slug: "guide", title: "Guide", visits: 1, visitors: 1 },
      { path: "/empty", slug: "empty", title: "Empty", visits: 0, visitors: 0 },
    ]);
  });

  it("prunes old period buckets while preserving all-time stats", () => {
    const stats = DEFAULT_VISITOR_STATS();

    for (let index = 0; index < 95; index += 1) {
      const visitedAt = new Date(Date.UTC(2026, 0, index + 1, 10));
      recordVisitorInStats(stats, { path: "/home", slug: "home", title: "Home" }, `visitor-${index}`, visitedAt);
    }

    expect(Object.keys(stats.daily)).toHaveLength(90);
    expect(stats.daily["2026-01-01"]).toBeUndefined();
    expect(stats.daily["2026-04-05"]).toBeDefined();
    expect(Object.keys(stats.allTimeDaily)).toHaveLength(95);
    expect(stats.allTimeDaily["2026-01-01"]).toBeDefined();
    expect(stats.allTimeDaily["2026-04-05"]).toBeDefined();
    expect(stats.allTime.visits).toBe(95);
    expect(stats.allTime.visitorIds).toHaveLength(95);

    const summary = createVisitorStatsSummary(stats, new Date("2026-04-05T10:00:00.000Z"));
    expect(summary.scopes.allTime.periods).toHaveLength(95);
    expect(summary.scopes.allTime.periods[0]).toMatchObject({ key: "2026-01-01", visits: 1, visitors: 1 });
  });
});
