import { createHash, randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { getClientIp } from "@/lib/client-ip-policy";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type {
  GitHubDocPage,
  VisitorAnalyticsSummaryData,
  VisitorEventInput,
  VisitorPageIdentity,
  VisitorStatsPageSummary,
  VisitorStatsPeriodSummary,
  VisitorStatsResponse,
  VisitorStatsScopeSummary,
  VisitorStatsSummary,
} from "@/lib/types";
import type { VisitorAnalyticsSnapshot } from "@/lib/visitor-storage";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const ALL_TIME_CHART_PERIOD_LIMIT = 150;
const MAX_VISIT_RECORD_ATTEMPTS = 3;
const VISIT_EVENT_ID_MAX_LENGTH = 64;
const DEFAULT_VISIT_QUEUE_CAPACITY = 1_000;
const DEFAULT_VISIT_RETRY_BASE_MS = 1_000;
const DEFAULT_VISIT_RETRY_MAX_MS = 30_000;
/** Visits written in one storage transaction at most. */
const VISIT_BATCH_SIZE = 500;
const RECENT_EVENT_ID_TTL_MS = 10 * 60 * 1_000;
const RECENT_EVENT_ID_PRUNE_INTERVAL_MS = 30_000;
const MAX_RECENT_EVENT_IDS = 10_000;

const parseBoundedPositiveInteger = (value: string | undefined, fallback: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const VISIT_QUEUE_CAPACITY = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_QUEUE_CAPACITY, DEFAULT_VISIT_QUEUE_CAPACITY, 10_000);
const VISIT_RETRY_BASE_MS = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_RETRY_BASE_MS, DEFAULT_VISIT_RETRY_BASE_MS, 60_000);
const VISIT_RETRY_MAX_MS = Math.max(VISIT_RETRY_BASE_MS, parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_RETRY_MAX_MS, DEFAULT_VISIT_RETRY_MAX_MS, 5 * 60_000));

type VisitorStorageBackend = {
  getVisitorAnalyticsSalt: () => Promise<string>;
  loadVisitorAnalytics: (options?: { refresh?: boolean }) => Promise<VisitorAnalyticsSnapshot>;
  recordVisitorEvents: (events: VisitorEventInput[]) => Promise<unknown>;
};

type VisitorStorageLoader = () => Promise<VisitorStorageBackend>;

const defaultVisitorStorageLoader: VisitorStorageLoader = () => import("@/lib/visitor-storage");

type QueuedDocPageVisit = {
  attempts: number;
  availableAt: number;
  clientIdentity: string;
  dedupKey: string | null;
  eventId: string | null;
  page: VisitorPageIdentity;
  queueId: string;
  visitedAt: number;
};

export type EnqueueDocPageVisitResult =
  | { status: "queued" }
  | { status: "duplicate" }
  | { retryAfterSeconds: number; status: "full" };

type VisitQueueState = {
  activeQueuedVisitCount: number;
  // Ready and delayed work stay separate so a backed-off write cannot block newer visits and
  // draining the normal FIFO does not repeatedly splice a large array.
  delayedVisitQueue: Map<string, QueuedDocPageVisit>;
  flushing: boolean;
  lastRecentEventPruneAt: number;
  queuedEventIds: Set<string>;
  readyVisitQueue: Map<string, QueuedDocPageVisit>;
  recentEventIds: Map<string, number>;
  // Shared with the queue because whichever module copy flushes it must use the same backend.
  storageLoader: VisitorStorageLoader;
  wakeAt: number;
  wakeTimer: ReturnType<typeof setTimeout> | null;
};

const visitQueue = processSingleton("visitors.visitQueue", (): VisitQueueState => ({
  activeQueuedVisitCount: 0,
  delayedVisitQueue: new Map(),
  flushing: false,
  lastRecentEventPruneAt: Number.NEGATIVE_INFINITY,
  queuedEventIds: new Set(),
  readyVisitQueue: new Map(),
  recentEventIds: new Map(),
  storageLoader: defaultVisitorStorageLoader,
  wakeAt: 0,
  wakeTimer: null,
}));
const { delayedVisitQueue, queuedEventIds, readyVisitQueue, recentEventIds } = visitQueue;

export const setVisitorStorageLoaderForTests = (loader: VisitorStorageLoader | null): void => {
  visitQueue.storageLoader = loader ?? defaultVisitorStorageLoader;
};

