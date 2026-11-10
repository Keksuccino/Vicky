import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { VisitorEventInput, VisitorStatsSummary } from "@/lib/types";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type SampleVisit = VisitorEventInput & { eventId: string };

export const SAMPLE_PAGES = [
  { path: "/home", slug: "home", title: "Home" },
  { path: "/guides/setup", slug: "guides/setup", title: "Setup" },
  { path: "/guides/deploy", slug: "guides/deploy", title: "Deploy" },
  { path: "/reference/api", slug: "reference/api", title: "API" },
  { path: "/faq", slug: "faq", title: "FAQ" },
];

/**
 * Deterministic visits spread over `days` days before `nowMs`, denser in the last day so the
 * 24-hour window has data, with returning visitors and repeated page views.
 */
export const createSampleVisits = (nowMs: number, { count = 3_000, days = 500, visitors = 240, salt = "sample-salt" } = {}): SampleVisit[] => {
  let seed = 0x2545f491;
  const random = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x1_0000_0000;
  };
  const visitorIds = Array.from({ length: visitors }, (_, index) => createHash("sha256").update(`${salt}:203.0.113.${index}`).digest("hex"));

  return Array.from({ length: count }, (_, index) => {
    const ageMs = index % 5 === 0 ? random() * MS_PER_DAY : random() * days * MS_PER_DAY;
    return {
      eventId: `event-${index}`,
      page: SAMPLE_PAGES[Math.floor(random() ** 1.6 * SAMPLE_PAGES.length)],
      visitedAt: Math.floor(nowMs - ageMs),
      visitorId: visitorIds[Math.floor(random() ** 2 * visitors)],
    };
  }).sort((left, right) => left.visitedAt - right.visitedAt);
};

type ExpectedCounts = { visits: number; visitors: number };

const countVisits = (visits: SampleVisit[]): ExpectedCounts => ({ visits: visits.length, visitors: new Set(visits.map((visit) => visit.visitorId)).size });

const dayKey = (timestampMs: number): string => new Date(timestampMs).toISOString().slice(0, 10);

const hourKey = (timestampMs: number): string => new Date(timestampMs).toISOString().slice(0, 13);

const groupBy = (visits: SampleVisit[], keyFor: (visit: SampleVisit) => string): Map<string, SampleVisit[]> => {
  const groups = new Map<string, SampleVisit[]>();
  for (const visit of visits) {
    const key = keyFor(visit);
    groups.set(key, [...(groups.get(key) ?? []), visit]);
  }
  return groups;
};

/**
 * Asserts every number of a summary against counts made directly from the sample visits:
 * totals, unique visitors, every period, and every page of every window.
 */
export const expectSummaryToMatchVisits = (summary: VisitorStatsSummary, visits: SampleVisit[], nowMs: number, expect: (value: unknown) => { toEqual: (expected: unknown) => void }): void => {
  const nowHour = Math.floor(nowMs / MS_PER_HOUR);
  const today = Math.floor(nowMs / MS_PER_DAY);
  const windows = {
    allTime: visits.filter((visit) => visit.visitedAt <= nowMs),
    daily: visits.filter((visit) => Math.floor(visit.visitedAt / MS_PER_HOUR) >= nowHour - 23 && visit.visitedAt <= nowMs),
    weekly: visits.filter((visit) => Math.floor(visit.visitedAt / MS_PER_DAY) >= today - 6 && visit.visitedAt <= nowMs),
    monthly: visits.filter((visit) => Math.floor(visit.visitedAt / MS_PER_DAY) >= today - 29 && visit.visitedAt <= nowMs),
    yearly: visits.filter((visit) => Math.floor(visit.visitedAt / MS_PER_DAY) >= today - 364 && visit.visitedAt <= nowMs),
  };

  for (const [scope, scopeVisits] of Object.entries(windows) as Array<[keyof VisitorStatsSummary["scopes"], SampleVisit[]]>) {
    const scopeSummary = summary.scopes[scope];
    const totals = countVisits(scopeVisits);
    expect({ scope, visits: scopeSummary.totalVisits, visitors: scopeSummary.totalVisitors }).toEqual({ scope, ...totals });

    const periodGroups = groupBy(scopeVisits, (visit) => (scope === "daily" ? hourKey(visit.visitedAt) : dayKey(visit.visitedAt)));
    for (const period of scopeSummary.periods) {
      expect({ scope, key: period.key, visits: period.visits, visitors: period.visitors }).toEqual({ scope, key: period.key, ...countVisits(periodGroups.get(period.key) ?? []) });
    }

    const pageGroups = groupBy(scopeVisits, (visit) => visit.page.slug);
    const expectedPages = [...pageGroups.entries()].map(([slug, pageVisits]) => ({ slug, ...countVisits(pageVisits) })).sort((left, right) => left.slug.localeCompare(right.slug));
    const actualPages = scopeSummary.pages.filter((page) => page.visits > 0).map(({ slug, visits: pageVisits, visitors }) => ({ slug, visits: pageVisits, visitors })).sort((left, right) => left.slug.localeCompare(right.slug));
    expect({ scope, pages: actualPages }).toEqual({ scope, pages: expectedPages });
  }
};

/** Creates a database in the schema used before the aggregate tables existed. */
export const createLegacyAnalyticsDatabase = (dbPath: string, visits: SampleVisit[], salt: string): void => {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE visitor_pages (slug TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE visitor_events (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      page_slug TEXT NOT NULL REFERENCES visitor_pages(slug) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      visited_at TEXT NOT NULL,
      visited_day TEXT NOT NULL,
      visited_hour TEXT NOT NULL
    );
    CREATE INDEX visitor_events_visited_at_idx ON visitor_events(visited_at);
    CREATE INDEX visitor_events_visited_day_idx ON visitor_events(visited_day);
    CREATE INDEX visitor_events_visited_hour_idx ON visitor_events(visited_hour);
    CREATE INDEX visitor_events_page_visited_at_idx ON visitor_events(page_slug, visited_at);
    CREATE INDEX visitor_events_day_page_visitor_idx ON visitor_events(visited_day, page_slug, visitor_id);
    CREATE INDEX visitor_events_hour_page_visitor_idx ON visitor_events(visited_hour, page_slug, visitor_id);
    CREATE INDEX visitor_events_page_visitor_idx ON visitor_events(page_slug, visitor_id);
    CREATE UNIQUE INDEX visitor_events_visitor_event_id_idx ON visitor_events(visitor_id, event_id) WHERE event_id IS NOT NULL;
  `);
  db.prepare("INSERT INTO analytics_meta (key, value) VALUES ('ip_hash_salt', ?)").run(salt);
  const insertPage = db.prepare("INSERT OR IGNORE INTO visitor_pages (slug, path, title, updated_at) VALUES (?, ?, ?, ?)");
  const insertEvent = db.prepare("INSERT INTO visitor_events (id, event_id, page_slug, visitor_id, visited_at, visited_day, visited_hour) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const visit of visits) {
      const visitedAt = new Date(visit.visitedAt).toISOString();
      insertPage.run(visit.page.slug, visit.page.path, visit.page.title, visitedAt);
      insertEvent.run(randomUUID(), visit.eventId, visit.page.slug, visit.visitorId, visitedAt, visitedAt.slice(0, 10), visitedAt.slice(0, 13));
    }
  })();
  db.close();
};
