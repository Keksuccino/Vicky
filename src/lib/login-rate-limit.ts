import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

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

export type FailedLoginAttemptStatus = LoginRateLimitStatus & {
  attemptsLeft: number;
};

const DEFAULT_MAX_FAILED_ATTEMPTS = 8;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_BLOCK_SECONDS = 3 * 60 * 60;
const MIN_POSITIVE_SECONDS = 1;
const MAX_IP_LENGTH = 128;
const STORE_VERSION = 1 as const;
const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "login-rate-limit.json");
const STORE_PATH = process.env.AUTH_LOGIN_STORE_FILE_PATH ?? DEFAULT_STORE_PATH;
const TRUST_PROXY_HEADERS = String(process.env.AUTH_TRUST_PROXY_HEADERS ?? "")
  .trim()
  .toLowerCase() === "true";

type PersistedLoginRateLimitStore = {
  version: typeof STORE_VERSION;
  entries: Record<string, LoginAttemptState>;
};

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
let mutationQueue: Promise<unknown> = Promise.resolve();

const enqueueMutation = <T>(work: () => Promise<T>): Promise<T> => {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
};

const cloneAttemptState = (state: LoginAttemptState): LoginAttemptState => ({
  failedAt: [...state.failedAt],
  blockedUntil: state.blockedUntil,
  lastSeenAt: state.lastSeenAt,
});

const cloneAttemptsMap = (source: Map<string, LoginAttemptState>): Map<string, LoginAttemptState> =>
  new Map([...source.entries()].map(([key, value]) => [key, cloneAttemptState(value)]));

const replaceInMemoryAttempts = (next: Map<string, LoginAttemptState>): void => {
  attemptsByIp.clear();

  for (const [key, value] of next.entries()) {
    attemptsByIp.set(key, cloneAttemptState(value));
  }
};

const toTimestamp = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
};

const toStoreKey = (value: string): string | null => {
  if (value === "unknown") {
    return "unknown";
  }

  return normalizeIp(value);
};

const normalizeAttemptState = (value: unknown): LoginAttemptState | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const blockedUntil = toTimestamp(source.blockedUntil);
  const lastSeenAt = toTimestamp(source.lastSeenAt);
  const failedAtRaw = Array.isArray(source.failedAt) ? source.failedAt : [];
  const failedAt = failedAtRaw
    .map((entry) => toTimestamp(entry))
    .filter((entry): entry is number => entry !== null);

  if (blockedUntil === null || lastSeenAt === null) {
    return null;
  }

  return {
    failedAt,
    blockedUntil,
    lastSeenAt,
  };
};

const parsePersistedStore = (value: unknown): Map<string, LoginAttemptState> => {
  if (typeof value !== "object" || value === null) {
    return new Map();
  }

  const source = value as Record<string, unknown>;
  const rawEntries =
    typeof source.entries === "object" && source.entries !== null
      ? (source.entries as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const parsed = new Map<string, LoginAttemptState>();

  for (const [rawKey, rawEntry] of Object.entries(rawEntries)) {
    const key = toStoreKey(rawKey);
    const entry = normalizeAttemptState(rawEntry);

    if (!key || !entry) {
      continue;
    }

    parsed.set(key, entry);
  }

  return parsed;
};

const toPersistedStore = (source: Map<string, LoginAttemptState>): PersistedLoginRateLimitStore => ({
  version: STORE_VERSION,
  entries: Object.fromEntries(
    [...source.entries()].map(([key, value]) => [
      key,
      {
        failedAt: [...value.failedAt],
        blockedUntil: value.blockedUntil,
        lastSeenAt: value.lastSeenAt,
      },
    ]),
  ),
});

const readAttemptStore = async (): Promise<Map<string, LoginAttemptState>> => {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = parsePersistedStore(JSON.parse(raw) as unknown);
    replaceInMemoryAttempts(parsed);
    return parsed;
  } catch {
    return cloneAttemptsMap(attemptsByIp);
  }
};

const writeAttemptStore = async (source: Map<string, LoginAttemptState>): Promise<void> => {
  replaceInMemoryAttempts(source);

  try {
    await mkdir(path.dirname(STORE_PATH), { recursive: true });
    const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempPath, JSON.stringify(toPersistedStore(source), null, 2), "utf8");
    await rename(tempPath, STORE_PATH);
  } catch {
    // Keep in-memory fallback when filesystem persistence is unavailable.
  }
};

const normalizeIp = (value: string): string | null => {
  const cleaned = value.trim().slice(0, MAX_IP_LENGTH);
  if (!cleaned) {
    return null;
  }

  if (isIP(cleaned)) {
    return cleaned;
  }

  const ipv4WithPort = cleaned.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  if (ipv4WithPort && isIP(ipv4WithPort[1])) {
    return ipv4WithPort[1];
  }

  const ipv6WithPort = cleaned.match(/^\[([0-9a-f:]+)\](?::\d+)?$/i);
  if (ipv6WithPort && isIP(ipv6WithPort[1])) {
    return ipv6WithPort[1];
  }

  return null;
};

