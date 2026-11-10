/**
 * Background maintenance of the analytics database, run by the analytics worker one short step
 * at a time between requests:
 *
 * 1. Migrating a database of the earlier schema (one `visitor_events` row per visit with nine
 *    indexes): drop the indexes no query needs, then fold the old rows into the aggregates
 *    oldest first, copying those inside the retention window into `analytics_visits`. The
 *    position of the last folded row is stored in the same transaction as its aggregates, so
 *    the migration resumes wherever it stopped and never counts a row twice. Old rows are not
 *    deleted one by one: two of the old indexes have random keys, so every deletion would
 *    rewrite pages all over the file. Dropping the whole table at the end frees its pages in
 *    one pass instead.
 * 2. Folding visits recorded while the migration ran.
 * 3. Retention once per UTC day: raw rows and visitor recency rows older than the retention
 *    window, and hourly/presence rows outside their horizon.
 * 4. Giving free pages back to the file system. A database created before incremental
 *    auto-vacuum existed is compacted once with `VACUUM INTO` a copy beside it and an atomic
 *    rename; this needs free disk space for the live data only, not for the whole file.
 *    Afterwards `incremental_vacuum` releases freed pages in small steps.
 *
 * Each step is one transaction bounded by a time budget, or one statement that is announced as
 * long through `onLongStep` first. An interrupted step rolls back and runs again.
 */
import { existsSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ensurePrivateFileSync } from "./runtime-file-security.mjs";
import { compactionTargetPath, DAY_MS, eventKeyFor, HOURLY_HORIZON_HOURS, retentionStartDay, SCHEMA_VERSION, toDay, toHour, visitorHashBytes } from "./visitor-analytics-store.mjs";

/** Indexes of the earlier schema that no remaining query uses. */
const LEGACY_REDUNDANT_INDEXES = [
  "visitor_events_visited_day_idx",
  "visitor_events_visited_hour_idx",
  "visitor_events_page_visited_at_idx",
  "visitor_events_day_page_visitor_idx",
  "visitor_events_hour_page_visitor_idx",
  "visitor_events_page_visitor_idx",
];
/** Orders the old rows for the migration; dropped with the old table. */
const LEGACY_ORDER_INDEX = "visitor_events_visited_at_idx";
const LEGACY_REQUIRED_COLUMNS = ["page_slug", "visitor_id", "visited_at"];

// Folding commits rewrite every page they touched, and the visitor tables are updated at random
// keys, so few large transactions write far less than many small ones (8,192 rows per commit
// fold about 13 times faster than 512 on an external SSD). A step holds the worker for at most
// about `FOLD_STEP_BUDGET_MS`; requests are answered between steps.
const FOLD_STEP_BUDGET_MS = 200;
const ROW_BATCH = 256;
const FOLD_ROWS_PER_STEP = 32 * ROW_BATCH;
/** WAL pages between automatic checkpoints while old rows are folded (SQLite's default is 1,000). */
const MIGRATION_CHECKPOINT_PAGES = 8000;
const DEFAULT_CHECKPOINT_PAGES = 1000;
const PRUNE_BATCH = 4096;
const VACUUM_THRESHOLD_PAGES = 1024;
const VACUUM_STEP_PAGES = 1024;
const COMPACTION_RETRY_MS = 6 * 60 * 60 * 1000;
const COMPACTION_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const MAINTENANCE_FAILURE_PAUSE_MS = 60_000;

const columnsOf = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));

const indexExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name));

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));

/**
 * Smoothed processing rate for the remaining-time estimate shown while catching up.
 */
const createRateEstimate = () => {
  let rowsPerMs = 0;
  return {
    add(rows, elapsedMs) {
      if (rows <= 0 || elapsedMs <= 0) {
        return;
      }
      const sample = rows / elapsedMs;
      rowsPerMs = rowsPerMs === 0 ? sample : rowsPerMs * 0.8 + sample * 0.2;
    },
    secondsFor(remainingRows) {
      return rowsPerMs > 0 ? Math.ceil(remainingRows / rowsPerMs / 1000) : null;
    },
  };
};

/**
 * @param {ReturnType<typeof import("./visitor-analytics-store.mjs").openVisitorAnalyticsStore>} store
 * @param {{ onLongStep?: (step: string) => void, warn?: (message: string) => void }} [hooks]
 */
