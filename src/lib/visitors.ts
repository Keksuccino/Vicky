import { createHash, randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { getClientIp } from "@/lib/login-rate-limit";
import type {
  GitHubDocPage,
  VisitorPageIdentity,
  VisitorStatsPageSummary,
  VisitorStatsPeriodSummary,
  VisitorStatsScopeSummary,
  VisitorStatsStore,
  VisitorStatsSummary,
  VisitorStatsVisit,
} from "@/lib/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ALL_TIME_CHART_PERIOD_LIMIT = 150;
const MAX_VISIT_RECORD_ATTEMPTS = 3;
const VISIT_EVENT_ID_MAX_LENGTH = 64;
const DEFAULT_VISIT_QUEUE_CAPACITY = 1_000;
const DEFAULT_VISIT_RETRY_BASE_MS = 1_000;
const DEFAULT_VISIT_RETRY_MAX_MS = 30_000;
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
  loadVisitorStatsSummary: (now?: Date, knownPages?: VisitorPageIdentity[]) => Promise<VisitorStatsSummary>;
  recordVisitorEvent: (event: {
    eventId?: string | null;
    page: VisitorPageIdentity;
    visitedAt?: Date;
    visitorId: string;
  }) => Promise<boolean>;
};

type VisitorStorageLoader = () => Promise<VisitorStorageBackend>;

const defaultVisitorStorageLoader: VisitorStorageLoader = () => import("@/lib/visitor-storage");

let visitorStorageLoader: VisitorStorageLoader = defaultVisitorStorageLoader;

type QueuedDocPageVisit = {
  attempts: number;
  availableAt: number;
  dedupKey: string | null;
  eventId: string | null;
  ipAddress: string;
  page: VisitorPageIdentity;
  queueId: string;
};

export type EnqueueDocPageVisitResult =
  | { status: "queued" }
  | { status: "duplicate" }
  | { retryAfterSeconds: number; status: "full" };

// Ready and delayed work stay separate so a backed-off write cannot block newer visits and
// draining the normal FIFO does not repeatedly splice a large array.
const readyVisitQueue = new Map<string, QueuedDocPageVisit>();
const delayedVisitQueue = new Map<string, QueuedDocPageVisit>();
const queuedEventIds = new Set<string>();
const recentEventIds = new Map<string, number>();
let activeQueuedVisitCount = 0;
let lastRecentEventPruneAt = Number.NEGATIVE_INFINITY;
let visitQueueFlushing = false;
let visitQueueWakeAt = 0;
let visitQueueWakeTimer: ReturnType<typeof setTimeout> | null = null;

export const setVisitorStorageLoaderForTests = (loader: VisitorStorageLoader | null): void => {
  visitorStorageLoader = loader ?? defaultVisitorStorageLoader;
};

const loadVisitorStorage = async (): Promise<VisitorStorageBackend> => visitorStorageLoader();

const createEmptyVisitorStatsStore = (updatedAt: Date): VisitorStatsStore => ({
  salt: "",
  updatedAt: updatedAt.toISOString(),
  visits: [],
});

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

const getPeriodKeys = (date: Date) => ({
  hourly: formatHourKey(date),
  daily: formatDayKey(date),
});

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

type VisitorStatsAggregatePage = VisitorPageIdentity & {
  visits: number;
  visitorIds: Set<string>;
  updatedAt: string;
};

type VisitorStatsAggregateBucket = {
  visits: number;
  visitorIds: Set<string>;
  pages: Map<string, VisitorStatsAggregatePage>;
};

type VisitorStatsAggregateBuckets = Map<string, VisitorStatsAggregateBucket>;

const createAggregateBucket = (): VisitorStatsAggregateBucket => ({
  visits: 0,
  visitorIds: new Set(),
  pages: new Map(),
});

const bucketVisitCount = (bucket: VisitorStatsAggregateBucket | undefined): number => bucket?.visits ?? 0;

const bucketVisitorCount = (bucket: VisitorStatsAggregateBucket | undefined): number => bucket?.visitorIds.size ?? 0;

const addVisitToBucket = (bucket: VisitorStatsAggregateBucket, visit: VisitorStatsVisit): void => {
  bucket.visits += 1;
  bucket.visitorIds.add(visit.visitorId);

  const existingPage = bucket.pages.get(visit.slug);
  if (!existingPage) {
    bucket.pages.set(visit.slug, {
      path: visit.path,
      slug: visit.slug,
      title: visit.title,
      visits: 1,
      visitorIds: new Set([visit.visitorId]),
      updatedAt: visit.visitedAt,
    });
    return;
  }

  existingPage.visits += 1;
  existingPage.visitorIds.add(visit.visitorId);

  if (visit.visitedAt >= existingPage.updatedAt) {
    existingPage.path = visit.path;
    existingPage.title = visit.title;
    existingPage.updatedAt = visit.visitedAt;
  }
};

