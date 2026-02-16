import type { NextRequest } from "next/server";

type LoginAttemptState = {
  failedAt: number[];
  blockedUntil: number;
  lastSeenAt: number;
};

export type LoginRateLimitStatus = {
  blocked: boolean;
  retryAfterSeconds: number;
};

const DEFAULT_MAX_FAILED_ATTEMPTS = 8;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_BLOCK_SECONDS = 3 * 60 * 60;
const PRUNE_INTERVAL_MS = 60 * 1000;
const MIN_POSITIVE_SECONDS = 1;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_POSITIVE_SECONDS) {
    return fallback;
  }

  return parsed;
};

const MAX_FAILED_ATTEMPTS = parsePositiveInt(process.env.AUTH_LOGIN_MAX_FAILURES, DEFAULT_MAX_FAILED_ATTEMPTS);
const WINDOW_MS = parsePositiveInt(process.env.AUTH_LOGIN_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS) * 1000;
const BLOCK_MS = parsePositiveInt(process.env.AUTH_LOGIN_BLOCK_SECONDS, DEFAULT_BLOCK_SECONDS) * 1000;
const ENTRY_TTL_MS = Math.max(BLOCK_MS, WINDOW_MS) * 2;

const attemptsByIp = new Map<string, LoginAttemptState>();
let lastPruneAt = 0;

const cleanIpHeaderValue = (value: string): string => value.trim().slice(0, 128);

export const getClientIp = (request: NextRequest): string => {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0];
    const cleaned = cleanIpHeaderValue(first);
    if (cleaned) {
      return cleaned;
    }
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    const cleaned = cleanIpHeaderValue(realIp);
    if (cleaned) {
      return cleaned;
    }
  }

  const directIp = (request as NextRequest & { ip?: string }).ip;
  if (typeof directIp === "string") {
    const cleaned = cleanIpHeaderValue(directIp);
    if (cleaned) {
      return cleaned;
    }
  }

  return "unknown";
};

const pruneOldEntries = (now: number): void => {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) {
    return;
  }

  for (const [key, value] of attemptsByIp.entries()) {
    const blockedExpired = value.blockedUntil <= now;
    const recentFailures = value.failedAt.filter((attemptAt) => now - attemptAt <= WINDOW_MS);
    const isStale = now - value.lastSeenAt > ENTRY_TTL_MS;

    if (recentFailures.length === 0 && blockedExpired && isStale) {
      attemptsByIp.delete(key);
      continue;
    }

    value.failedAt = recentFailures;
    if (blockedExpired) {
      value.blockedUntil = 0;
    }
  }

  lastPruneAt = now;
};

const getAttemptState = (ip: string, now: number): LoginAttemptState => {
  const existing = attemptsByIp.get(ip);
  if (existing) {
    return existing;
  }

  const created: LoginAttemptState = {
    failedAt: [],
    blockedUntil: 0,
    lastSeenAt: now,
  };

  attemptsByIp.set(ip, created);
  return created;
};

const toRateLimitStatus = (blockedUntil: number, now: number): LoginRateLimitStatus => {
  const retryAfterSeconds = Math.max(0, Math.ceil((blockedUntil - now) / 1000));
  return {
    blocked: retryAfterSeconds > 0,
    retryAfterSeconds,
  };
};

export const getLoginRateLimitStatus = (request: NextRequest): LoginRateLimitStatus => {
  const now = Date.now();
  pruneOldEntries(now);

  const ip = getClientIp(request);
  const state = attemptsByIp.get(ip);
  if (!state) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  state.lastSeenAt = now;
  if (state.blockedUntil <= now) {
    state.blockedUntil = 0;
    return { blocked: false, retryAfterSeconds: 0 };
  }

  return toRateLimitStatus(state.blockedUntil, now);
};

export const registerFailedLoginAttempt = (request: NextRequest): LoginRateLimitStatus => {
  const now = Date.now();
  pruneOldEntries(now);

  const ip = getClientIp(request);
  const state = getAttemptState(ip, now);
  state.lastSeenAt = now;

  if (state.blockedUntil > now) {
    return toRateLimitStatus(state.blockedUntil, now);
  }

  state.failedAt = state.failedAt.filter((attemptAt) => now - attemptAt <= WINDOW_MS);
  state.failedAt.push(now);

  if (state.failedAt.length >= MAX_FAILED_ATTEMPTS) {
    state.blockedUntil = now + BLOCK_MS;
    state.failedAt = [];
    return toRateLimitStatus(state.blockedUntil, now);
  }

  return { blocked: false, retryAfterSeconds: 0 };
};

export const clearFailedLoginAttempts = (request: NextRequest): void => {
  const now = Date.now();
  pruneOldEntries(now);

  const ip = getClientIp(request);
  attemptsByIp.delete(ip);
};
