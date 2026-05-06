import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

import { getClientIp } from "@/lib/login-rate-limit";
import { updateStore } from "@/lib/store";
import type {
  GitHubDocPage,
  VisitorPageIdentity,
  VisitorStatsBucket,
  VisitorStatsPageSummary,
  VisitorStatsPeriodSummary,
  VisitorStatsScopeSummary,
  VisitorStatsStore,
  VisitorStatsSummary,
} from "@/lib/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VISITOR_STATS_RETENTION = {
  hourly: 72,
  daily: 90,
  weekly: 104,
  monthly: 60,
  yearly: 10,
} as const;

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

const createEmptyBucket = (): VisitorStatsBucket => ({
  visits: 0,
  visitorIds: [],
  pages: {},
});

const bucketVisitCount = (bucket: VisitorStatsBucket | undefined): number => bucket?.visits ?? 0;

const bucketVisitorCount = (bucket: VisitorStatsBucket | undefined): number => bucket?.visitorIds.length ?? 0;

const upsertVisitor = (
  bucket: VisitorStatsBucket,
  page: VisitorPageIdentity,
  visitorId: string,
  timestamp: string,
): boolean => {
  let changed = false;

  bucket.visits += 1;
  changed = true;

  if (!bucket.visitorIds.includes(visitorId)) {
    bucket.visitorIds.push(visitorId);
  }

  const existingPage = bucket.pages[page.slug];
  if (!existingPage) {
    bucket.pages[page.slug] = {
      ...page,
      visits: 1,
      visitorIds: [visitorId],
      updatedAt: timestamp,
    };
    return true;
  }

  existingPage.visits += 1;
  existingPage.updatedAt = timestamp;

  if (existingPage.title !== page.title || existingPage.path !== page.path) {
    existingPage.title = page.title;
    existingPage.path = page.path;
  }

  if (!existingPage.visitorIds.includes(visitorId)) {
    existingPage.visitorIds.push(visitorId);
  }

  return changed;
};

const ensurePeriodBucket = (buckets: Record<string, VisitorStatsBucket>, key: string): VisitorStatsBucket => {
  buckets[key] ??= createEmptyBucket();
  return buckets[key];
};

const prunePeriodBuckets = (
  buckets: Record<string, VisitorStatsBucket>,
  currentKey: string,
  maxBuckets: number,
): boolean => {
  const removableKeys = Object.keys(buckets)
    .filter((key) => key !== currentKey)
    .sort((left, right) => right.localeCompare(left));
  let changed = false;

  while (removableKeys.length >= maxBuckets) {
    const key = removableKeys.pop();
    if (!key) {
      break;
    }

    delete buckets[key];
    changed = true;
  }

  return changed;
};

export const recordVisitorInStats = (
  stats: VisitorStatsStore,
  page: VisitorPageIdentity,
  visitorId: string,
  visitedAt = new Date(),
): boolean => {
  if (!page.slug || !visitorId) {
    return false;
  }

  const timestamp = visitedAt.toISOString();
  const keys = getPeriodKeys(visitedAt);
  const changed = [
    upsertVisitor(stats.allTime, page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.allTimeDaily, keys.daily), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.hourly, keys.hourly), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.daily, keys.daily), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.weekly, keys.weekly), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.monthly, keys.monthly), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.yearly, keys.yearly), page, visitorId, timestamp),
    prunePeriodBuckets(stats.hourly, keys.hourly, VISITOR_STATS_RETENTION.hourly),
    prunePeriodBuckets(stats.daily, keys.daily, VISITOR_STATS_RETENTION.daily),
    prunePeriodBuckets(stats.weekly, keys.weekly, VISITOR_STATS_RETENTION.weekly),
    prunePeriodBuckets(stats.monthly, keys.monthly, VISITOR_STATS_RETENTION.monthly),
    prunePeriodBuckets(stats.yearly, keys.yearly, VISITOR_STATS_RETENTION.yearly),
  ].some(Boolean);

  if (changed) {
    stats.updatedAt = timestamp;
  }

  return changed;
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
  bucket: VisitorStatsBucket | undefined,
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

  for (const page of Object.values(bucket?.pages ?? {})) {
    pages.set(page.slug, {
      path: page.path,
      slug: page.slug,
      title: page.title,
      visits: page.visits,
      visitors: page.visitorIds.length,
    });
  }

  return [...pages.values()]
    .sort((left, right) => right.visits - left.visits || right.visitors - left.visitors || left.title.localeCompare(right.title));
};

const summarizePeriods = (
  buckets: Record<string, VisitorStatsBucket>,
  currentKey: string,
  labelForKey: (key: string) => string,
): VisitorStatsPeriodSummary[] => {
  const periodKeys = new Set([...Object.keys(buckets), currentKey]);

  return [...periodKeys]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({
      key,
      label: labelForKey(key),
      visits: bucketVisitCount(buckets[key]),
      visitors: bucketVisitorCount(buckets[key]),
      current: key === currentKey,
    }));
};

const summarizeCurrentDayHours = (
  buckets: Record<string, VisitorStatsBucket>,
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
      visits: bucketVisitCount(buckets[key]),
      visitors: bucketVisitorCount(buckets[key]),
      current: key === currentKey,
    };
  });
};

const summarizeScope = (
  buckets: Record<string, VisitorStatsBucket>,
  currentKey: string,
  labelForKey: (key: string) => string,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const currentBucket = buckets[currentKey];

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
  dailyBuckets: Record<string, VisitorStatsBucket>,
  hourlyBuckets: Record<string, VisitorStatsBucket>,
  currentDayKey: string,
  now: Date,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const currentBucket = dailyBuckets[currentDayKey];

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
  const allTimePeriods = summarizePeriods(stats.allTimeDaily, keys.daily, labelDay);

  return {
    updatedAt: stats.updatedAt,
    scopes: {
      allTime: {
        totalVisits: bucketVisitCount(stats.allTime),
        totalVisitors: bucketVisitorCount(stats.allTime),
        currentPeriodKey: "all-time",
        currentPeriodLabel: "All time",
        periods: allTimePeriods,
        pages: summarizePages(stats.allTime, knownPages),
      },
      daily: summarizeDailyScope(stats.daily, stats.hourly, keys.daily, now, knownPages),
      weekly: summarizeScope(stats.weekly, keys.weekly, labelWeek, knownPages),
      monthly: summarizeScope(stats.monthly, keys.monthly, labelMonth, knownPages),
      yearly: summarizeScope(stats.yearly, keys.yearly, (key) => key, knownPages),
    },
  };
};
