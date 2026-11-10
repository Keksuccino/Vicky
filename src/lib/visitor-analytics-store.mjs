/**
 * SQLite model of the visitor analytics database. Only the analytics worker thread
 * (`visitor-analytics-worker.mjs`) opens it, so no SQLite call ever runs on the thread that
 * serves requests; this file is plain JavaScript because the worker loads it unbundled.
 *
 * Every page view is one row in `analytics_visits` (time, page, visitor), kept for
 * `RETENTION_DAYS` days. Statistics never scan those rows. They are folded into aggregates when
 * they are written:
 *
 * - `analytics_daily` / `analytics_daily_pages`: visits per UTC day (and per page), plus the
 *   unique visitors of each day. Kept forever: they are the all-time chart and history.
 * - `analytics_hourly` / `analytics_hourly_pages`: the same per UTC hour for the last
 *   `HOURLY_HORIZON_HOURS` hours (the summary shows 24).
 * - `analytics_visitors` / `analytics_page_visitors`: the most recent hour each visitor was
 *   seen, overall and per page. Every summary window ends now, so the unique visitors of a
 *   window are exactly the rows whose `last_hour` lies inside it: an index range count.
 * - `analytics_day_visitors` / `analytics_hour_visitors`: which visitors were already counted
 *   for a recent day or hour, so per-period unique counts stay exact in any arrival order.
 *   Rows older than the next visit that can still arrive are pruned.
 * - `analytics_pages`: page identity plus all-time visits and unique visitors per page.
 * - `analytics_recent_events`: event IDs of today and yesterday per visitor, which makes a
 *   repeated page-view event a duplicate. Clients only repeat an event within seconds, so
 *   older event IDs are dropped instead of being indexed for a year.
 *
 * All-time unique visitors are counted when a visitor row is created. Visitor rows not seen
 * for `RETENTION_DAYS` days are pruned with the raw rows, so a visitor who returns after more
 * than a year away counts again; every window up to 365 days stays exact.
 */
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./runtime-file-security.mjs";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Raw visit rows and per-visitor recency rows older than this many days are pruned. */
export const RETENTION_DAYS = 365;
/** Hourly aggregates cover this many hours before now. */
export const HOURLY_HORIZON_HOURS = 48;
export const SCHEMA_VERSION = 2;
/** The recent-day windows of the summary, in days including today. */
export const RECENT_DAY_WINDOWS = [7, 30, 365];

