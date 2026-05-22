import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getVisitorAnalyticsSalt,
  loadVisitorStatsSummary,
  recordVisitorEvent,
  resetVisitorAnalyticsStorageForTests,
} from "@/lib/visitor-storage";

describe("visitor SQLite storage", () => {
  const previousDbPath = process.env.WIKI_ANALYTICS_DB_PATH;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-analytics-"));
    process.env.WIKI_ANALYTICS_DB_PATH = path.join(tempDir, "analytics.sqlite");
    resetVisitorAnalyticsStorageForTests();
  });

  afterEach(async () => {
    resetVisitorAnalyticsStorageForTests();
    if (previousDbPath === undefined) {
      delete process.env.WIKI_ANALYTICS_DB_PATH;
    } else {
      process.env.WIKI_ANALYTICS_DB_PATH = previousDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("records visits and summarizes bounded ranges without the JSON store", async () => {
    const salt = await getVisitorAnalyticsSalt();
    expect(await getVisitorAnalyticsSalt()).toBe(salt);

    await recordVisitorEvent({
      page: { path: "/home", slug: "home", title: "Home" },
      visitorId: "visitor-a",
      visitedAt: new Date("2026-05-05T10:00:00.000Z"),
    });
    await recordVisitorEvent({
      page: { path: "/home", slug: "home", title: "Home" },
      visitorId: "visitor-a",
      visitedAt: new Date("2026-05-05T10:05:00.000Z"),
    });
    await recordVisitorEvent({
      page: { path: "/guide", slug: "guide", title: "Guide" },
      visitorId: "visitor-b",
      visitedAt: new Date("2026-05-05T09:00:00.000Z"),
    });

    const summary = await loadVisitorStatsSummary(new Date("2026-05-05T10:00:00.000Z"), [
      { path: "/empty", slug: "empty", title: "Empty" },
    ]);

    expect(summary.scopes.allTime.totalVisits).toBe(3);
    expect(summary.scopes.allTime.totalVisitors).toBe(2);
    expect(summary.scopes.daily.totalVisits).toBe(3);
    expect(summary.scopes.daily.periods.at(-1)).toMatchObject({
      key: "2026-05-05T10",
      visits: 2,
      visitors: 1,
    });
    expect(summary.scopes.allTime.pages).toEqual([
      { path: "/home", slug: "home", title: "Home", visits: 2, visitors: 1 },
      { path: "/guide", slug: "guide", title: "Guide", visits: 1, visitors: 1 },
      { path: "/empty", slug: "empty", title: "Empty", visits: 0, visitors: 0 },
    ]);
  });

  it("deduplicates repeated page-view events for the same visitor", async () => {
    const firstRecorded = await recordVisitorEvent({
      eventId: "page-view-1",
      page: { path: "/home", slug: "home", title: "Home" },
      visitorId: "visitor-a",
      visitedAt: new Date("2026-05-05T10:00:00.000Z"),
    });
    const duplicateRecorded = await recordVisitorEvent({
      eventId: "page-view-1",
      page: { path: "/home", slug: "home", title: "Home" },
      visitorId: "visitor-a",
      visitedAt: new Date("2026-05-05T10:01:00.000Z"),
    });
    const otherVisitorRecorded = await recordVisitorEvent({
      eventId: "page-view-1",
      page: { path: "/home", slug: "home", title: "Home" },
      visitorId: "visitor-b",
      visitedAt: new Date("2026-05-05T10:02:00.000Z"),
    });

    const summary = await loadVisitorStatsSummary(new Date("2026-05-05T10:03:00.000Z"));

    expect(firstRecorded).toBe(true);
    expect(duplicateRecorded).toBe(false);
    expect(otherVisitorRecorded).toBe(true);
    expect(summary.scopes.allTime.totalVisits).toBe(2);
    expect(summary.scopes.allTime.totalVisitors).toBe(2);
    expect(summary.scopes.allTime.pages).toEqual([
      { path: "/home", slug: "home", title: "Home", visits: 2, visitors: 2 },
    ]);
  });
});
