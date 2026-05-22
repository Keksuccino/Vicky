import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  VisitorPageIdentity,
  VisitorStatsPageSummary,
  VisitorStatsPeriodSummary,
  VisitorStatsScopeSummary,
  VisitorStatsSummary,
} from "@/lib/types";

type SqliteDatabase = ReturnType<typeof Database>;

const DEFAULT_ANALYTICS_DB_PATH = path.join(process.cwd(), "data", "wiki-analytics.sqlite");
const ALL_TIME_CHART_PERIOD_LIMIT = 150;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ANALYTICS_DB_STATE_KEY = Symbol.for("vicky.analytics.sqlite");

type AnalyticsDbState = {
  db: SqliteDatabase;
  path: string;
};

type CountRow = {
  visits: number | null;
  visitors: number | null;
};

type PeriodRow = CountRow & {
  key: string;
};

type PageRow = CountRow & {
  path: string;
  slug: string;
  title: string;
};

type AnalyticsTableName = "analytics_meta" | "visitor_pages" | "visitor_events";

type TableInfoRow = {
  name: string;
};

const REQUIRED_TABLE_COLUMNS: Record<AnalyticsTableName, string[]> = {
  analytics_meta: ["key", "value"],
  visitor_pages: ["slug", "path", "title", "updated_at"],
  visitor_events: ["id", "page_slug", "visitor_id", "visited_at", "visited_day", "visited_hour"],
};

const getAnalyticsDbPath = (): string => process.env.WIKI_ANALYTICS_DB_PATH?.trim() || DEFAULT_ANALYTICS_DB_PATH;

const getGlobalState = (): AnalyticsDbState | null => {
  const globalState = globalThis as typeof globalThis & Record<symbol, AnalyticsDbState | undefined>;
  return globalState[ANALYTICS_DB_STATE_KEY] ?? null;
};

const setGlobalState = (state: AnalyticsDbState): void => {
  const globalState = globalThis as typeof globalThis & Record<symbol, AnalyticsDbState | undefined>;
  globalState[ANALYTICS_DB_STATE_KEY] = state;
};

export const resetVisitorAnalyticsStorageForTests = (): void => {
  const globalState = globalThis as typeof globalThis & Record<symbol, AnalyticsDbState | undefined>;
  const existing = globalState[ANALYTICS_DB_STATE_KEY];
  if (existing?.db.open) {
    existing.db.close();
  }
  delete globalState[ANALYTICS_DB_STATE_KEY];
};

const getTableColumns = (db: SqliteDatabase, tableName: AnalyticsTableName): Set<string> =>
  new Set(db.prepare<[], TableInfoRow>(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));

const hasIncompatibleAnalyticsSchema = (db: SqliteDatabase): boolean => {
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS) as Array<
    [AnalyticsTableName, string[]]
  >) {
    const columns = getTableColumns(db, tableName);
    if (columns.size === 0) {
      continue;
    }

    if (requiredColumns.some((column) => !columns.has(column))) {
      return true;
    }
  }

  return false;
};