const loadVisitorStorage = async (): Promise<VisitorStorageBackend> => visitQueue.storageLoader();

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

export const normalizeVisitorPageIdentity = (page: Pick<GitHubDocPage, "path" | "slug" | "title">): VisitorPageIdentity => {
  const slug = normalizeStatsSlug(page.slug || page.path);

  return {
    path: statsPathFromSlug(slug),
    slug,
    title: page.title.trim() || prettyTitleFromSlug(slug),
  };
};

export const getRequestIpAddress = (request: NextRequest): string => getClientIp(request);

const hashVisitorIp = (ipAddress: string, salt: string): string =>
  createHash("sha256").update(`${salt}:${ipAddress}`).digest("hex");

const formatDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const formatHourKey = (date: Date): string => date.toISOString().slice(0, 13);

// Creating an Intl formatter costs tens of microseconds; a summary labels about 550 days.
const dayLabelFormatter = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

const labelDay = (key: string): string => {
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? key : dayLabelFormatter.format(parsed);
};

const labelHour = (key: string): string => {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2})$/.exec(key);
  return match ? `${match[1]}:00` : key;
};

const normalizeVisitEventId = (eventId: string | null | undefined): string | null => {
  const normalized = eventId?.trim().slice(0, VISIT_EVENT_ID_MAX_LENGTH) ?? "";
  return normalized || null;
};

const createVisitDedupKey = (ipAddress: string, eventId: string | null): string | null => {
  if (!eventId || ipAddress === "unknown") {
    return null;
  }
  return createHash("sha256").update(`${ipAddress}\0${eventId}`).digest("base64url");
};

// An unavailable address must not collapse unrelated visitors or event IDs into one
// shared identity. The generated value stays stable across retries for a queued visit.
const createVisitorClientIdentity = (ipAddress: string): string => ipAddress === "unknown" ? `anonymous:${randomUUID()}` : ipAddress;

const pruneRecentEventIds = (now: number): void => {
  const { lastRecentEventPruneAt } = visitQueue;
  if (now >= lastRecentEventPruneAt && now - lastRecentEventPruneAt < RECENT_EVENT_ID_PRUNE_INTERVAL_MS) {
    return;
  }
  visitQueue.lastRecentEventPruneAt = now;
  for (const [dedupKey, acceptedAt] of recentEventIds.entries()) {
    if (now - acceptedAt >= RECENT_EVENT_ID_TTL_MS) {
      recentEventIds.delete(dedupKey);
    }
  }
};

const rememberRecentEventId = (dedupKey: string, now: number): void => {
  recentEventIds.delete(dedupKey);
  recentEventIds.set(dedupKey, now);

  while (recentEventIds.size > MAX_RECENT_EVENT_IDS) {
    const oldestKey = recentEventIds.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    recentEventIds.delete(oldestKey);
  }
};

const recordQueuedVisits = async (visits: QueuedDocPageVisit[]): Promise<void> => {
  const storage = await loadVisitorStorage();
  const salt = await storage.getVisitorAnalyticsSalt();
  await storage.recordVisitorEvents(visits.map((visit) => ({
    eventId: visit.eventId,
    page: visit.page,
    visitedAt: visit.visitedAt,
    visitorId: hashVisitorIp(visit.clientIdentity, salt),
  })));
};

const clearVisitQueueWakeTimer = (): void => {
  if (visitQueue.wakeTimer) {
    clearTimeout(visitQueue.wakeTimer);
  }
  visitQueue.wakeTimer = null;
  visitQueue.wakeAt = 0;
};

