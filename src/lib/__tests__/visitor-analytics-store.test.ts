import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVisitorAnalyticsMaintenance } from "@/lib/visitor-analytics-maintenance.mjs";
import { openVisitorAnalyticsStore } from "@/lib/visitor-analytics-store.mjs";
import { createVisitorStatsSummary } from "@/lib/visitors";

import { createLegacyAnalyticsDatabase, createSampleVisits, expectSummaryToMatchVisits, SAMPLE_PAGES } from "./fixtures/visitor-analytics-samples";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T15:42:10.000Z");
const LEGACY_SALT = "legacy-salt";

type Store = ReturnType<typeof openVisitorAnalyticsStore>;

/** Drives maintenance like the worker does, reopening the database after a compaction. */
const runMaintenance = (initial: Store, nowMs: number, maxSteps = 100_000): Store => {
  let store = initial;
  let maintenance = createVisitorAnalyticsMaintenance(store, { warn: () => undefined });
  for (let steps = 0; steps < maxSteps; steps += 1) {
    const result = maintenance.step(nowMs);
    if (result.reopen) {
      store = openVisitorAnalyticsStore(store.dbPath);
      maintenance = createVisitorAnalyticsMaintenance(store, { warn: () => undefined });
    }
    if (!result.worked) {
      return store;
    }
  }
  throw new Error("Maintenance did not finish.");
};

/** Runs migration steps until at least `rows` old rows are folded (one fold step folds at most 8,192). */
const stepUntilLegacyRowsFolded = (maintenance: ReturnType<typeof createVisitorAnalyticsMaintenance>, rows: number): void => {
  for (let steps = 0; steps < 100 && (maintenance.progress()?.processed ?? 0) < rows; steps += 1) {
    maintenance.step(NOW);
  }
};

const summaryAt = (store: Store, nowMs: number) => createVisitorStatsSummary(store.computeSummary(nowMs), []);

const count = (store: Store, sql: string): number => store.db.prepare(sql).pluck().get() as number;

const indexNames = (store: Store): string[] => store.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").pluck().all() as string[];