const mergeBucketInto = (
  target: VisitorStatsAggregateBucket,
  source: VisitorStatsAggregateBucket | undefined,
): void => {
  if (!source) {
    return;
  }

  target.visits += source.visits;
  for (const visitorId of source.visitorIds) {
    target.visitorIds.add(visitorId);
  }

  for (const page of source.pages.values()) {
    const existingPage = target.pages.get(page.slug);
    if (!existingPage) {
      target.pages.set(page.slug, {
        path: page.path,
        slug: page.slug,
        title: page.title,
        visits: page.visits,
        visitorIds: new Set(page.visitorIds),
        updatedAt: page.updatedAt,
      });
      continue;
    }

    existingPage.visits += page.visits;
    for (const visitorId of page.visitorIds) {
      existingPage.visitorIds.add(visitorId);
    }

    if (page.updatedAt >= existingPage.updatedAt) {
      existingPage.path = page.path;
      existingPage.title = page.title;
      existingPage.updatedAt = page.updatedAt;
    }
  }
};

const aggregateVisits = (
  visits: VisitorStatsVisit[],
  keyForVisit: (visit: VisitorStatsVisit) => string,
): VisitorStatsAggregateBuckets => {
  const buckets: VisitorStatsAggregateBuckets = new Map();

  for (const visit of visits) {
    const key = keyForVisit(visit);
    const bucket = buckets.get(key) ?? createAggregateBucket();
    buckets.set(key, bucket);
    addVisitToBucket(bucket, visit);
  }

  return buckets;
};

const aggregateAllVisits = (visits: VisitorStatsVisit[]): VisitorStatsAggregateBucket => {
  const bucket = createAggregateBucket();

  for (const visit of visits) {
    addVisitToBucket(bucket, visit);
  }

  return bucket;
};

const mergeBucketsForKeys = (
  buckets: VisitorStatsAggregateBuckets,
  keys: string[],
): VisitorStatsAggregateBucket => {
  const bucket = createAggregateBucket();

  for (const key of keys) {
    mergeBucketInto(bucket, buckets.get(key));
  }

  return bucket;
};

const getVisitDate = (visit: VisitorStatsVisit): Date => new Date(visit.visitedAt);

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

const normalizeVisitPage = (page: VisitorPageIdentity): VisitorPageIdentity => {
  const slug = normalizeStatsSlug(page.slug || page.path);

  return {
    path: statsPathFromSlug(slug),
    slug,
    title: page.title.trim() || prettyTitleFromSlug(slug),
  };
};

export const recordVisitorInStats = (
  stats: VisitorStatsStore,
  page: VisitorPageIdentity,
  visitorId: string,
  visitedAt = new Date(),
): boolean => {
  const normalizedPage = normalizeVisitPage(page);
  const normalizedVisitorId = visitorId.trim();
  if (!normalizedPage.slug || !normalizedVisitorId) {
    return false;
  }

  const timestamp = visitedAt.toISOString();
  stats.visits.push({
    id: randomUUID(),
    ...normalizedPage,
    visitorId: normalizedVisitorId,
    visitedAt: timestamp,
  });
  stats.updatedAt = timestamp;

  return true;
};

const normalizeVisitEventId = (eventId: string | null | undefined): string | null => {
  const normalized = eventId?.trim().slice(0, VISIT_EVENT_ID_MAX_LENGTH) ?? "";
  return normalized || null;
};

const createVisitDedupKey = (ipAddress: string, eventId: string | null): string | null => {
  if (!eventId) {
    return null;
  }
  return createHash("sha256").update(`${ipAddress}\0${eventId}`).digest("base64url");
};

