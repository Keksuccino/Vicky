import { createHash, randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { getClientIp } from "@/lib/login-rate-limit";
import { updateStore } from "@/lib/store";
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

export const recordDocPageVisit = async (request: NextRequest, page: GitHubDocPage): Promise<void> => {
  const pageIdentity = normalizeVisitorPageIdentity(page);
  const ipAddress = getRequestIpAddress(request);

  await updateStore(
    (store) => {
      const visitorId = hashVisitorIp(ipAddress, store.visitorStats.salt);
      return recordVisitorInStats(store.visitorStats, pageIdentity, visitorId);
    },
    { touchSettings: false },
  );
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
  const allTimePeriods = summarizePeriods(dailyBuckets, keys.daily, labelDay);

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