export function createVisitorAnalyticsMaintenance(store, hooks = {}) {
  const { db, statements, state, legacy } = store;
  const onLongStep = hooks.onLongStep ?? (() => undefined);
  const warn = hooks.warn ?? ((message) => console.warn(`[visitors] ${message}`));
  const autoVacuumMode = db.pragma("auto_vacuum", { simple: true });
  const rate = createRateEstimate();
  // Elapsed time between steps counts toward the rate so the estimate includes the time the
  // worker spends on requests and pauses between steps.
  let lastProgressAt = 0;
  let pausedUntil = 0;
  let compactionRetryAt = 0;
  let retention = null;
  let pendingStart = null;
  let legacyRows = null;

  const migration = {
    // Position (visited_at, rowid) of the last folded old row.
    cursorAt: statements.getMeta.get("migration_cursor_at") ?? "",
    cursorRowid: Number(statements.getMeta.get("migration_cursor_rowid") ?? 0),
    done: Number(statements.getMeta.get("migration_done") ?? 0),
    total: Number(statements.getMeta.get("migration_total") ?? 0),
  };

  const recordProgress = (rows) => {
    const now = performance.now();
    if (lastProgressAt > 0) {
      rate.add(rows, now - lastProgressAt);
    }
    lastProgressAt = now;
  };

  const prepareLegacyStatements = () => {
    const eventColumn = columnsOf(db, "visitor_events").has("event_id") ? "event_id" : "NULL AS event_id";
    legacyRows = {
      next: db.prepare(`SELECT rowid, page_slug, visitor_id, visited_at, ${eventColumn} FROM visitor_events WHERE (visited_at, rowid) > (?, ?) ORDER BY visited_at, rowid LIMIT ?`),
      pruneDayVisitors: db.prepare("DELETE FROM analytics_day_visitors WHERE day < ?"),
    };
  };

  const finishLegacyMigration = () => {
    legacy.eventExists = null;
    legacyRows = null;
    onLongStep("legacy-drop");
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS visitor_events; DROP TABLE IF EXISTS visitor_pages;");
      for (const key of ["migration_phase", "migration_done", "migration_total", "migration_cursor_at", "migration_cursor_rowid", "legacy_max_rowid", "updated_at"]) {
        statements.deleteMeta.run(key);
      }
      statements.setMeta.run("schema_version", String(SCHEMA_VERSION));
    })();
    legacy.active = false;
    db.pragma(`wal_autocheckpoint = ${DEFAULT_CHECKPOINT_PAGES}`);
    migration.done = 0;
    migration.total = 0;
    lastProgressAt = 0;
  };

  const startLegacyMigration = () => {
    const columns = columnsOf(db, "visitor_events");
    if (LEGACY_REQUIRED_COLUMNS.some((column) => !columns.has(column))) {
      // Rows of an unknown older layout cannot be attributed; the earlier schema check dropped
      // such tables as well.
      finishLegacyMigration();
      return;
    }
    if (!indexExists(db, LEGACY_ORDER_INDEX)) {
      onLongStep("legacy-index");
      db.exec(`CREATE INDEX IF NOT EXISTS ${LEGACY_ORDER_INDEX} ON visitor_events(visited_at)`);
    }
    const { legacyMaxRowid, total } = db.transaction(() => {
      if (tableExists(db, "visitor_pages")) {
        db.exec("INSERT OR IGNORE INTO analytics_pages (slug, path, title) SELECT slug, path, title FROM visitor_pages");
      }
      const maxRowid = db.prepare("SELECT MAX(rowid) FROM visitor_events").pluck().get() ?? 0;
      const rowCount = db.prepare("SELECT COUNT(*) FROM visitor_events").pluck().get();
      statements.setMeta.run("migration_total", String(rowCount));
      statements.setMeta.run("migration_done", "0");
      statements.setMeta.run("legacy_max_rowid", String(maxRowid));
      // Old rows keep their row IDs in `analytics_visits` and are folded by the migration itself;
      // the fold cursor starts above them, at the visits recorded since the worker opened.
      statements.setMeta.run("fold_cursor", String(Math.max(state.foldCursor, maxRowid)));
      statements.setMeta.run("migration_phase", "drop-indexes");
      return { legacyMaxRowid: maxRowid, total: rowCount };
    })();
    migration.total = total;
    migration.done = 0;
    state.foldCursor = Math.max(state.foldCursor, legacyMaxRowid);
    state.nextVisitId = Math.max(state.nextVisitId, legacyMaxRowid + 1);
  };

  const legacyPageIds = new Map();
  const legacyPageId = (slug) => {
    const cached = legacyPageIds.get(slug);
    if (cached !== undefined) {
      return cached;
    }
    const id = statements.findPage.get(slug)?.id ?? Number(statements.insertPage.run(slug, `/${slug}`, slug).lastInsertRowid);
    legacyPageIds.set(slug, id);
    return id;
  };

  const foldLegacyChunk = (nowMs) => {
    const started = performance.now();
    const nowHour = toHour(nowMs);
    const today = toDay(nowMs);
    const retainedFromMs = retentionStartDay(nowMs) * DAY_MS;
    const rememberedEventsFromMs = (today - 1) * DAY_MS;
    let chunk;
    try {
      chunk = store.commit(() => {
        const totals = store.createFoldTotals();
        let cursorAt = migration.cursorAt;
        let cursorRowid = migration.cursorRowid;
        let count = 0;
        let lastDay = null;
        while (count < FOLD_ROWS_PER_STEP && performance.now() - started < FOLD_STEP_BUDGET_MS) {
          const rows = legacyRows.next.all(cursorAt, cursorRowid, ROW_BATCH);
          if (rows.length === 0) {
            break;
          }
          for (const row of rows) {
            const visitedAt = Date.parse(row.visited_at);
            if (Number.isFinite(visitedAt) && row.page_slug && row.visitor_id) {
              const pageId = legacyPageId(row.page_slug);
              const visitor = store.resolveVisitor(visitorHashBytes(row.visitor_id));
              store.foldVisit(totals, { visitedAt, pageId, visitorKey: visitor.key, lastHour: visitor.lastHour }, nowHour);
              if (visitedAt >= retainedFromMs) {
                statements.insertVisit.run(row.rowid, visitedAt, pageId, visitor.key);
              }
              if (row.event_id && visitedAt >= rememberedEventsFromMs) {
                statements.insertRecentEvent.run(visitor.key, eventKeyFor(row.event_id), today);
              }
              lastDay = toDay(visitedAt);
            }
          }
          count += rows.length;
          cursorAt = rows.at(-1).visited_at;
          cursorRowid = rows.at(-1).rowid;
        }
        if (lastDay !== null) {
          // Old rows arrive oldest first, so presence rows of days before the previous one can
          // no longer receive a visit; recent days stay for visits recorded meanwhile.
          legacyRows.pruneDayVisitors.run(Math.min(lastDay, today) - 1);
        }
        statements.setMeta.run("migration_cursor_at", cursorAt);
        statements.setMeta.run("migration_cursor_rowid", String(cursorRowid));
        statements.setMeta.run("migration_done", String(migration.done + count));
        return { state: store.applyFoldTotals(totals, 0), value: { count, cursorAt, cursorRowid } };
      });
    } catch (error) {
      legacyPageIds.clear();
      throw error;
    }
    if (chunk.count === 0) {
      finishLegacyMigration();
      return;
    }
    migration.cursorAt = chunk.cursorAt;
    migration.cursorRowid = chunk.cursorRowid;
    migration.done += chunk.count;
    recordProgress(chunk.count);
  };

  const migrateLegacyStep = (nowMs) => {
    const phase = statements.getMeta.get("migration_phase");
    if (!phase) {
      startLegacyMigration();
      return;
    }
    if (phase === "drop-indexes") {
      const next = LEGACY_REDUNDANT_INDEXES.find((name) => indexExists(db, name));
      if (next) {
        onLongStep("drop-index");
        db.exec(`DROP INDEX IF EXISTS ${next}`);
      } else {
        statements.setMeta.run("migration_phase", "fold");
      }
      return;
    }
    if (!legacyRows) {
      prepareLegacyStatements();
    }
    foldLegacyChunk(nowMs);
  };

  const foldPendingStep = (nowMs) => {
    if (pendingStart === null) {
      pendingStart = state.foldCursor;
      lastProgressAt = 0;
    }
    const folded = store.foldPendingVisits(nowMs, FOLD_ROWS_PER_STEP);
    recordProgress(folded);
    if (state.foldCursor >= state.nextVisitId - 1) {
      pendingStart = null;
    }
  };

  const createRetentionRun = (nowMs) => ({
    day: toDay(nowMs),
    phase: "visits",
    visitCursor: 0,
    pageIds: db.prepare("SELECT page_id FROM analytics_pages ORDER BY page_id").pluck().all(),
  });

  const retentionStatements = {
    visits: db.prepare("SELECT visit_id AS id, visited_at AS visitedAt FROM analytics_visits WHERE visit_id > ? AND visit_id <= ? ORDER BY visit_id LIMIT ?"),
    deleteVisit: db.prepare("DELETE FROM analytics_visits WHERE visit_id = ?"),
    staleVisitors: db.prepare("SELECT visitor_key FROM analytics_visitors WHERE last_hour < ? LIMIT ?").pluck(),
    deleteVisitor: db.prepare("DELETE FROM analytics_visitors WHERE visitor_key = ?"),
    stalePageVisitors: db.prepare("SELECT visitor_key FROM analytics_page_visitors WHERE page_id = ? AND last_hour < ? LIMIT ?").pluck(),
    deletePageVisitor: db.prepare("DELETE FROM analytics_page_visitors WHERE page_id = ? AND visitor_key = ?"),
    deleteStaleEvents: db.prepare("DELETE FROM analytics_recent_events WHERE event_row IN (SELECT event_row FROM analytics_recent_events WHERE day < ? ORDER BY event_row LIMIT ?)"),
  };

  /** Runs one bounded part of today's retention pass; returns false once the pass is complete. */
  const retentionStep = (nowMs) => {
    const run = retention?.day === toDay(nowMs) ? retention : (retention = createRetentionRun(nowMs));
    const retainedFromDay = retentionStartDay(nowMs);

    if (run.phase === "visits") {
      // Visit IDs follow arrival order, which matches time order closely: scan from the oldest
      // and stop at the first batch without an expired row. A row with an earlier timestamp
      // behind a whole batch of newer ones (clock adjustments) is removed once those expired.
      const rows = retentionStatements.visits.all(run.visitCursor, state.foldCursor, PRUNE_BATCH);
      const expired = rows.filter((row) => row.visitedAt < retainedFromDay * DAY_MS);
      if (expired.length === 0) {
        run.phase = "visitors";
        return true;
      }
      db.transaction(() => {
        for (const row of expired) {
          retentionStatements.deleteVisit.run(row.id);
        }
      })();
      run.visitCursor = rows.at(-1).id;
      return true;
    }

    if (run.phase === "visitors") {
      const removed = db.transaction(() => {
        const keys = retentionStatements.staleVisitors.all(retainedFromDay * 24, PRUNE_BATCH);
        for (const key of keys) {
          retentionStatements.deleteVisitor.run(key);
        }
        return keys.length;
      })();
      if (removed === 0) {
        run.phase = "page-visitors";
      }
      return true;
    }

    if (run.phase === "page-visitors") {
      const pageId = run.pageIds[0];
      if (pageId === undefined) {
        run.phase = "events";
        return true;
      }
      const removed = db.transaction(() => {
        const keys = retentionStatements.stalePageVisitors.all(pageId, retainedFromDay * 24, PRUNE_BATCH);
        for (const key of keys) {
          retentionStatements.deletePageVisitor.run(pageId, key);
        }
        return keys.length;
      })();
      if (removed < PRUNE_BATCH) {
        run.pageIds.shift();
      }
      return true;
    }

    if (run.phase === "events") {
      // Rows are appended in arrival order, so the expired ones come first.
      if (retentionStatements.deleteStaleEvents.run(toDay(nowMs) - 1, PRUNE_BATCH).changes < PRUNE_BATCH) {
        run.phase = "horizon";
      }
      return true;
    }

    if (run.phase === "horizon") {
      const firstHour = toHour(nowMs) - HOURLY_HORIZON_HOURS;
      db.transaction(() => {
        db.prepare("DELETE FROM analytics_hourly WHERE hour < ?").run(firstHour);
        db.prepare("DELETE FROM analytics_hourly_pages WHERE hour < ?").run(firstHour);
        db.prepare("DELETE FROM analytics_hour_visitors WHERE hour < ?").run(firstHour);
        // Every stored visit is folded at this point, and new ones arrive for today.
        db.prepare("DELETE FROM analytics_day_visitors WHERE day < ?").run(toDay(nowMs) - 1);
        statements.setMeta.run("retention_day", String(run.day));
      })();
      run.phase = "done";
      return true;
    }

    return false;
  };

  const retentionDue = (nowMs) => Number(statements.getMeta.get("retention_day") ?? -1) < toDay(nowMs);

  /**
   * Replaces the database file by a compacted copy in incremental auto-vacuum mode. The copy is
   * written beside the database and renamed over it only after the connection was closed with
   * an empty WAL, so a crash at any point leaves either the old or the new complete file.
   *
   * @returns {boolean} Whether the database file was closed (and must be reopened).
   */
  const compact = (nowMs) => {
    const pageSize = db.pragma("page_size", { simple: true });
    const liveBytes = (db.pragma("page_count", { simple: true }) - db.pragma("freelist_count", { simple: true })) * pageSize;
    const { bavail, bsize } = statfsSync(path.dirname(store.dbPath));
    if (bavail * bsize < liveBytes * 1.25 + COMPACTION_SPACE_MARGIN_BYTES) {
      warn(`Not enough free disk space to compact the analytics database (needs about ${Math.ceil(liveBytes / 1048576)} MiB); retrying later.`);
      compactionRetryAt = nowMs + COMPACTION_RETRY_MS;
      return false;
    }

    const target = compactionTargetPath(store.dbPath);
    onLongStep("compacting");
    try {
      rmSync(target, { force: true });
      db.pragma("auto_vacuum = INCREMENTAL");
      db.prepare("VACUUM INTO ?").run(target);
      ensurePrivateFileSync(target);
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      compactionRetryAt = nowMs + COMPACTION_RETRY_MS;
      rmSync(target, { force: true });
      throw error;
    }
    store.close();
    try {
      const walPath = `${store.dbPath}-wal`;
      if (existsSync(walPath) && statSync(walPath).size > 0) {
        // Another connection kept the WAL alive; its content would be lost with the old file.
        rmSync(target, { force: true });
        warn("Skipped compacting the analytics database because its WAL was still in use.");
      } else {
        renameSync(target, store.dbPath);
      }
    } catch (error) {
      // The old file is still complete; the next open removes the copy.
      warn(`Failed to replace the analytics database by its compacted copy: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  };

  /**
   * Runs the next pending piece of maintenance.
   *
   * @param {number} nowMs
   * @returns {{ worked: boolean, reopen?: boolean }}
   */
  const step = (nowMs) => {
    if (nowMs < pausedUntil) {
      return { worked: false };
    }
    try {
      if (legacy.active) {
        migrateLegacyStep(nowMs);
        return { worked: true };
      }
      if (state.foldCursor < state.nextVisitId - 1) {
        foldPendingStep(nowMs);
        return { worked: true };
      }
      if (retentionDue(nowMs) && retentionStep(nowMs)) {
        return { worked: true };
      }
      if (autoVacuumMode === 0 && nowMs >= compactionRetryAt) {
        return compact(nowMs) ? { worked: true, reopen: true } : { worked: false };
      }
      if (autoVacuumMode === 2 && db.pragma("freelist_count", { simple: true }) >= VACUUM_THRESHOLD_PAGES) {
        db.pragma(`incremental_vacuum(${VACUUM_STEP_PAGES})`);
        return { worked: true };
      }
      return { worked: false };
    } catch (error) {
      pausedUntil = nowMs + MAINTENANCE_FAILURE_PAUSE_MS;
      warn(`Analytics maintenance failed; retrying in a minute: ${error instanceof Error ? error.message : String(error)}`);
      return { worked: false };
    }
  };

  if (legacy.active) {
    db.pragma(`wal_autocheckpoint = ${MIGRATION_CHECKPOINT_PAGES}`);
  }
  // Starting the migration right away counts the old rows, so the first progress already knows
  // how many visits it covers. A failure here is retried by the regular steps.
  if (legacy.active && !statements.getMeta.get("migration_phase")) {
    try {
      startLegacyMigration();
    } catch (error) {
      pausedUntil = Date.now() + MAINTENANCE_FAILURE_PAUSE_MS;
      warn(`Starting the analytics migration failed; retrying in a minute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Progress of folding visits that are not part of the numbers yet, or `null` when caught up. */
  const progress = () => {
    if (legacy.active) {
      return { processed: migration.done, total: migration.total, etaSeconds: rate.secondsFor(migration.total - migration.done) };
    }
    if (pendingStart !== null) {
      const total = state.nextVisitId - 1 - pendingStart;
      const processed = state.foldCursor - pendingStart;
      return { processed, total, etaSeconds: rate.secondsFor(total - processed) };
    }
    return null;
  };

  return { progress, step };
}
