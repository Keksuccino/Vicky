import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getVisitorAnalyticsSalt,
  loadVisitorAnalytics,
  recordVisitorEvents,
  resetVisitorAnalyticsStorageForTests,
} from "@/lib/visitor-storage";
import { createVisitorStatsSummary } from "@/lib/visitors";

import { createLegacyAnalyticsDatabase, createSampleVisits, expectSummaryToMatchVisits } from "./fixtures/visitor-analytics-samples";

const WORKER_SCRIPT = path.join(process.cwd(), "src", "lib", "visitor-analytics-worker.mjs");
const page = { path: "/home", slug: "home", title: "Home" };

/** Asks for numbers until the worker reports that every stored visit is part of them. */
const waitForCompleteNumbers = async () => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await loadVisitorAnalytics();
    if (snapshot.summary?.complete && !snapshot.progress) {
      return snapshot.summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The analytics worker did not catch up.");
};

describe("visitor analytics worker", () => {
  const previousDbPath = process.env.WIKI_ANALYTICS_DB_PATH;
  let tempDir = "";
  let dbPath = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-analytics-"));
    dbPath = path.join(tempDir, "analytics.sqlite");
    process.env.WIKI_ANALYTICS_DB_PATH = dbPath;
    await resetVisitorAnalyticsStorageForTests();
  });

  afterEach(async () => {
    await resetVisitorAnalyticsStorageForTests();
    vi.restoreAllMocks();
    if (previousDbPath === undefined) {
      delete process.env.WIKI_ANALYTICS_DB_PATH;
    } else {
      process.env.WIKI_ANALYTICS_DB_PATH = previousDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("records batches off the main thread and keeps the database files private", async () => {
    const salt = await getVisitorAnalyticsSalt();
    expect(await getVisitorAnalyticsSalt()).toBe(salt);

    const now = Date.now();
    expect(await recordVisitorEvents([
      { eventId: "view-1", page, visitedAt: now - 2_000, visitorId: "a".repeat(64) },
      { eventId: "view-1", page, visitedAt: now - 1_000, visitorId: "a".repeat(64) },
      { eventId: "view-2", page, visitedAt: now, visitorId: "b".repeat(64) },
    ])).toEqual({ duplicates: 1, recorded: 2 });

    const snapshot = await loadVisitorAnalytics();
    expect(snapshot).toMatchObject({ error: null, progress: null, refreshing: false });
    const summary = createVisitorStatsSummary(snapshot.summary!);
    expect(summary.scopes.daily).toMatchObject({ totalVisits: 2, totalVisitors: 2 });
    expect(summary.scopes.allTime.pages).toEqual([{ ...page, visits: 2, visitors: 2 }]);

    // Recent numbers are served from memory.
    const cached = await loadVisitorAnalytics();
    expect(cached.summary).toBe(snapshot.summary);

    if (process.platform !== "win32") {
      const sqliteFiles = (await readdir(tempDir)).filter((fileName) => fileName.startsWith("analytics.sqlite"));
      expect(sqliteFiles).toEqual(expect.arrayContaining(["analytics.sqlite", "analytics.sqlite-shm", "analytics.sqlite-wal"]));
      expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
      await Promise.all(sqliteFiles.map(async (fileName) => expect((await stat(path.join(tempDir, fileName))).mode & 0o777).toBe(0o600)));

      // Permissions are verified whenever the worker opens the database.
      await resetVisitorAnalyticsStorageForTests();
      await chmod(tempDir, 0o755);
      await chmod(dbPath, 0o666);
      expect(await getVisitorAnalyticsSalt()).toBe(salt);
      expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("migrates an earlier database in the background, also after the worker was killed halfway", async () => {
    const now = Date.now();
    const visits = createSampleVisits(now, { count: 12_000, salt: "legacy-salt" });
    createLegacyAnalyticsDatabase(dbPath, visits, "legacy-salt");

    // The production worker, killed as soon as the first old rows are folded.
    const worker = new Worker(WORKER_SCRIPT, { workerData: { dbPath } });
    const observer = new Database(dbPath, { readonly: true, fileMustExist: true });
    const foldedRows = (): number => {
      try {
        return Number(observer.prepare("SELECT value FROM analytics_meta WHERE key = 'migration_done'").pluck().get() ?? 0);
      } catch {
        return 0;
      }
    };
    while (foldedRows() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await worker.terminate();
    observer.close();

    expect(await getVisitorAnalyticsSalt()).toBe("legacy-salt");
    const during = await loadVisitorAnalytics();
    expect(during.error).toBeNull();
    const liveVisit = { eventId: "live", page, visitedAt: Date.now(), visitorId: "f".repeat(64) };
    expect(await recordVisitorEvents([liveVisit])).toEqual({ duplicates: 0, recorded: 1 });

    const summary = await waitForCompleteNumbers();
    expectSummaryToMatchVisits(createVisitorStatsSummary(summary), [...visits, liveVisit], summary.computedAt, expect);
  });

  it("reports a database that cannot be opened as an error without waiting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The shared temp directory is never made private, so opening a database in it fails.
    process.env.WIKI_ANALYTICS_DB_PATH = path.join(os.tmpdir(), `vicky-analytics-${randomUUID()}.sqlite`);

    const started = Date.now();
    const snapshot = await loadVisitorAnalytics();
    expect(snapshot.summary).toBeNull();
    expect(snapshot.error).toEqual(expect.any(String));
    await expect(recordVisitorEvents([{ eventId: null, page, visitedAt: Date.now(), visitorId: "a".repeat(64) }])).rejects.toThrow();
    await expect(getVisitorAnalyticsSalt()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);

    process.env.WIKI_ANALYTICS_DB_PATH = dbPath;
    expect(await getVisitorAnalyticsSalt()).toEqual(expect.any(String));
  });

  it("rejects requests that are still waiting when the worker stops", async () => {
    await getVisitorAnalyticsSalt();
    const rejected = expect(recordVisitorEvents([{ eventId: "late", page, visitedAt: Date.now(), visitorId: "a".repeat(64) }])).rejects.toThrow();
    await resetVisitorAnalyticsStorageForTests();
    await rejected;
  });
});
