import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openVisitorAnalyticsStore } from "@/lib/visitor-analytics-store.mjs";
import { createVisitorStatsSummary, loadVisitorStats, setVisitorStorageLoaderForTests } from "@/lib/visitors";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HOME = { path: "/home", slug: "home", title: "Home" };
const GUIDE = { path: "/guide", slug: "guide", title: "Guide" };

describe("visitor stats summary", () => {
  let tempDir = "";
  let store: ReturnType<typeof openVisitorAnalyticsStore> | null = null;

  const openStore = () => {
    store = openVisitorAnalyticsStore(path.join(tempDir, "analytics.sqlite"));
    return store;
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-visitors-"));
  });

  afterEach(async () => {
    store?.close();
    store = null;
    setVisitorStorageLoaderForTests(null);
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("counts visits while keeping unique visitors deduped per scope and page", () => {
    const visitedAt = Date.parse("2026-05-05T10:00:00.000Z");
    const visitor = "a".repeat(64);
    const analytics = openStore();
    analytics.recordVisits([
      { eventId: "1", page: HOME, visitedAt, visitorId: visitor },
      { eventId: "2", page: HOME, visitedAt, visitorId: visitor },
      { eventId: "3", page: GUIDE, visitedAt, visitorId: visitor },
    ], visitedAt);

    const summary = createVisitorStatsSummary(analytics.computeSummary(visitedAt), [HOME, GUIDE, { path: "/empty", slug: "empty", title: "Empty" }]);

    expect(summary.computedAt).toBe("2026-05-05T10:00:00.000Z");
    expect(summary.updatedAt).toBe("2026-05-05T10:00:00.000Z");
    expect(summary.scopes.allTime).toMatchObject({ totalVisits: 3, totalVisitors: 1 });
    expect(summary.scopes.allTime.periods).toEqual([expect.objectContaining({ key: "2026-05-05", visits: 3, visitors: 1, current: true })]);
    expect(summary.scopes.daily).toMatchObject({ totalVisits: 3, totalVisitors: 1 });
    expect(summary.scopes.daily.periods).toHaveLength(24);
    expect(summary.scopes.daily.periods[0]).toMatchObject({ key: "2026-05-04T11", visits: 0, visitors: 0, current: false });
    expect(summary.scopes.daily.periods.at(-1)).toMatchObject({ key: "2026-05-05T10", visits: 3, visitors: 1, current: true });
    expect(summary.scopes.weekly.periods).toHaveLength(7);
    expect(summary.scopes.weekly.periods[0]).toMatchObject({ key: "2026-04-29", visits: 0, visitors: 0, current: false });
    expect(summary.scopes.weekly.periods.at(-1)).toMatchObject({ key: "2026-05-05", visits: 3, visitors: 1, current: true });
    expect(summary.scopes.monthly.periods).toHaveLength(30);
    expect(summary.scopes.monthly.periods[0]).toMatchObject({ key: "2026-04-06", visits: 0 });
    expect(summary.scopes.yearly.periods).toHaveLength(365);
    expect(summary.scopes.yearly.periods[0]).toMatchObject({ key: "2025-05-06", visits: 0 });
    for (const scope of ["weekly", "monthly", "yearly"] as const) {
      expect(summary.scopes[scope]).toMatchObject({ totalVisits: 3, totalVisitors: 1 });
    }
    expect(summary.scopes.allTime.pages).toEqual([
      { ...HOME, visits: 2, visitors: 1 },
      { ...GUIDE, visits: 1, visitors: 1 },
      { path: "/empty", slug: "empty", title: "Empty", visits: 0, visitors: 0 },
    ]);
  });

  it("derives every range from the visit timestamps", () => {
    const analytics = openStore();
    const now = Date.parse("2026-04-05T10:00:00.000Z");
    analytics.recordVisits(Array.from({ length: 95 }, (_, index) => ({
      eventId: `event-${index}`,
      page: HOME,
      visitedAt: Date.UTC(2026, 0, index + 1, 10),
      visitorId: index.toString(16).padStart(64, "0"),
    })), now);

    const summary = createVisitorStatsSummary(analytics.computeSummary(now));
    expect(summary.scopes.allTime).toMatchObject({ totalVisits: 95, totalVisitors: 95 });
    expect(summary.scopes.allTime.periods).toHaveLength(95);
    expect(summary.scopes.allTime.periods[0]).toMatchObject({ key: "2026-01-01", visits: 1, visitors: 1 });
    expect(summary.scopes.daily).toMatchObject({ totalVisits: 1, totalVisitors: 1 });
    expect(summary.scopes.weekly).toMatchObject({ totalVisits: 7, totalVisitors: 7 });
    expect(summary.scopes.weekly.periods[0]).toMatchObject({ key: "2026-03-30", visits: 1, visitors: 1 });
    expect(summary.scopes.monthly).toMatchObject({ totalVisits: 30, totalVisitors: 30 });
    expect(summary.scopes.monthly.periods[0]).toMatchObject({ key: "2026-03-07", visits: 1, visitors: 1 });
    expect(summary.scopes.yearly).toMatchObject({ totalVisits: 95, totalVisitors: 95 });
    expect(summary.scopes.yearly.periods[0]).toMatchObject({ key: "2025-04-06", visits: 0, visitors: 0 });
  });

  it("limits all-time chart periods to 150 evenly spaced points", () => {
    const analytics = openStore();
    const now = Date.UTC(2026, 0, 300, 10);
    analytics.recordVisits(Array.from({ length: 300 }, (_, index) => ({
      eventId: `event-${index}`,
      page: HOME,
      visitedAt: Date.UTC(2026, 0, index + 1, 10),
      visitorId: index.toString(16).padStart(64, "0"),
    })), now);

    const allTimePeriods = createVisitorStatsSummary(analytics.computeSummary(now)).scopes.allTime.periods;
    const dayNumbers = allTimePeriods.map((period) => Date.parse(`${period.key}T00:00:00.000Z`) / MS_PER_DAY);
    const dayGaps = dayNumbers.slice(1).map((dayNumber, index) => dayNumber - dayNumbers[index]);

    expect(allTimePeriods).toHaveLength(150);
    expect(allTimePeriods[0]).toMatchObject({ key: "2026-01-01", visits: 1, visitors: 1 });
    expect(allTimePeriods[1]).toMatchObject({ key: "2026-01-03", visits: 1, visitors: 1 });
    expect(allTimePeriods.at(-1)).toMatchObject({ key: "2026-10-27", visits: 1, visitors: 1 });
    expect(Math.min(...dayGaps)).toBe(2);
    expect(Math.max(...dayGaps)).toBe(3);
  });

  it("reports unavailable analytics storage as an error instead of empty numbers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setVisitorStorageLoaderForTests(async () => {
      throw new Error("native module unavailable");
    });

    const response = await loadVisitorStats([{ path: "/known", slug: "known", title: "Known Page" }]);

    expect(response.stats).toBeNull();
    expect(response.status).toMatchObject({ catchingUp: null, refreshing: false });
    expect(response.status.error).toEqual(expect.any(String));
  });
});