describe("visitor analytics store", () => {
  let tempDir = "";
  let dbPath = "";
  let store: Store | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-analytics-store-"));
    dbPath = path.join(tempDir, "analytics.sqlite");
  });

  afterEach(async () => {
    store?.close();
    store = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps every window equal to direct counts before and after old rows are pruned", () => {
    const visits = createSampleVisits(NOW);
    store = openVisitorAnalyticsStore(dbPath);
    for (let index = 0; index < visits.length; index += 400) {
      store.recordVisits(visits.slice(index, index + 400), NOW);
    }

    expect(count(store, "SELECT COUNT(*) FROM analytics_visits")).toBe(visits.length);
    expectSummaryToMatchVisits(summaryAt(store, NOW), visits, NOW, expect);

    store = runMaintenance(store, NOW);
    const retainedFrom = (Math.floor(NOW / MS_PER_DAY) - 365) * MS_PER_DAY;
    const retained = visits.filter((visit) => visit.visitedAt >= retainedFrom);
    expect(retained.length).toBeLessThan(visits.length);
    expect(count(store, "SELECT COUNT(*) FROM analytics_visits")).toBe(retained.length);
    expect(count(store, "SELECT COUNT(*) FROM analytics_hour_visitors WHERE hour < " + (Math.floor(NOW / 3_600_000) - 48))).toBe(0);
    expectSummaryToMatchVisits(summaryAt(store, NOW), visits, NOW, expect);

    // The windows move with time; two days later every number still matches the sample.
    const later = NOW + 2 * MS_PER_DAY;
    store = runMaintenance(store, later);
    expectSummaryToMatchVisits(summaryAt(store, later), visits, later, expect);
  });

  it("counts a visitor again only after a year without visits", () => {
    const visits = createSampleVisits(NOW);
    const absentVisitor = "c".repeat(64);
    const recentVisitor = visits.at(-1)!.visitorId;
    store = openVisitorAnalyticsStore(dbPath);
    store.recordVisits([...visits, { eventId: "long-ago", page: SAMPLE_PAGES[0], visitedAt: NOW - 400 * MS_PER_DAY, visitorId: absentVisitor }], NOW);
    const before = store.computeSummary(NOW).allTime.visitors;
    expect(before).toBe(new Set(visits.map((visit) => visit.visitorId)).size + 1);

    store = runMaintenance(store, NOW);
    expect(store.computeSummary(NOW).allTime.visitors).toBe(before);
    store.recordVisits([
      { eventId: "returning-recent", page: SAMPLE_PAGES[0], visitedAt: NOW, visitorId: recentVisitor },
      { eventId: "returning-absent", page: SAMPLE_PAGES[0], visitedAt: NOW, visitorId: absentVisitor },
    ], NOW);
    expect(store.computeSummary(NOW).allTime.visitors).toBe(before + 1);
  });

  it("deduplicates events per visitor and stores each batch in one transaction", () => {
    store = openVisitorAnalyticsStore(dbPath);
    const visitorA = "a".repeat(64);
    const visitorB = "b".repeat(64);
    const page = SAMPLE_PAGES[1];

    expect(store.recordVisits([
      { eventId: "view-1", page, visitedAt: NOW - 1_000, visitorId: visitorA },
      { eventId: "view-1", page, visitedAt: NOW - 900, visitorId: visitorA },
      { eventId: "view-1", page, visitedAt: NOW - 800, visitorId: visitorB },
      { eventId: null, page, visitedAt: NOW - 700, visitorId: visitorB },
    ], NOW)).toEqual({ duplicates: 1, recorded: 3 });
    expect(store.recordVisits([{ eventId: "view-1", page, visitedAt: NOW, visitorId: visitorA }], NOW)).toEqual({ duplicates: 1, recorded: 0 });

    const transaction = vi.spyOn(store.db, "transaction");
    store.recordVisits(Array.from({ length: 50 }, (_, index) => ({ eventId: `batch-${index}`, page, visitedAt: NOW, visitorId: visitorA })), NOW);
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockRestore();

    const summary = summaryAt(store, NOW);
    expect(summary.scopes.daily).toMatchObject({ totalVisits: 53, totalVisitors: 2 });
    expect(summary.scopes.allTime.pages).toEqual([{ ...page, visits: 53, visitors: 2 }]);
  });

  it("migrates a database of the earlier schema with live visits and duplicates arriving meanwhile", () => {
    const visits = createSampleVisits(NOW, { count: 12_000, salt: LEGACY_SALT });
    const legacyVisits = visits.slice(0, -40);
    const liveVisits = visits.slice(-40);
    createLegacyAnalyticsDatabase(dbPath, legacyVisits, LEGACY_SALT);

    store = openVisitorAnalyticsStore(dbPath);
    expect(store.salt).toBe(LEGACY_SALT);
    const maintenance = createVisitorAnalyticsMaintenance(store, { warn: () => undefined });
    stepUntilLegacyRowsFolded(maintenance, 1);
    expect(store.legacy.active).toBe(true);
    expect(maintenance.progress()).toMatchObject({ total: legacyVisits.length });
    expect(maintenance.progress()!.processed).toBeLessThan(legacyVisits.length);

    const legacyDuplicate = legacyVisits.at(-1)!;
    expect(store.recordVisits([...liveVisits, { ...legacyDuplicate, visitedAt: NOW }], NOW)).toEqual({ duplicates: 1, recorded: liveVisits.length });
    expect(createVisitorStatsSummary(store.computeSummary(NOW)).scopes.allTime.totalVisits).toBeLessThan(visits.length);

    store = runMaintenance(store, NOW);
    expect(store.legacy.active).toBe(false);
    expect(store.isCaughtUp()).toBe(true);
    expect(store.db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('visitor_events', 'visitor_pages')").all()).toEqual([]);
    expect(indexNames(store)).toEqual(["analytics_page_visitors_last_hour_idx", "analytics_visitors_last_hour_idx"]);
    expect(store.db.pragma("auto_vacuum", { simple: true })).toBe(2);
    expect(store.salt).toBe(LEGACY_SALT);
    expect(store.computeSummary(NOW).complete).toBe(true);
    expectSummaryToMatchVisits(summaryAt(store, NOW), visits, NOW, expect);

    // An event of today or yesterday is still a duplicate after the migration.
    expect(store.recordVisits([{ ...legacyVisits.at(-2)!, visitedAt: NOW }], NOW)).toEqual({ duplicates: 1, recorded: 0 });
  });

  it("resumes an interrupted migration without counting a visit twice", () => {
    const visits = createSampleVisits(NOW, { count: 12_000, salt: LEGACY_SALT });
    createLegacyAnalyticsDatabase(dbPath, visits, LEGACY_SALT);

    // Stops twice: once right after the migration started, once after a part of the old rows.
    store = openVisitorAnalyticsStore(dbPath);
    createVisitorAnalyticsMaintenance(store, { warn: () => undefined }).step(NOW);
    store.close();
    store = openVisitorAnalyticsStore(dbPath);
    stepUntilLegacyRowsFolded(createVisitorAnalyticsMaintenance(store, { warn: () => undefined }), 1);
    store.close();

    const partial = new Database(dbPath, { readonly: true });
    const folded = Number(partial.prepare("SELECT value FROM analytics_meta WHERE key = 'migration_done'").pluck().get());
    partial.close();
    expect(folded).toBeGreaterThan(0);
    expect(folded).toBeLessThan(visits.length);

    store = runMaintenance(openVisitorAnalyticsStore(dbPath), NOW);
    expect(store.legacy.active).toBe(false);
    expectSummaryToMatchVisits(summaryAt(store, NOW), visits, NOW, expect);
  });
});
