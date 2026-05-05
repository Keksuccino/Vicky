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
  visitorIds: [],
  pages: {},
});

const bucketVisitorCount = (bucket: VisitorStatsBucket | undefined): number => bucket?.visitorIds.length ?? 0;

const upsertVisitor = (
  bucket: VisitorStatsBucket,
  page: VisitorPageIdentity,
  visitorId: string,
  timestamp: string,
): boolean => {
  let changed = false;

  if (!bucket.visitorIds.includes(visitorId)) {
    bucket.visitorIds.push(visitorId);
    changed = true;
  }

  const existingPage = bucket.pages[page.slug];
  if (!existingPage) {
    bucket.pages[page.slug] = {
      ...page,
      visitorIds: [visitorId],
      updatedAt: timestamp,
    };
    return true;
  }

  if (existingPage.title !== page.title || existingPage.path !== page.path) {
    existingPage.title = page.title;
    existingPage.path = page.path;
    changed = true;
  }

  if (!existingPage.visitorIds.includes(visitorId)) {
    existingPage.visitorIds.push(visitorId);
    existingPage.updatedAt = timestamp;
    changed = true;
  }

  return changed;
};

const ensurePeriodBucket = (buckets: Record<string, VisitorStatsBucket>, key: string): VisitorStatsBucket => {
  buckets[key] ??= createEmptyBucket();
  return buckets[key];
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
    upsertVisitor(ensurePeriodBucket(stats.daily, keys.daily), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.weekly, keys.weekly), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.monthly, keys.monthly), page, visitorId, timestamp),
    upsertVisitor(ensurePeriodBucket(stats.yearly, keys.yearly), page, visitorId, timestamp),
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
      visitors: 0,
    });
  }

  for (const page of Object.values(bucket?.pages ?? {})) {
    pages.set(page.slug, {
      path: page.path,
      slug: page.slug,
      title: page.title,
      visitors: page.visitorIds.length,
    });
  }

  return [...pages.values()]
    .sort((left, right) => right.visitors - left.visitors || left.title.localeCompare(right.title));
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
      visitors: bucketVisitorCount(buckets[key]),
      current: key === currentKey,
    }));
};

const summarizeScope = (
  buckets: Record<string, VisitorStatsBucket>,
  currentKey: string,
  labelForKey: (key: string) => string,
  knownPages: VisitorPageIdentity[],
): VisitorStatsScopeSummary => {
  const currentBucket = buckets[currentKey];

  return {
    totalVisitors: bucketVisitorCount(currentBucket),
    currentPeriodKey: currentKey,
    currentPeriodLabel: labelForKey(currentKey),
    periods: summarizePeriods(buckets, currentKey, labelForKey),
    pages: summarizePages(currentBucket, knownPages),
  };
};

export const createVisitorStatsSummary = (
  stats: VisitorStatsStore,
  now = new Date(),
  knownPages: VisitorPageIdentity[] = [],
): VisitorStatsSummary => {
  const keys = getPeriodKeys(now);

  return {
    updatedAt: stats.updatedAt,
    scopes: {
      allTime: {
        totalVisitors: bucketVisitorCount(stats.allTime),
        currentPeriodKey: "all-time",
        currentPeriodLabel: "All time",
        periods: [
          {
            key: "all-time",
            label: "All time",
            visitors: bucketVisitorCount(stats.allTime),
            current: true,
          },
        ],
        pages: summarizePages(stats.allTime, knownPages),
      },
      daily: summarizeScope(stats.daily, keys.daily, labelDay, knownPages),
      weekly: summarizeScope(stats.weekly, keys.weekly, labelWeek, knownPages),
      monthly: summarizeScope(stats.monthly, keys.monthly, labelMonth, knownPages),
      yearly: summarizeScope(stats.yearly, keys.yearly, (key) => key, knownPages),
    },
  };
};