const nextVisitRetryDelayMs = (attempts: number): number => Math.min(VISIT_RETRY_MAX_MS, VISIT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

const promoteReadyRetries = (now: number): void => {
  for (const [queueId, visit] of delayedVisitQueue.entries()) {
    if (visit.availableAt > now) {
      continue;
    }
    delayedVisitQueue.delete(queueId);
    readyVisitQueue.set(queueId, visit);
  }
};

const takeReadyBatch = (): QueuedDocPageVisit[] => {
  const batch: QueuedDocPageVisit[] = [];
  for (const [queueId, visit] of readyVisitQueue) {
    readyVisitQueue.delete(queueId);
    batch.push(visit);
    if (batch.length >= VISIT_BATCH_SIZE) {
      break;
    }
  }
  return batch;
};

const scheduleVisitQueueWake = (wakeAt: number): void => {
  if (visitQueue.wakeTimer && visitQueue.wakeAt <= wakeAt) {
    return;
  }

  clearVisitQueueWakeTimer();
  visitQueue.wakeAt = wakeAt;
  const wakeTimer = setTimeout(() => {
    visitQueue.wakeTimer = null;
    visitQueue.wakeAt = 0;
    void flushQueuedVisits();
  }, Math.max(1, wakeAt - Date.now()));
  wakeTimer.unref?.();
  visitQueue.wakeTimer = wakeTimer;
};

const scheduleNextQueuedVisit = (): void => {
  promoteReadyRetries(Date.now());
  if (readyVisitQueue.size === 0 && delayedVisitQueue.size === 0) {
    clearVisitQueueWakeTimer();
    return;
  }

  if (readyVisitQueue.size > 0) {
    clearVisitQueueWakeTimer();
    void flushQueuedVisits();
    return;
  }

  let earliestWakeAt = Number.POSITIVE_INFINITY;
  for (const visit of delayedVisitQueue.values()) {
    earliestWakeAt = Math.min(earliestWakeAt, visit.availableAt);
  }
  scheduleVisitQueueWake(earliestWakeAt);
};

const completeQueuedVisit = (visit: QueuedDocPageVisit, remember: boolean): void => {
  if (!visit.dedupKey) {
    return;
  }

  queuedEventIds.delete(visit.dedupKey);
  if (remember) {
    rememberRecentEventId(visit.dedupKey, Date.now());
  }
};

const retryOrDropVisits = (batch: QueuedDocPageVisit[], error: unknown): void => {
  let dropped = 0;
  for (const visit of batch) {
    const nextAttempts = visit.attempts + 1;
    if (nextAttempts < MAX_VISIT_RECORD_ATTEMPTS) {
      delayedVisitQueue.set(visit.queueId, { ...visit, attempts: nextAttempts, availableAt: Date.now() + nextVisitRetryDelayMs(nextAttempts) });
    } else {
      completeQueuedVisit(visit, false);
      dropped += 1;
    }
  }
  const droppedNote = dropped > 0 ? `; dropped ${dropped} after ${MAX_VISIT_RECORD_ATTEMPTS} attempts` : "";
  console.warn(`[visitors] Failed to record ${batch.length} docs page visit${batch.length === 1 ? "" : "s"}${droppedNote}: ${errorMessage(error)}`);
};

/** Writes every ready visit, up to `VISIT_BATCH_SIZE` per storage transaction. */
const flushQueuedVisits = async (): Promise<void> => {
  if (visitQueue.flushing) {
    return;
  }

  clearVisitQueueWakeTimer();
  visitQueue.flushing = true;

  try {
    promoteReadyRetries(Date.now());
    let batch = takeReadyBatch();
    while (batch.length > 0) {
      visitQueue.activeQueuedVisitCount += batch.length;

      try {
        await recordQueuedVisits(batch);
        for (const visit of batch) {
          completeQueuedVisit(visit, true);
        }
      } catch (error: unknown) {
        retryOrDropVisits(batch, error);
      } finally {
        visitQueue.activeQueuedVisitCount = Math.max(0, visitQueue.activeQueuedVisitCount - batch.length);
      }

      promoteReadyRetries(Date.now());
      batch = takeReadyBatch();
    }
  } finally {
    visitQueue.flushing = false;
    scheduleNextQueuedVisit();
  }
};

export const enqueueDocPageVisit = (request: NextRequest, page: VisitorPageIdentity, eventId?: string | null): EnqueueDocPageVisitResult => {
  const normalizedPage = normalizeVisitorPageIdentity(page);
  if (!normalizedPage.slug) {
    return { status: "duplicate" };
  }

  const now = Date.now();
  const normalizedEventId = normalizeVisitEventId(eventId);
  const ipAddress = getRequestIpAddress(request);
  const dedupKey = createVisitDedupKey(ipAddress, normalizedEventId);
  pruneRecentEventIds(now);

  if (dedupKey && (queuedEventIds.has(dedupKey) || recentEventIds.has(dedupKey))) {
    return { status: "duplicate" };
  }

  if (readyVisitQueue.size + delayedVisitQueue.size + visitQueue.activeQueuedVisitCount >= VISIT_QUEUE_CAPACITY) {
    let earliestAvailableAt = Number.POSITIVE_INFINITY;
    for (const visit of delayedVisitQueue.values()) {
      earliestAvailableAt = Math.min(earliestAvailableAt, visit.availableAt);
    }
    const retryAfterSeconds = Number.isFinite(earliestAvailableAt) ? Math.max(1, Math.ceil((earliestAvailableAt - now) / 1_000)) : 1;
    return { status: "full", retryAfterSeconds };
  }

  if (dedupKey) {
    queuedEventIds.add(dedupKey);
  }
  const queueId = randomUUID();
  readyVisitQueue.set(queueId, {
    attempts: 0,
    availableAt: now,
    clientIdentity: createVisitorClientIdentity(ipAddress),
    dedupKey,
    eventId: normalizedEventId,
    page: normalizedPage,
    queueId,
    visitedAt: now,
  });
  void flushQueuedVisits();

  return { status: "queued" };
};

export const resetVisitorVisitQueueForTests = (): void => {
  clearVisitQueueWakeTimer();
  readyVisitQueue.clear();
  delayedVisitQueue.clear();
  queuedEventIds.clear();
  recentEventIds.clear();
  visitQueue.activeQueuedVisitCount = 0;
  visitQueue.lastRecentEventPruneAt = Number.NEGATIVE_INFINITY;
  visitQueue.flushing = false;
};

type PeriodCounts = { visits: number; visitors: number };

const summarizePages = (
  identities: Map<number, VisitorPageIdentity>,
  pageVisits: Iterable<[pageId: number, visits: number]>,
  pageVisitors: Map<number, number>,
  knownPages: VisitorPageIdentity[],
): VisitorStatsPageSummary[] => {
  const pages = new Map<string, VisitorStatsPageSummary>();

  for (const page of knownPages) {
    const normalizedPage = normalizeVisitorPageIdentity(page);
    if (normalizedPage.slug && !pages.has(normalizedPage.slug)) {
      pages.set(normalizedPage.slug, { ...normalizedPage, visits: 0, visitors: 0 });
    }
  }

  for (const [pageId, visits] of pageVisits) {
    const identity = identities.get(pageId);
    if (identity && visits > 0) {
      pages.set(identity.slug, { ...identity, visits, visitors: pageVisitors.get(pageId) ?? 0 });
    }
  }

  return [...pages.values()].sort(
    (left, right) => right.visits - left.visits || right.visitors - left.visitors || left.title.localeCompare(right.title),
  );
};

const summarizeFixedPeriods = (
  periodKeys: string[],
  counts: Map<string, PeriodCounts>,
  currentKey: string,
  labelForKey: (key: string) => string,
): VisitorStatsPeriodSummary[] =>
  periodKeys.map((key) => ({
    key,
    label: labelForKey(key),
    visits: counts.get(key)?.visits ?? 0,
    visitors: counts.get(key)?.visitors ?? 0,
    current: key === currentKey,
  }));

const downsamplePeriods = (periods: VisitorStatsPeriodSummary[], maxPoints: number): VisitorStatsPeriodSummary[] => {
  if (periods.length <= maxPoints) {
    return periods;
  }

  const lastIndex = periods.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => periods[Math.round((index / (maxPoints - 1)) * lastIndex)]);
};

