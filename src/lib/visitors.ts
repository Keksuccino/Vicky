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

const formatMonthKey = (date: Date): string => date.toISOString().slice(0, 7);

const formatYearKey = (date: Date): string => String(date.getUTCFullYear());

const formatIsoWeekKey = (date: Date): string => {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);

  const year = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);

  return `${year}-W${String(week).padStart(2, "0")}`;
};

const getPeriodKeys = (date: Date) => ({
  hourly: formatHourKey(date),
  daily: formatDayKey(date),
  weekly: formatIsoWeekKey(date),
  monthly: formatMonthKey(date),
  yearly: formatYearKey(date),
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

const labelMonth = (key: string): string => {
  const parsed = new Date(`${key}-01T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf())
    ? key
    : new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(parsed);
};

const labelWeek = (key: string): string => {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  return match ? `Week ${Number(match[2])}, ${match[1]}` : key;
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

const getVisitDate = (visit: VisitorStatsVisit): Date => new Date(visit.visitedAt);

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

const summarizeCurrentDayHours = (
  buckets: VisitorStatsAggregateBuckets,
  now: Date,
): VisitorStatsPeriodSummary[] => {
  const dayKey = formatDayKey(now);
  const currentHour = now.getUTCHours();
  const currentKey = formatHourKey(now);

  return Array.from({ length: currentHour + 1 }, (_, hour) => {
    const key = `${dayKey}T${String(hour).padStart(2, "0")}`;

    return {
      key,
      label: labelHour(key),
      visits: bucketVisitCount(buckets.get(key)),
      visitors: bucketVisitorCount(buckets.get(key)),
      current: key === currentKey,
    };
  });
};

const summarizeScope = (
  buckets: VisitorStatsAggregateBuckets,
  currentKey: string,
  labelForKey: (key: string) => string,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const currentBucket = buckets.get(currentKey);

  return {
    totalVisits: bucketVisitCount(currentBucket),
    totalVisitors: bucketVisitorCount(currentBucket),
    currentPeriodKey: currentKey,
    currentPeriodLabel: labelForKey(currentKey),
    periods: summarizePeriods(buckets, currentKey, labelForKey),
    pages: summarizePages(currentBucket, knownPages),
  };
};

const summarizeDailyScope = (
  dailyBuckets: VisitorStatsAggregateBuckets,
  hourlyBuckets: VisitorStatsAggregateBuckets,
  currentDayKey: string,
  now: Date,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const currentBucket = dailyBuckets.get(currentDayKey);

  return {
    totalVisits: bucketVisitCount(currentBucket),
    totalVisitors: bucketVisitorCount(currentBucket),
    currentPeriodKey: currentDayKey,
    currentPeriodLabel: labelDay(currentDayKey),
    periods: summarizeCurrentDayHours(hourlyBuckets, now),
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
  const weeklyBuckets = aggregateVisits(stats.visits, (visit) => formatIsoWeekKey(getVisitDate(visit)));
  const monthlyBuckets = aggregateVisits(stats.visits, (visit) => formatMonthKey(getVisitDate(visit)));
  const yearlyBuckets = aggregateVisits(stats.visits, (visit) => formatYearKey(getVisitDate(visit)));
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
      daily: summarizeDailyScope(dailyBuckets, hourlyBuckets, keys.daily, now, knownPages),
      weekly: summarizeScope(weeklyBuckets, keys.weekly, labelWeek, knownPages),
      monthly: summarizeScope(monthlyBuckets, keys.monthly, labelMonth, knownPages),
      yearly: summarizeScope(yearlyBuckets, keys.yearly, (key) => key, knownPages),
    },
  };
};