const getForwardedIp = (request: NextRequest): string | null => {
  if (!TRUST_PROXY_HEADERS) {
    return null;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0];
    const parsed = normalizeIp(first);
    if (parsed) {
      return parsed;
    }
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    const parsed = normalizeIp(realIp);
    if (parsed) {
      return parsed;
    }
  }

  return null;
};

export const getClientIp = (request: NextRequest): string => {
  const directIp = (request as NextRequest & { ip?: string }).ip;
  if (typeof directIp === "string") {
    const parsed = normalizeIp(directIp);
    if (parsed) {
      return parsed;
    }
  }

  const forwardedIp = getForwardedIp(request);
  if (forwardedIp) {
    return forwardedIp;
  }

  return "unknown";
};

const pruneOldEntries = (source: Map<string, LoginAttemptState>, now: number): boolean => {
  let changed = false;

  for (const [key, value] of source.entries()) {
    const blockedExpired = value.blockedUntil <= now;
    const recentFailures = value.failedAt.filter((attemptAt) => now - attemptAt <= WINDOW_MS);
    const isStale = now - value.lastSeenAt > ENTRY_TTL_MS;

    if (recentFailures.length === 0 && blockedExpired && isStale) {
      source.delete(key);
      changed = true;
      continue;
    }

    if (recentFailures.length !== value.failedAt.length) {
      changed = true;
    }
    value.failedAt = recentFailures;

    if (blockedExpired) {
      if (value.blockedUntil !== 0) {
        changed = true;
      }
      value.blockedUntil = 0;
    }
  }

  return changed;
};

const getAttemptState = (
  source: Map<string, LoginAttemptState>,
  ip: string,
  now: number,
): { state: LoginAttemptState; created: boolean } => {
  const existing = source.get(ip);
  if (existing) {
    return { state: existing, created: false };
  }

  const created: LoginAttemptState = {
    failedAt: [],
    blockedUntil: 0,
    lastSeenAt: now,
  };

  source.set(ip, created);
  return { state: created, created: true };
};

const toRateLimitStatus = (blockedUntil: number, now: number): LoginRateLimitStatus => {
  const retryAfterSeconds = Math.max(0, Math.ceil((blockedUntil - now) / 1000));
  return {
    blocked: retryAfterSeconds > 0,
    retryAfterSeconds,
  };
};

const withAttemptStore = async <T>(
  work: (source: Map<string, LoginAttemptState>, now: number) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean },
): Promise<T> =>
  enqueueMutation(async () => {
    const source = await readAttemptStore();
    const now = Date.now();
    const { result, changed } = await work(source, now);
    if (changed) {
      await writeAttemptStore(source);
    }
    return result;
  });

export const getLoginRateLimitStatus = async (request: NextRequest): Promise<LoginRateLimitStatus> =>
  withAttemptStore((source, now) => {
    let changed = pruneOldEntries(source, now);

    const ip = getClientIp(request);
    const state = source.get(ip);
    if (!state) {
      return { result: { blocked: false, retryAfterSeconds: 0 }, changed };
    }

    if (state.lastSeenAt !== now) {
      state.lastSeenAt = now;
      changed = true;
    }

    if (state.blockedUntil <= now) {
      if (state.blockedUntil !== 0) {
        state.blockedUntil = 0;
        changed = true;
      }

      return { result: { blocked: false, retryAfterSeconds: 0 }, changed };
    }

    return { result: toRateLimitStatus(state.blockedUntil, now), changed };
  });

export const registerFailedLoginAttempt = async (request: NextRequest): Promise<FailedLoginAttemptStatus> =>
  withAttemptStore((source, now) => {
    let changed = pruneOldEntries(source, now);

    const ip = getClientIp(request);
    const { state, created } = getAttemptState(source, ip, now);
    if (created) {
      changed = true;
    }

    if (state.lastSeenAt !== now) {
      state.lastSeenAt = now;
      changed = true;
    }

    if (state.blockedUntil > now) {
      return {
        result: {
          ...toRateLimitStatus(state.blockedUntil, now),
          attemptsLeft: 0,
        },
        changed,
      };
    }

    const recentFailures = state.failedAt.filter((attemptAt) => now - attemptAt <= WINDOW_MS);
    if (recentFailures.length !== state.failedAt.length) {
      changed = true;
    }

    recentFailures.push(now);
    state.failedAt = recentFailures;
    changed = true;

    if (state.failedAt.length >= MAX_FAILED_ATTEMPTS) {
      state.blockedUntil = now + BLOCK_MS;
      state.failedAt = [];
      return {
        result: {
          ...toRateLimitStatus(state.blockedUntil, now),
          attemptsLeft: 0,
        },
        changed: true,
      };
    }

    return {
      result: {
        blocked: false,
        retryAfterSeconds: 0,
        attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - state.failedAt.length),
      },
      changed,
    };
  });

export const clearFailedLoginAttempts = async (request: NextRequest): Promise<void> => {
  await withAttemptStore((source, now) => {
    const changedByPrune = pruneOldEntries(source, now);
    const ip = getClientIp(request);
    const changedByDelete = source.delete(ip);

    return {
      result: undefined,
      changed: changedByPrune || changedByDelete,
    };
  });
};
