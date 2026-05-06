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
    expect(stats.visits).toHaveLength(3);
    expect(stats.visits[0]).toMatchObject({
      path: "/home",
      slug: "home",
      title: "Home",
      visitorId: "visitor-a",
      visitedAt: "2026-05-05T10:00:00.000Z",
    });

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
    expect(summary.scopes.daily.periods).toHaveLength(24);
    expect(summary.scopes.daily.periods[0]).toEqual({
      key: "2026-05-04T11",
      label: "11:00",
      visits: 0,
      visitors: 0,
      current: false,
    });
    expect(summary.scopes.daily.periods.at(-1)).toEqual({
      key: "2026-05-05T10",
      label: "10:00",
      visits: 3,
      visitors: 1,
      current: true,
    });
    expect(summary.scopes.weekly.totalVisits).toBe(3);
    expect(summary.scopes.weekly.totalVisitors).toBe(1);
    expect(summary.scopes.weekly.periods).toHaveLength(7);
    expect(summary.scopes.weekly.periods[0]).toEqual({
      key: "2026-04-29",
      label: "Apr 29",
      visits: 0,
      visitors: 0,
      current: false,
    });
    expect(summary.scopes.weekly.periods.at(-1)).toEqual({
      key: "2026-05-05",
      label: "May 5",
      visits: 3,
      visitors: 1,
      current: true,
    });
    expect(summary.scopes.monthly.totalVisits).toBe(3);
    expect(summary.scopes.monthly.totalVisitors).toBe(1);
    expect(summary.scopes.monthly.periods).toHaveLength(30);
    expect(summary.scopes.monthly.periods[0]).toMatchObject({ key: "2026-04-06", visits: 0, visitors: 0 });
    expect(summary.scopes.monthly.periods.at(-1)).toMatchObject({ key: "2026-05-05", visits: 3, visitors: 1 });
    expect(summary.scopes.yearly.totalVisits).toBe(3);
    expect(summary.scopes.yearly.totalVisitors).toBe(1);
    expect(summary.scopes.yearly.periods).toHaveLength(365);
    expect(summary.scopes.yearly.periods[0]).toMatchObject({ key: "2025-05-06", visits: 0, visitors: 0 });
    expect(summary.scopes.yearly.periods.at(-1)).toMatchObject({ key: "2026-05-05", visits: 3, visitors: 1 });
    expect(summary.scopes.allTime.pages).toEqual([
      { path: "/home", slug: "home", title: "Home", visits: 2, visitors: 1 },
      { path: "/guide", slug: "guide", title: "Guide", visits: 1, visitors: 1 },
      { path: "/empty", slug: "empty", title: "Empty", visits: 0, visitors: 0 },
    ]);
  });

  it("derives all ranges from raw visit timestamps", () => {
    const stats = DEFAULT_VISITOR_STATS();

    for (let index = 0; index < 95; index += 1) {
      const visitedAt = new Date(Date.UTC(2026, 0, index + 1, 10));
      recordVisitorInStats(stats, { path: "/home", slug: "home", title: "Home" }, `visitor-${index}`, visitedAt);
    }

    expect(stats.visits).toHaveLength(95);

    const summary = createVisitorStatsSummary(stats, new Date("2026-04-05T10:00:00.000Z"));
    expect(summary.scopes.allTime.totalVisits).toBe(95);
    expect(summary.scopes.allTime.totalVisitors).toBe(95);
    expect(summary.scopes.allTime.periods).toHaveLength(95);
    expect(summary.scopes.allTime.periods[0]).toMatchObject({ key: "2026-01-01", visits: 1, visitors: 1 });
    expect(summary.scopes.daily.totalVisits).toBe(1);
    expect(summary.scopes.daily.totalVisitors).toBe(1);
    expect(summary.scopes.daily.periods).toHaveLength(24);
    expect(summary.scopes.daily.periods.at(-1)).toMatchObject({ key: "2026-04-05T10", visits: 1, visitors: 1 });
    expect(summary.scopes.weekly.totalVisits).toBe(7);
    expect(summary.scopes.weekly.totalVisitors).toBe(7);
    expect(summary.scopes.weekly.periods).toHaveLength(7);
    expect(summary.scopes.weekly.periods[0]).toMatchObject({ key: "2026-03-30", visits: 1, visitors: 1 });
    expect(summary.scopes.weekly.periods.at(-1)).toMatchObject({ key: "2026-04-05", visits: 1, visitors: 1 });
    expect(summary.scopes.monthly.totalVisits).toBe(30);
    expect(summary.scopes.monthly.totalVisitors).toBe(30);
    expect(summary.scopes.monthly.periods).toHaveLength(30);
    expect(summary.scopes.monthly.periods[0]).toMatchObject({ key: "2026-03-07", visits: 1, visitors: 1 });
    expect(summary.scopes.monthly.periods.at(-1)).toMatchObject({ key: "2026-04-05", visits: 1, visitors: 1 });
    expect(summary.scopes.yearly.totalVisits).toBe(95);
    expect(summary.scopes.yearly.totalVisitors).toBe(95);
    expect(summary.scopes.yearly.periods).toHaveLength(365);
    expect(summary.scopes.yearly.periods[0]).toMatchObject({ key: "2025-04-06", visits: 0, visitors: 0 });
    expect(summary.scopes.yearly.periods.at(-1)).toMatchObject({ key: "2026-04-05", visits: 1, visitors: 1 });
  });
});