const recentKeys = (lastStart: number, count: number, step: number, format: (date: Date) => string): string[] =>
  Array.from({ length: count }, (_, index) => format(new Date(lastStart - (count - index - 1) * step)));

const sumVisits = (keys: string[], counts: Map<string, PeriodCounts>): number => keys.reduce((total, key) => total + (counts.get(key)?.visits ?? 0), 0);

/**
 * Shapes the aggregate numbers of the analytics worker into the summary the admin card shows.
 * Every window ends at `computedAt`, the moment the numbers were read.
 */
export const createVisitorStatsSummary = (data: VisitorAnalyticsSummaryData, knownPages: VisitorPageIdentity[] = []): VisitorStatsSummary => {
  const now = new Date(data.computedAt);
  const currentHourStart = Math.floor(data.computedAt / MS_PER_HOUR) * MS_PER_HOUR;
  const currentDayStart = Math.floor(data.computedAt / MS_PER_DAY) * MS_PER_DAY;
  const currentDayKey = formatDayKey(now);
  const identities = new Map(data.pages.map(([pageId, slug, path, title]) => [pageId, { path, slug, title }]));
  const dayCounts = new Map(data.allTime.days.map(([day, visits, visitors]) => [formatDayKey(new Date(day * MS_PER_DAY)), { visits, visitors }]));
  const hourCounts = new Map(data.last24Hours.hours.map(([hour, visits, visitors]) => [formatHourKey(new Date(hour * MS_PER_HOUR)), { visits, visitors }]));

  // The worker returns the days up to today in ascending order, so only today may be missing.
  const allTimeKeys = [...dayCounts.keys()];
  if (!dayCounts.has(currentDayKey)) {
    allTimeKeys.push(currentDayKey);
  }
  const allTime: VisitorStatsScopeSummary = {
    totalVisits: sumVisits(allTimeKeys, dayCounts),
    totalVisitors: data.allTime.visitors,
    currentPeriodKey: "all-time",
    currentPeriodLabel: "All time",
    periods: downsamplePeriods(summarizeFixedPeriods(allTimeKeys, dayCounts, currentDayKey, labelDay), ALL_TIME_CHART_PERIOD_LIMIT),
    pages: summarizePages(
      identities,
      data.allTime.pages.map(([pageId, visits]) => [pageId, visits]),
      new Map(data.allTime.pages.map(([pageId, , visitors]) => [pageId, visitors])),
      knownPages,
    ),
  };

  const hourKeys = recentKeys(currentHourStart, 24, MS_PER_HOUR, formatHourKey);
  const daily: VisitorStatsScopeSummary = {
    totalVisits: sumVisits(hourKeys, hourCounts),
    totalVisitors: data.last24Hours.visitors,
    currentPeriodKey: "last-24-hours",
    currentPeriodLabel: "Last 24 hours",
    periods: summarizeFixedPeriods(hourKeys, hourCounts, formatHourKey(now), labelHour),
    pages: summarizePages(identities, data.last24Hours.pageVisits, new Map(data.last24Hours.pageVisitors), knownPages),
  };

  const recentDaysScope = (dayCount: number, currentPeriodKey: string, currentPeriodLabel: string): VisitorStatsScopeSummary => {
    const window = data.recentDays.find((entry) => entry.dayCount === dayCount);
    const keys = recentKeys(currentDayStart, dayCount, MS_PER_DAY, formatDayKey);
    return {
      totalVisits: sumVisits(keys, dayCounts),
      totalVisitors: window?.visitors ?? 0,
      currentPeriodKey,
      currentPeriodLabel,
      periods: summarizeFixedPeriods(keys, dayCounts, currentDayKey, labelDay),
      pages: summarizePages(identities, window?.pageVisits ?? [], new Map(window?.pageVisitors ?? []), knownPages),
    };
  };

  return {
    updatedAt: new Date(data.lastVisitAt ?? data.computedAt).toISOString(),
    computedAt: now.toISOString(),
    scopes: {
      allTime,
      daily,
      weekly: recentDaysScope(7, "last-7-days", "Last 7 days"),
      monthly: recentDaysScope(30, "last-30-days", "Last 30 days"),
      yearly: recentDaysScope(365, "last-365-days", "Last 365 days"),
    },
  };
};

/** The admin analytics answer: numbers (when available) plus catch-up progress and errors. */
export const loadVisitorStats = async (knownPages: VisitorPageIdentity[], options: { refresh?: boolean } = {}): Promise<VisitorStatsResponse> => {
  try {
    const storage = await loadVisitorStorage();
    const analytics = await storage.loadVisitorAnalytics(options);
    return {
      stats: analytics.summary ? createVisitorStatsSummary(analytics.summary, knownPages) : null,
      status: { catchingUp: analytics.progress, error: analytics.error, refreshing: analytics.refreshing },
    };
  } catch (error: unknown) {
    const message = errorMessage(error);
    console.warn(`[visitors] Visitor analytics storage unavailable: ${message}`);
    return { stats: null, status: { catchingUp: null, error: `Visitor analytics are unavailable: ${message}`, refreshing: false } };
  }
};