const pruneRecentEventIds = (now: number): void => {
  if (now >= lastRecentEventPruneAt && now - lastRecentEventPruneAt < RECENT_EVENT_ID_PRUNE_INTERVAL_MS) {
    return;
  }
  lastRecentEventPruneAt = now;
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

const recordPageIdentityVisitForIp = async (
  ipAddress: string,
  page: VisitorPageIdentity,
  eventId?: string | null,
): Promise<void> => {
  const storage = await loadVisitorStorage();
  const visitorId = hashVisitorIp(ipAddress, await storage.getVisitorAnalyticsSalt());
  await storage.recordVisitorEvent({ eventId: normalizeVisitEventId(eventId), page, visitorId });
};

const clearVisitQueueWakeTimer = (): void => {
  if (visitQueueWakeTimer) {
    clearTimeout(visitQueueWakeTimer);
  }
  visitQueueWakeTimer = null;
  visitQueueWakeAt = 0;
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

const takeNextReadyVisit = (): QueuedDocPageVisit | null => {
  const entry = readyVisitQueue.entries().next().value as [string, QueuedDocPageVisit] | undefined;
  if (!entry) {
    return null;
  }
  readyVisitQueue.delete(entry[0]);
  return entry[1];
};

const scheduleVisitQueueWake = (wakeAt: number): void => {
  if (visitQueueWakeTimer && visitQueueWakeAt <= wakeAt) {
    return;
  }

  clearVisitQueueWakeTimer();
  visitQueueWakeAt = wakeAt;
  visitQueueWakeTimer = setTimeout(() => {
    visitQueueWakeTimer = null;
    visitQueueWakeAt = 0;
    void flushQueuedVisits();
  }, Math.max(1, wakeAt - Date.now()));
  visitQueueWakeTimer.unref?.();
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

const flushQueuedVisits = async (): Promise<void> => {
  if (visitQueueFlushing) {
    return;
  }

  clearVisitQueueWakeTimer();
  visitQueueFlushing = true;

  try {
    promoteReadyRetries(Date.now());
    let visit = takeNextReadyVisit();
    while (visit) {
      activeQueuedVisitCount += 1;

      try {
        await recordPageIdentityVisitForIp(visit.ipAddress, visit.page, visit.eventId);
        completeQueuedVisit(visit, true);
      } catch (error: unknown) {
        const nextAttempts = visit.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[visitors] Failed to record docs page visit for ${visit.page.slug} (attempt ${nextAttempts}/${MAX_VISIT_RECORD_ATTEMPTS}): ${message}`);

        if (nextAttempts < MAX_VISIT_RECORD_ATTEMPTS) {
          delayedVisitQueue.set(visit.queueId, { ...visit, attempts: nextAttempts, availableAt: Date.now() + nextVisitRetryDelayMs(nextAttempts) });
        } else {
          completeQueuedVisit(visit, false);
        }
      } finally {
        activeQueuedVisitCount = Math.max(0, activeQueuedVisitCount - 1);
      }

      promoteReadyRetries(Date.now());
      visit = takeNextReadyVisit();
    }
  } finally {
    visitQueueFlushing = false;
    scheduleNextQueuedVisit();
  }
};

export const recordDocPageVisit = async (request: NextRequest, page: GitHubDocPage): Promise<void> => {
  await recordPageIdentityVisitForIp(getRequestIpAddress(request), normalizeVisitorPageIdentity(page));
};

export const enqueueDocPageVisit = (request: NextRequest, page: VisitorPageIdentity, eventId?: string | null): EnqueueDocPageVisitResult => {
  const normalizedPage = normalizeVisitPage(page);
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

  if (readyVisitQueue.size + delayedVisitQueue.size + activeQueuedVisitCount >= VISIT_QUEUE_CAPACITY) {
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
    dedupKey,
    eventId: normalizedEventId,
    ipAddress,
    page: normalizedPage,
    queueId,
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
  activeQueuedVisitCount = 0;
  lastRecentEventPruneAt = Number.NEGATIVE_INFINITY;
  visitQueueFlushing = false;
};

const summarizePages = (
  bucket: VisitorStatsAggregateBucket | undefined,
  knownPages: VisitorPageIdentity[] = [],
): VisitorStatsPageSummary[] => {
  const pages = new Map<string, VisitorStatsPageSummary>();

  for (const page of knownPages) {
    const slug = normalizeStatsSlug(page.slug || page.path);
    if (!slug || pages.has(slug)) {
      continue;
    }

    pages.set(slug, {
      path: statsPathFromSlug(slug),
      slug,
      title: page.title.trim() || prettyTitleFromSlug(slug),
      visits: 0,
      visitors: 0,
    });
  }

  for (const page of bucket?.pages.values() ?? []) {
    pages.set(page.slug, {
      path: page.path,
      slug: page.slug,
      title: page.title,
      visits: page.visits,
      visitors: page.visitorIds.size,
    });
  }

  return [...pages.values()]
    .sort((left, right) => right.visits - left.visits || right.visitors - left.visitors || left.title.localeCompare(right.title));
};

const summarizePeriods = (
  buckets: VisitorStatsAggregateBuckets,
  currentKey: string,
  labelForKey: (key: string) => string,
): VisitorStatsPeriodSummary[] => {
  const periodKeys = new Set([...buckets.keys(), currentKey]);

  return [...periodKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({
      key,
      label: labelForKey(key),
      visits: bucketVisitCount(buckets.get(key)),
      visitors: bucketVisitorCount(buckets.get(key)),
      current: key === currentKey,
    }));
};

const downsamplePeriods = (
  periods: VisitorStatsPeriodSummary[],
  maxPoints: number,
): VisitorStatsPeriodSummary[] => {
  if (periods.length <= maxPoints) {
    return periods;
  }

  const lastIndex = periods.length - 1;

  return Array.from({ length: maxPoints }, (_, index) => {
    const periodIndex = Math.round((index / (maxPoints - 1)) * lastIndex);
    return periods[periodIndex];
  });
};

const summarizeFixedPeriods = (
  buckets: VisitorStatsAggregateBuckets,
  periodKeys: string[],
  currentKey: string,
  labelForKey: (key: string) => string,
): VisitorStatsPeriodSummary[] => {
  return periodKeys.map((key) => ({
    key,
    label: labelForKey(key),
    visits: bucketVisitCount(buckets.get(key)),
    visitors: bucketVisitorCount(buckets.get(key)),
    current: key === currentKey,
  }));
};

const summarizeRecentHoursScope = (
  hourlyBuckets: VisitorStatsAggregateBuckets,
  now: Date,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const periodKeys = getRecentHourKeys(now, 24);
  const currentKey = formatHourKey(now);
  const currentBucket = mergeBucketsForKeys(hourlyBuckets, periodKeys);

  return {
    totalVisits: bucketVisitCount(currentBucket),
    totalVisitors: bucketVisitorCount(currentBucket),
    currentPeriodKey: "last-24-hours",
    currentPeriodLabel: "Last 24 hours",
    periods: summarizeFixedPeriods(hourlyBuckets, periodKeys, currentKey, labelHour),
    pages: summarizePages(currentBucket, knownPages),
  };
};

const summarizeRecentDaysScope = (
  dailyBuckets: VisitorStatsAggregateBuckets,
  now: Date,
  dayCount: number,
  currentPeriodKey: string,
  currentPeriodLabel: string,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const periodKeys = getRecentDayKeys(now, dayCount);
  const currentKey = formatDayKey(now);
  const currentBucket = mergeBucketsForKeys(dailyBuckets, periodKeys);

  return {
    totalVisits: bucketVisitCount(currentBucket),
    totalVisitors: bucketVisitorCount(currentBucket),
    currentPeriodKey,
    currentPeriodLabel,
    periods: summarizeFixedPeriods(dailyBuckets, periodKeys, currentKey, labelDay),
    pages: summarizePages(currentBucket, knownPages),
  };
};

export const createVisitorStatsSummary = (
  stats: VisitorStatsStore,
  now = new Date(),
  knownPages: VisitorPageIdentity[] = [],
): VisitorStatsSummary => {
  const keys = getPeriodKeys(now);
  const allTimeBucket = aggregateAllVisits(stats.visits);
  const hourlyBuckets = aggregateVisits(stats.visits, (visit) => formatHourKey(getVisitDate(visit)));
  const dailyBuckets = aggregateVisits(stats.visits, (visit) => formatDayKey(getVisitDate(visit)));
  const allTimePeriods = downsamplePeriods(
    summarizePeriods(dailyBuckets, keys.daily, labelDay),
    ALL_TIME_CHART_PERIOD_LIMIT,
  );

  return {
    updatedAt: stats.updatedAt,
    scopes: {
      allTime: {
        totalVisits: bucketVisitCount(allTimeBucket),
        totalVisitors: bucketVisitorCount(allTimeBucket),
        currentPeriodKey: "all-time",
        currentPeriodLabel: "All time",
        periods: allTimePeriods,
        pages: summarizePages(allTimeBucket, knownPages),
      },
      daily: summarizeRecentHoursScope(hourlyBuckets, now, knownPages),
      weekly: summarizeRecentDaysScope(dailyBuckets, now, 7, "last-7-days", "Last 7 days", knownPages),
      monthly: summarizeRecentDaysScope(dailyBuckets, now, 30, "last-30-days", "Last 30 days", knownPages),
      yearly: summarizeRecentDaysScope(dailyBuckets, now, 365, "last-365-days", "Last 365 days", knownPages),
    },
  };
};

export const loadVisitorStatsSummary = (
  now = new Date(),
  knownPages: VisitorPageIdentity[] = [],
): Promise<VisitorStatsSummary> =>
  loadVisitorStorage()
    .then((storage) => storage.loadVisitorStatsSummary(now, knownPages))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[visitors] SQLite analytics storage unavailable; returning empty analytics summary: ${message}`);
      return createVisitorStatsSummary(createEmptyVisitorStatsStore(now), now, knownPages);
    });