const resetAnalyticsSchema = (db: SqliteDatabase): void => {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE IF EXISTS visitor_events;
    DROP TABLE IF EXISTS visitor_pages;
    DROP TABLE IF EXISTS analytics_meta;
  `);
  db.pragma("foreign_keys = ON");
};

const ensureVisitorEventIdColumn = (db: SqliteDatabase): void => {
  const columns = getTableColumns(db, "visitor_events");
  if (columns.size > 0 && !columns.has("event_id")) {
    db.exec("ALTER TABLE visitor_events ADD COLUMN event_id TEXT;");
  }
};

const initDatabase = (db: SqliteDatabase): void => {
  if (hasIncompatibleAnalyticsSchema(db)) {
    resetAnalyticsSchema(db);
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitor_pages (
      slug TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitor_events (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      page_slug TEXT NOT NULL REFERENCES visitor_pages(slug) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      visited_at TEXT NOT NULL,
      visited_day TEXT NOT NULL,
      visited_hour TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS visitor_events_visited_at_idx ON visitor_events(visited_at);
    CREATE INDEX IF NOT EXISTS visitor_events_visited_day_idx ON visitor_events(visited_day);
    CREATE INDEX IF NOT EXISTS visitor_events_visited_hour_idx ON visitor_events(visited_hour);
    CREATE INDEX IF NOT EXISTS visitor_events_page_visited_at_idx ON visitor_events(page_slug, visited_at);
    CREATE INDEX IF NOT EXISTS visitor_events_day_page_visitor_idx ON visitor_events(visited_day, page_slug, visitor_id);
    CREATE INDEX IF NOT EXISTS visitor_events_hour_page_visitor_idx ON visitor_events(visited_hour, page_slug, visitor_id);
    CREATE INDEX IF NOT EXISTS visitor_events_page_visitor_idx ON visitor_events(page_slug, visitor_id);
  `);
  ensureVisitorEventIdColumn(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS visitor_events_visitor_event_id_idx
      ON visitor_events(visitor_id, event_id)
      WHERE event_id IS NOT NULL;
  `);
};

const getDatabase = (): SqliteDatabase => {
  const dbPath = getAnalyticsDbPath();
  const existing = getGlobalState();
  if (existing?.path === dbPath && existing.db.open) {
    return existing.db;
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  initDatabase(db);
  setGlobalState({ db, path: dbPath });
  return db;
};

const formatDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const formatHourKey = (date: Date): string => date.toISOString().slice(0, 13);

const labelDay = (key: string): string => {
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf())
    ? key
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(parsed);
};

const labelHour = (key: string): string => {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2})$/.exec(key);
  return match ? `${match[1]}:00` : key;
};

const getUtcHourStart = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));

const getUtcDayStart = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const getRecentHourKeys = (now: Date, count: number): string[] => {
  const currentHourStart = getUtcHourStart(now).getTime();

  return Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1;
    return formatHourKey(new Date(currentHourStart - offset * 60 * 60 * 1000));
  });
};

const getRecentDayKeys = (now: Date, count: number): string[] => {
  const currentDayStart = getUtcDayStart(now).getTime();

  return Array.from({ length: count }, (_, index) => {
    const offset = count - index - 1;
    return formatDayKey(new Date(currentDayStart - offset * MS_PER_DAY));
  });
};

const normalizeStatsSlug = (value: string): string =>
  value
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/?docs\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.(md|mdx)$/i, "")
    .replace(/\/+/g, "/");

const statsPathFromSlug = (slug: string): string => (slug ? `/${slug}` : "/");

const prettyTitleFromSlug = (slug: string): string => {
  const segment = slug.split("/").filter(Boolean).at(-1) ?? "Docs";
  return segment
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const normalizePage = (page: VisitorPageIdentity): VisitorPageIdentity => {
  const slug = normalizeStatsSlug(page.slug || page.path);

  return {
    path: statsPathFromSlug(slug),
    slug,
    title: page.title.trim() || prettyTitleFromSlug(slug),
  };
};

const toCount = (value: number | null | undefined): number => Math.max(0, Math.round(value ?? 0));

const getMetaValueFromDb = (db: SqliteDatabase, key: string): string | null => {
  const row = db.prepare<[string], { value: string }>("SELECT value FROM analytics_meta WHERE key = ?").get(key);
  return row?.value ?? null;
};

const getMetaValue = (key: string): string | null => getMetaValueFromDb(getDatabase(), key);

const normalizeEventId = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().slice(0, 128) ?? "";
  return normalized || null;
};

export const getVisitorAnalyticsSalt = async (): Promise<string> => {
  const db = getDatabase();
  const existing = getMetaValueFromDb(db, "ip_hash_salt");
  if (existing) {
    return existing;
  }

  return db.transaction(() => {
    const salt = randomUUID();
    db.prepare<[string]>("INSERT OR IGNORE INTO analytics_meta (key, value) VALUES ('ip_hash_salt', ?)").run(salt);
    return getMetaValueFromDb(db, "ip_hash_salt") ?? salt;
  })();
};

export const recordVisitorEvent = async ({
  eventId,
  page,
  visitedAt = new Date(),
  visitorId,
}: {
  eventId?: string | null;
  page: VisitorPageIdentity;
  visitedAt?: Date;
  visitorId: string;
}): Promise<boolean> => {
  const normalizedPage = normalizePage(page);
  const normalizedVisitorId = visitorId.trim();
  const normalizedEventId = normalizeEventId(eventId);
  if (!normalizedPage.slug || !normalizedVisitorId) {
    return false;
  }

  const timestamp = visitedAt.toISOString();
  const day = formatDayKey(visitedAt);
  const hour = formatHourKey(visitedAt);
  const db = getDatabase();

  const recorded = db.transaction(() => {
    db.prepare<[string, string, string, string]>(
      `INSERT INTO visitor_pages (slug, path, title, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         path = excluded.path,
         title = excluded.title,
         updated_at = excluded.updated_at`,
    ).run(normalizedPage.slug, normalizedPage.path, normalizedPage.title, timestamp);

    const result = db
      .prepare<[string, string | null, string, string, string, string, string]>(
        `INSERT OR IGNORE INTO visitor_events (id, event_id, page_slug, visitor_id, visited_at, visited_day, visited_hour)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), normalizedEventId, normalizedPage.slug, normalizedVisitorId, timestamp, day, hour);

    if (result.changes === 0) {
      return false;
    }

    db.prepare<[string]>(
      `INSERT INTO analytics_meta (key, value)
       VALUES ('updated_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(timestamp);

    return true;
  })();

  return recorded;
};

const countAllTime = (): CountRow => {
  return (
    getDatabase()
      .prepare<[], CountRow>("SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS visitors FROM visitor_events")
      .get() ?? { visits: 0, visitors: 0 }
  );
};

const countRange = (column: "visited_day" | "visited_hour", start: string, end: string): CountRow => {
  return (
    getDatabase()
      .prepare<[string, string], CountRow>(
        `SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS visitors
         FROM visitor_events
         WHERE ${column} BETWEEN ? AND ?`,
      )
      .get(start, end) ?? { visits: 0, visitors: 0 }
  );
};

const loadPeriodRows = (column: "visited_day" | "visited_hour", start?: string, end?: string): PeriodRow[] => {
  if (start && end) {
    return getDatabase()
      .prepare<[string, string], PeriodRow>(
        `SELECT ${column} AS key, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS visitors
         FROM visitor_events
         WHERE ${column} BETWEEN ? AND ?
         GROUP BY ${column}
         ORDER BY ${column}`,
      )
      .all(start, end);
  }

  return getDatabase()
    .prepare<[], PeriodRow>(
      `SELECT ${column} AS key, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS visitors
       FROM visitor_events
       GROUP BY ${column}
       ORDER BY ${column}`,
    )
    .all();
};

const summarizeFixedPeriods = (
  periodKeys: string[],
  rows: PeriodRow[],
  currentKey: string,
  labelForKey: (key: string) => string,
): VisitorStatsPeriodSummary[] => {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));

  return periodKeys.map((key) => {
    const row = rowsByKey.get(key);
    return {
      key,
      label: labelForKey(key),
      visits: toCount(row?.visits),
      visitors: toCount(row?.visitors),
      current: key === currentKey,
    };
  });
};

const summarizeAllTimePeriods = (rows: PeriodRow[], currentKey: string): VisitorStatsPeriodSummary[] => {
  const periodKeys = new Set([...rows.map((row) => row.key), currentKey]);
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const periods = [...periodKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => {
      const row = rowsByKey.get(key);
      return {
        key,
        label: labelDay(key),
        visits: toCount(row?.visits),
        visitors: toCount(row?.visitors),
        current: key === currentKey,
      };
    });

  if (periods.length <= ALL_TIME_CHART_PERIOD_LIMIT) {
    return periods;
  }

  const lastIndex = periods.length - 1;
  return Array.from({ length: ALL_TIME_CHART_PERIOD_LIMIT }, (_, index) => {
    const periodIndex = Math.round((index / (ALL_TIME_CHART_PERIOD_LIMIT - 1)) * lastIndex);
    return periods[periodIndex];
  });
};

const loadPageRows = (column?: "visited_day" | "visited_hour", start?: string, end?: string): PageRow[] => {
  if (column && start && end) {
    return getDatabase()
      .prepare<[string, string], PageRow>(
        `SELECT p.path, p.slug, p.title, COUNT(e.id) AS visits, COUNT(DISTINCT e.visitor_id) AS visitors
         FROM visitor_events e
         JOIN visitor_pages p ON p.slug = e.page_slug
         WHERE e.${column} BETWEEN ? AND ?
         GROUP BY p.slug, p.path, p.title`,
      )
      .all(start, end);
  }

  return getDatabase()
    .prepare<[], PageRow>(
      `SELECT p.path, p.slug, p.title, COUNT(e.id) AS visits, COUNT(DISTINCT e.visitor_id) AS visitors
       FROM visitor_events e
       JOIN visitor_pages p ON p.slug = e.page_slug
       GROUP BY p.slug, p.path, p.title`,
    )
    .all();
};

const summarizePages = (rows: PageRow[], knownPages: VisitorPageIdentity[] = []): VisitorStatsPageSummary[] => {
  const pages = new Map<string, VisitorStatsPageSummary>();

  for (const page of knownPages) {
    const normalizedPage = normalizePage(page);
    if (!normalizedPage.slug || pages.has(normalizedPage.slug)) {
      continue;
    }

    pages.set(normalizedPage.slug, {
      path: normalizedPage.path,
      slug: normalizedPage.slug,
      title: normalizedPage.title,
      visits: 0,
      visitors: 0,
    });
  }

  for (const row of rows) {
    const normalizedPage = normalizePage(row);
    if (!normalizedPage.slug) {
      continue;
    }

    pages.set(normalizedPage.slug, {
      path: normalizedPage.path,
      slug: normalizedPage.slug,
      title: normalizedPage.title,
      visits: toCount(row.visits),
      visitors: toCount(row.visitors),
    });
  }

  return [...pages.values()].sort(
    (left, right) => right.visits - left.visits || right.visitors - left.visitors || left.title.localeCompare(right.title),
  );
};

const createRecentHoursScope = (now: Date, knownPages: VisitorPageIdentity[]): VisitorStatsScopeSummary => {
  const periodKeys = getRecentHourKeys(now, 24);
  const currentKey = formatHourKey(now);
  const start = periodKeys[0];
  const end = periodKeys.at(-1) ?? currentKey;
  const totals = countRange("visited_hour", start, end);

  return {
    totalVisits: toCount(totals.visits),
    totalVisitors: toCount(totals.visitors),
    currentPeriodKey: "last-24-hours",
    currentPeriodLabel: "Last 24 hours",
    periods: summarizeFixedPeriods(periodKeys, loadPeriodRows("visited_hour", start, end), currentKey, labelHour),
    pages: summarizePages(loadPageRows("visited_hour", start, end), knownPages),
  };
};

const createRecentDaysScope = (
  now: Date,
  dayCount: number,
  currentPeriodKey: string,
  currentPeriodLabel: string,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const periodKeys = getRecentDayKeys(now, dayCount);
  const currentKey = formatDayKey(now);
  const start = periodKeys[0];
  const end = periodKeys.at(-1) ?? currentKey;
  const totals = countRange("visited_day", start, end);

  return {
    totalVisits: toCount(totals.visits),
    totalVisitors: toCount(totals.visitors),
    currentPeriodKey,
    currentPeriodLabel,
    periods: summarizeFixedPeriods(periodKeys, loadPeriodRows("visited_day", start, end), currentKey, labelDay),
    pages: summarizePages(loadPageRows("visited_day", start, end), knownPages),
  };
};

export const loadVisitorStatsSummary = async (
  now = new Date(),
  knownPages: VisitorPageIdentity[] = [],
): Promise<VisitorStatsSummary> => {
  const updatedAt = getMetaValue("updated_at") ?? now.toISOString();
  const allTimeTotals = countAllTime();
  const currentDayKey = formatDayKey(now);

  return {
    updatedAt,
    scopes: {
      allTime: {
        totalVisits: toCount(allTimeTotals.visits),
        totalVisitors: toCount(allTimeTotals.visitors),
        currentPeriodKey: "all-time",
        currentPeriodLabel: "All time",
        periods: summarizeAllTimePeriods(loadPeriodRows("visited_day"), currentDayKey),
        pages: summarizePages(loadPageRows(), knownPages),
      },
      daily: createRecentHoursScope(now, knownPages),
      weekly: createRecentDaysScope(now, 7, "last-7-days", "Last 7 days", knownPages),
      monthly: createRecentDaysScope(now, 30, "last-30-days", "Last 30 days", knownPages),
      yearly: createRecentDaysScope(now, 365, "last-365-days", "Last 365 days", knownPages),
    },
  };
};