const VISITOR_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Name of the database copy an interrupted compaction may leave beside the database. */
export const compactionTargetPath = (dbPath) => `${dbPath}.compact`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS analytics_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_pages (
    page_id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    visits INTEGER NOT NULL DEFAULT 0,
    visitors INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS analytics_visitors (
    visitor_key INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_hash BLOB NOT NULL UNIQUE,
    last_hour INTEGER
  );
  CREATE INDEX IF NOT EXISTS analytics_visitors_last_hour_idx ON analytics_visitors(last_hour);

  CREATE TABLE IF NOT EXISTS analytics_page_visitors (
    page_id INTEGER NOT NULL,
    visitor_key INTEGER NOT NULL,
    last_hour INTEGER NOT NULL,
    PRIMARY KEY (page_id, visitor_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS analytics_page_visitors_last_hour_idx ON analytics_page_visitors(page_id, last_hour);

  CREATE TABLE IF NOT EXISTS analytics_visits (
    visit_id INTEGER PRIMARY KEY,
    visited_at INTEGER NOT NULL,
    page_id INTEGER NOT NULL,
    visitor_key INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_recent_events (
    event_row INTEGER PRIMARY KEY,
    visitor_key INTEGER NOT NULL,
    event_key INTEGER NOT NULL,
    day INTEGER NOT NULL,
    UNIQUE (visitor_key, event_key)
  );

  CREATE TABLE IF NOT EXISTS analytics_daily (
    day INTEGER PRIMARY KEY,
    visits INTEGER NOT NULL,
    visitors INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_pages (
    day INTEGER NOT NULL,
    page_id INTEGER NOT NULL,
    visits INTEGER NOT NULL,
    PRIMARY KEY (day, page_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS analytics_hourly (
    hour INTEGER PRIMARY KEY,
    visits INTEGER NOT NULL,
    visitors INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_hourly_pages (
    hour INTEGER NOT NULL,
    page_id INTEGER NOT NULL,
    visits INTEGER NOT NULL,
    PRIMARY KEY (hour, page_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS analytics_day_visitors (
    day INTEGER NOT NULL,
    visitor_key INTEGER NOT NULL,
    PRIMARY KEY (day, visitor_key)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS analytics_hour_visitors (
    hour INTEGER NOT NULL,
    visitor_key INTEGER NOT NULL,
    PRIMARY KEY (hour, visitor_key)
  ) WITHOUT ROWID;
`;

export const toHour = (timestampMs) => Math.floor(timestampMs / HOUR_MS);

export const toDay = (timestampMs) => Math.floor(timestampMs / DAY_MS);

/** First day whose raw rows and visitor recency rows are kept. */
export const retentionStartDay = (nowMs) => toDay(nowMs) - RETENTION_DAYS;

/**
 * Visitor IDs are hex SHA-256 digests of the salted client address; they are stored as their
 * 32 raw bytes. Anything else is hashed so it still maps to one stable 32-byte key.
 */
export const visitorHashBytes = (visitorId) =>
  VISITOR_HASH_PATTERN.test(visitorId) ? Buffer.from(visitorId, "hex") : createHash("sha256").update(visitorId).digest();

/**
 * Event IDs only need to be compared per visitor, so their first 64 SHA-256 bits are stored
 * instead of the text. A false duplicate needs two of one visitor's events of the same two days
 * to collide in 64 bits, which is negligible.
 */
export const eventKeyFor = (eventId) => (eventId ? createHash("sha256").update(eventId).digest().readBigInt64BE(0) : null);

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));

const configureConnection = (db) => {
  // auto_vacuum can only be chosen before the first table exists. Incremental mode lets
  // retention give freed pages back to the file system in small steps.
  if (!db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
    db.pragma("auto_vacuum = INCREMENTAL");
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = OFF");
  db.pragma("journal_size_limit = 33554432");
  db.pragma("cache_size = -16384");
};

const ensurePrivateDatabaseFiles = (dbPath) => {
  // SQLite creates WAL/SHM files through native code rather than Node's file APIs. The
  // containing 0700 directory prevents exposure during creation; repairing every known
  // sidecar once the connection is in WAL mode then guarantees their steady-state mode.
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    ensurePrivateFileSync(filePath);
  }
};

const readMetaNumber = (statements, key, fallback) => {
  const value = statements.getMeta.get(key);
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const createStatements = (db) => ({
  getMeta: db.prepare("SELECT value FROM analytics_meta WHERE key = ?").pluck(),
  setMeta: db.prepare("INSERT INTO analytics_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  deleteMeta: db.prepare("DELETE FROM analytics_meta WHERE key = ?"),
  findPage: db.prepare("SELECT page_id AS id, path, title FROM analytics_pages WHERE slug = ?"),
  insertPage: db.prepare("INSERT INTO analytics_pages (slug, path, title) VALUES (?, ?, ?)"),
  updatePageIdentity: db.prepare("UPDATE analytics_pages SET path = ?, title = ? WHERE page_id = ?"),
  addPageTotals: db.prepare("UPDATE analytics_pages SET visits = visits + ?, visitors = visitors + ? WHERE page_id = ?"),
  findVisitor: db.prepare("SELECT visitor_key AS key, last_hour AS lastHour FROM analytics_visitors WHERE visitor_hash = ?"),
  insertVisitor: db.prepare("INSERT INTO analytics_visitors (visitor_hash, last_hour) VALUES (?, NULL)"),
  visitorLastHour: db.prepare("SELECT last_hour FROM analytics_visitors WHERE visitor_key = ?").pluck(),
  setVisitorLastHour: db.prepare("UPDATE analytics_visitors SET last_hour = ? WHERE visitor_key = ?"),
  insertPageVisitor: db.prepare("INSERT OR IGNORE INTO analytics_page_visitors (page_id, visitor_key, last_hour) VALUES (?, ?, ?)"),
  touchPageVisitor: db.prepare("UPDATE analytics_page_visitors SET last_hour = ? WHERE page_id = ? AND visitor_key = ? AND last_hour < ?"),
  insertDayVisitor: db.prepare("INSERT OR IGNORE INTO analytics_day_visitors (day, visitor_key) VALUES (?, ?)"),
  insertHourVisitor: db.prepare("INSERT OR IGNORE INTO analytics_hour_visitors (hour, visitor_key) VALUES (?, ?)"),
  addDaily: db.prepare("INSERT INTO analytics_daily (day, visits, visitors) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET visits = visits + excluded.visits, visitors = visitors + excluded.visitors"),
  addDailyPage: db.prepare("INSERT INTO analytics_daily_pages (day, page_id, visits) VALUES (?, ?, ?) ON CONFLICT(day, page_id) DO UPDATE SET visits = visits + excluded.visits"),
  addHourly: db.prepare("INSERT INTO analytics_hourly (hour, visits, visitors) VALUES (?, ?, ?) ON CONFLICT(hour) DO UPDATE SET visits = visits + excluded.visits, visitors = visitors + excluded.visitors"),
  addHourlyPage: db.prepare("INSERT INTO analytics_hourly_pages (hour, page_id, visits) VALUES (?, ?, ?) ON CONFLICT(hour, page_id) DO UPDATE SET visits = visits + excluded.visits"),
  insertVisit: db.prepare("INSERT OR IGNORE INTO analytics_visits (visit_id, visited_at, page_id, visitor_key) VALUES (?, ?, ?, ?)"),
  insertRecentEvent: db.prepare("INSERT OR IGNORE INTO analytics_recent_events (visitor_key, event_key, day) VALUES (?, ?, ?)"),
  maxVisitId: db.prepare("SELECT MAX(visit_id) FROM analytics_visits").pluck(),
  pendingVisits: db.prepare("SELECT visit_id AS id, visited_at AS visitedAt, page_id AS pageId, visitor_key AS visitorKey FROM analytics_visits WHERE visit_id > ? ORDER BY visit_id LIMIT ?"),
  summaryPages: db.prepare("SELECT page_id, slug, path, title, visits, visitors FROM analytics_pages ORDER BY page_id").raw(),
  summaryDays: db.prepare("SELECT day, visits, visitors FROM analytics_daily WHERE day <= ? ORDER BY day").raw(),
  summaryHours: db.prepare("SELECT hour, visits, visitors FROM analytics_hourly WHERE hour BETWEEN ? AND ? ORDER BY hour").raw(),
  summaryHourPageVisits: db.prepare("SELECT page_id, SUM(visits) FROM analytics_hourly_pages WHERE hour BETWEEN ? AND ? GROUP BY page_id").raw(),
  summaryDayPageVisits: db.prepare("SELECT page_id, SUM(visits) FROM analytics_daily_pages WHERE day BETWEEN ? AND ? GROUP BY page_id").raw(),
  summaryVisitorsSince: db.prepare("SELECT COUNT(*) FROM analytics_visitors WHERE last_hour BETWEEN ? AND ?").pluck(),
  summaryPageVisitorsSince: db.prepare(`
    SELECT p.page_id, (SELECT COUNT(*) FROM analytics_page_visitors v WHERE v.page_id = p.page_id AND v.last_hour BETWEEN ? AND ?)
    FROM analytics_pages p
  `).raw(),
});

const addCounts = (map, key, visits, visitors) => {
  const entry = map.get(key);
  if (entry) {
    entry[0] += visits;
    entry[1] += visitors;
  } else {
    map.set(key, [visits, visitors]);
  }
};

const addNestedVisits = (map, outerKey, innerKey) => {
  let inner = map.get(outerKey);
  if (!inner) {
    inner = new Map();
    map.set(outerKey, inner);
  }
  inner.set(innerKey, (inner.get(innerKey) ?? 0) + 1);
};

/**
 * Accumulates the aggregate changes of one transaction so each touched aggregate row is
 * written once per transaction instead of once per visit.
 */
const createFoldTotals = () => ({
  daily: new Map(),
  dailyPages: new Map(),
  hourly: new Map(),
  hourlyPages: new Map(),
  pages: new Map(),
  newVisitors: 0,
  lastVisitAt: 0,
});

/**
 * Opens the analytics database, verifying the private permissions of the database file and its
 * SQLite sidecars once per connection. Failing verification closes the connection and throws.
 *
 * @param {string} dbPath
 */
export function openVisitorAnalyticsStore(dbPath) {
  ensurePrivateDirectorySync(path.dirname(dbPath));
  ensurePrivateFileSync(dbPath);
  // A compaction that was interrupted before its final rename leaves only a disposable copy.
  rmSync(compactionTargetPath(dbPath), { force: true });
  rmSync(`${compactionTargetPath(dbPath)}-journal`, { force: true });

  const db = new Database(dbPath);
  try {
    configureConnection(db);
    db.exec(SCHEMA);
    ensurePrivateDatabaseFiles(dbPath);
    return createStore(db, dbPath);
  } catch (error) {
    if (db.open) {
      db.close();
    }
    throw error;
  }
}

const createStore = (db, dbPath) => {
  const statements = createStatements(db);
  const pageCache = new Map();
  // Rows of the earlier schema (`visitor_events`) wait for the migration in
  // `visitor-analytics-maintenance.mjs`; until it finishes, new events are also checked against
  // their event IDs.
  const legacy = { active: tableExists(db, "visitor_events"), eventExists: null };
  if (legacy.active && db.prepare("SELECT 1 FROM pragma_table_info('visitor_events') WHERE name = 'event_id'").get()) {
    legacy.eventExists = db.prepare("SELECT 1 FROM visitor_events WHERE visitor_id = ? AND event_id = ?").pluck();
  }

  const salt = db.transaction(() => {
    const existing = statements.getMeta.get("ip_hash_salt");
    if (existing) {
      return existing;
    }
    const created = randomUUID();
    statements.setMeta.run("ip_hash_salt", created);
    return created;
  })();
  if (!legacy.active && statements.getMeta.get("schema_version") !== String(SCHEMA_VERSION)) {
    statements.setMeta.run("schema_version", String(SCHEMA_VERSION));
  }

  // Persisted counters mirrored in memory. They change only after the transaction that writes
  // them commits, so a rolled-back write never leaves them ahead of the database.
  const state = {
    foldCursor: readMetaNumber(statements, "fold_cursor", 0),
    lastVisitAt: readMetaNumber(statements, "last_visit_at", 0),
    nextVisitId: 0,
    visitorsTotal: readMetaNumber(statements, "visitors_total", 0),
  };
  // Visit IDs only ever grow: the fold cursor relies on it, and old rows keep their earlier row
  // IDs when the migration copies them, so new visits are numbered above all of those.
  state.nextVisitId = Math.max(
    statements.maxVisitId.get() ?? 0,
    state.foldCursor,
    readMetaNumber(statements, "legacy_max_rowid", 0),
    legacy.active ? (db.prepare("SELECT MAX(rowid) FROM visitor_events").pluck().get() ?? 0) : 0,
  ) + 1;

  const resolvePageId = (page) => {
    const cached = pageCache.get(page.slug) ?? statements.findPage.get(page.slug);
    if (!cached) {
      const id = Number(statements.insertPage.run(page.slug, page.path, page.title).lastInsertRowid);
      pageCache.set(page.slug, { id, path: page.path, title: page.title });
      return id;
    }
    if (cached.path !== page.path || cached.title !== page.title) {
      statements.updatePageIdentity.run(page.path, page.title, cached.id);
    }
    pageCache.set(page.slug, { id: cached.id, path: page.path, title: page.title });
    return cached.id;
  };

  /** Returns the visitor's key and last folded hour (`null` until a visit of it is folded). */
  const resolveVisitor = (visitorHash) => {
    const existing = statements.findVisitor.get(visitorHash);
    return existing ?? { key: Number(statements.insertVisitor.run(visitorHash).lastInsertRowid), lastHour: null };
  };

  /**
   * Folds one stored visit into `totals` and the per-visitor recency/presence rows. Every
   * aggregate is a sum, a maximum, or a set insert, so the result does not depend on the order
   * in which visits are folded.
   *
   * @param {ReturnType<typeof createFoldTotals>} totals
   * @param {{ visitedAt: number, pageId: number, visitorKey: number, lastHour?: number | null }} visit
   * @param {number} nowHour
   */
  const foldVisit = (totals, visit, nowHour) => {
    const hour = toHour(visit.visitedAt);
    const day = toDay(visit.visitedAt);
    const lastHour = visit.lastHour !== undefined ? visit.lastHour : statements.visitorLastHour.get(visit.visitorKey);
    if (lastHour === null || lastHour === undefined) {
      totals.newVisitors += 1;
      statements.setVisitorLastHour.run(hour, visit.visitorKey);
    } else if (hour > lastHour) {
      statements.setVisitorLastHour.run(hour, visit.visitorKey);
    }

    const newPagePair = statements.insertPageVisitor.run(visit.pageId, visit.visitorKey, hour).changes;
    if (!newPagePair) {
      statements.touchPageVisitor.run(hour, visit.pageId, visit.visitorKey, hour);
    }
    addCounts(totals.pages, visit.pageId, 1, newPagePair);
    addCounts(totals.daily, day, 1, statements.insertDayVisitor.run(day, visit.visitorKey).changes);
    addNestedVisits(totals.dailyPages, day, visit.pageId);
    if (hour >= nowHour - HOURLY_HORIZON_HOURS) {
      addCounts(totals.hourly, hour, 1, statements.insertHourVisitor.run(hour, visit.visitorKey).changes);
      addNestedVisits(totals.hourlyPages, hour, visit.pageId);
    }
    totals.lastVisitAt = Math.max(totals.lastVisitAt, visit.visitedAt);
  };

  /** Writes accumulated totals; returns the counters to publish after the commit. */
  const applyFoldTotals = (totals, foldCursor) => {
    for (const [day, [visits, visitors]] of totals.daily) {
      statements.addDaily.run(day, visits, visitors);
    }
    for (const [day, pages] of totals.dailyPages) {
      for (const [pageId, visits] of pages) {
        statements.addDailyPage.run(day, pageId, visits);
      }
    }
    for (const [hour, [visits, visitors]] of totals.hourly) {
      statements.addHourly.run(hour, visits, visitors);
    }
    for (const [hour, pages] of totals.hourlyPages) {
      for (const [pageId, visits] of pages) {
        statements.addHourlyPage.run(hour, pageId, visits);
      }
    }
    for (const [pageId, [visits, visitors]] of totals.pages) {
      statements.addPageTotals.run(visits, visitors, pageId);
    }

    const next = {
      foldCursor: Math.max(state.foldCursor, foldCursor),
      lastVisitAt: Math.max(state.lastVisitAt, totals.lastVisitAt),
      visitorsTotal: state.visitorsTotal + totals.newVisitors,
    };
    statements.setMeta.run("fold_cursor", String(next.foldCursor));
    statements.setMeta.run("last_visit_at", String(next.lastVisitAt));
    statements.setMeta.run("visitors_total", String(next.visitorsTotal));
    return next;
  };

  /** Runs `work` in one transaction and publishes the counters it returns once it committed. */
  const commit = (work) => {
    try {
      const result = db.transaction(work)();
      Object.assign(state, result.state);
      return result.value;
    } catch (error) {
      // Page IDs cached during the rolled-back transaction may not exist.
      pageCache.clear();
      throw error;
    }
  };

  /** Whether every stored visit is folded and no legacy rows are waiting. */
  const isCaughtUp = () => !legacy.active && state.foldCursor >= state.nextVisitId - 1;

  return {
    db,
    dbPath,
    legacy,
    salt,
    state,
    statements,
    applyFoldTotals,
    commit,
    createFoldTotals,
    foldVisit,
    isCaughtUp,
    resolvePageId,
    resolveVisitor,

    /**
     * Stores one batch of visits in one transaction. While earlier visits still wait to be
     * folded, the batch is only stored and folded later in order of arrival.
     *
     * @param {Array<{ eventId: string | null, page: { slug: string, path: string, title: string }, visitedAt: number, visitorId: string }>} events
     * @param {number} nowMs
     */
    recordVisits(events, nowMs) {
      const nowHour = toHour(nowMs);
      const today = toDay(nowMs);
      const foldNow = isCaughtUp();
      return commit(() => {
        const totals = createFoldTotals();
        let nextVisitId = state.nextVisitId;
        let recorded = 0;
        for (const event of events) {
          if (legacy.eventExists && event.eventId && legacy.eventExists.get(event.visitorId, event.eventId)) {
            continue;
          }
          const visitor = resolveVisitor(visitorHashBytes(event.visitorId));
          if (event.eventId && !statements.insertRecentEvent.run(visitor.key, eventKeyFor(event.eventId), today).changes) {
            continue;
          }
          const pageId = resolvePageId(event.page);
          statements.insertVisit.run(nextVisitId, event.visitedAt, pageId, visitor.key);
          if (foldNow) {
            foldVisit(totals, { visitedAt: event.visitedAt, pageId, visitorKey: visitor.key, lastHour: visitor.lastHour }, nowHour);
          }
          nextVisitId += 1;
          recorded += 1;
        }
        const counters = foldNow ? applyFoldTotals(totals, nextVisitId - 1) : {};
        return { state: { ...counters, nextVisitId }, value: { duplicates: events.length - recorded, recorded } };
      });
    },

    /**
     * Folds up to `limit` stored visits that arrived while earlier ones were still waiting.
     *
     * @returns {number} The number of visits folded.
     */
    foldPendingVisits(nowMs, limit) {
      const nowHour = toHour(nowMs);
      return commit(() => {
        const rows = statements.pendingVisits.all(state.foldCursor, limit);
        if (rows.length === 0) {
          return { state: {}, value: 0 };
        }
        const totals = createFoldTotals();
        for (const row of rows) {
          foldVisit(totals, row, nowHour);
        }
        return { state: applyFoldTotals(totals, rows.at(-1).id), value: rows.length };
      });
    },

    /**
     * Reads every number the admin summary needs from the aggregates in one read transaction.
     * The cost depends on the number of pages, days, and visitors of the last year, never on
     * the number of stored visits.
     *
     * @param {number} nowMs
     */
    computeSummary(nowMs) {
      const nowHour = toHour(nowMs);
      const today = toDay(nowMs);
      return db.transaction(() => {
        const pages = statements.summaryPages.all();
        const firstHour = nowHour - 23;
        return {
          computedAt: nowMs,
          lastVisitAt: state.lastVisitAt || null,
          complete: isCaughtUp(),
          pages: pages.map(([id, slug, pagePath, title]) => [id, slug, pagePath, title]),
          allTime: {
            visitors: state.visitorsTotal,
            days: statements.summaryDays.all(today),
            pages: pages.map(([id, , , , visits, visitors]) => [id, visits, visitors]),
          },
          last24Hours: {
            visitors: statements.summaryVisitorsSince.get(firstHour, nowHour),
            hours: statements.summaryHours.all(firstHour, nowHour),
            pageVisits: statements.summaryHourPageVisits.all(firstHour, nowHour),
            pageVisitors: statements.summaryPageVisitorsSince.all(firstHour, nowHour),
          },
          recentDays: RECENT_DAY_WINDOWS.map((dayCount) => {
            const firstDay = today - dayCount + 1;
            return {
              dayCount,
              visitors: statements.summaryVisitorsSince.get(firstDay * 24, nowHour),
              pageVisits: statements.summaryDayPageVisits.all(firstDay, today),
              pageVisitors: statements.summaryPageVisitorsSince.all(firstDay * 24, nowHour),
            };
          }),
        };
      })();
    },

    close() {
      if (db.open) {
        db.close();
      }
    },
  };
};
