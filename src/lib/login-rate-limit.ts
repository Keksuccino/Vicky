import path from "node:path";

import { getClientIp } from "@/lib/client-ip-policy";
import { createLoginRateLimitStorage } from "@/lib/login-rate-limit-storage.mjs";
import type { NextRequest } from "next/server";

type LoginAttemptState = {
  failedAt: number[];
  blockedUntil: number;
  lastFailureAt: number;
  // A durable mirror may be discarded when another process clears SQLite. State created
  // during an outage remains authoritative locally until its own bounded window expires.
  durableBacked: boolean;
};

type DurableStatus = LoginRateLimitStatus & {
  identity: string;
  blockedUntil: number;
};

type DurableFailedStatus = DurableStatus & {
  attemptsLeft: number;
};

type LoginRateLimitStorage = {
  migrationWarning: string | null;
  verifyPrivateFiles: () => void;
  getStatus: (identity: string, now?: number) => DurableStatus;
  registerFailure: (identity: string, now?: number) => DurableFailedStatus;
  clear: (identity: string, now?: number) => string;
  close: () => void;
};

type GlobalStorageState = {
  signature: string;
  storage: LoginRateLimitStorage;
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
const DEFAULT_MAX_IDENTITIES = 10_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MIN_POSITIVE_VALUE = 1;
const MAX_FAILED_ATTEMPTS_LIMIT = 100;
const MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_BLOCK_SECONDS = 30 * 24 * 60 * 60;
const MAX_IDENTITIES_LIMIT = 100_000;
const MAX_BUSY_TIMEOUT_MS = 30_000;
const PRUNE_INTERVAL = 64;
const WARNING_INTERVAL_MS = 60_000;
const WARNING_MESSAGE_LIMIT = 300;
const GLOBAL_SAFETY_IDENTITY = "__global__";
const STORAGE_STATE_KEY = Symbol.for("vicky.login-rate-limit.sqlite");
const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "login-rate-limit.sqlite");
const DEFAULT_LEGACY_STORE_PATH = path.join(process.cwd(), "data", "login-rate-limit.json");

const parseBoundedPositiveInt = (value: string | undefined, fallback: number, maximum: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= MIN_POSITIVE_VALUE && parsed <= maximum ? parsed : fallback;
};

const MAX_FAILED_ATTEMPTS = parseBoundedPositiveInt(process.env.AUTH_LOGIN_MAX_FAILURES, DEFAULT_MAX_FAILED_ATTEMPTS, MAX_FAILED_ATTEMPTS_LIMIT);
const WINDOW_MS = parseBoundedPositiveInt(process.env.AUTH_LOGIN_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS, MAX_WINDOW_SECONDS) * 1000;
const BLOCK_MS = parseBoundedPositiveInt(process.env.AUTH_LOGIN_BLOCK_SECONDS, DEFAULT_BLOCK_SECONDS, MAX_BLOCK_SECONDS) * 1000;
const MAX_IDENTITIES = parseBoundedPositiveInt(process.env.AUTH_LOGIN_MAX_IDENTITIES, DEFAULT_MAX_IDENTITIES, MAX_IDENTITIES_LIMIT);
const BUSY_TIMEOUT_MS = parseBoundedPositiveInt(process.env.AUTH_LOGIN_DB_BUSY_TIMEOUT_MS, DEFAULT_BUSY_TIMEOUT_MS, MAX_BUSY_TIMEOUT_MS);
const ENTRY_TTL_MS = Math.max(BLOCK_MS, WINDOW_MS) * 2;

const configuredLegacyPath = process.env.AUTH_LOGIN_STORE_FILE_PATH?.trim() || DEFAULT_LEGACY_STORE_PATH;
const derivedDbPath = configuredLegacyPath.toLowerCase().endsWith(".json") ? configuredLegacyPath.slice(0, -5) + ".sqlite" : `${configuredLegacyPath}.sqlite`;
const DB_PATH = process.env.AUTH_LOGIN_DB_PATH?.trim() || (process.env.AUTH_LOGIN_STORE_FILE_PATH ? derivedDbPath : DEFAULT_DB_PATH);
const STORAGE_SIGNATURE = JSON.stringify({ DB_PATH, configuredLegacyPath, MAX_FAILED_ATTEMPTS, WINDOW_MS, BLOCK_MS, MAX_IDENTITIES, BUSY_TIMEOUT_MS });

const fallbackAttempts = new Map<string, LoginAttemptState>();
let fallbackMutationsUntilPrune = PRUNE_INTERVAL;
let lastPersistenceWarningAt = 0;

const getGlobalState = (): GlobalStorageState | null => {
  const globalState = globalThis as typeof globalThis & Record<symbol, GlobalStorageState | undefined>;
  return globalState[STORAGE_STATE_KEY] ?? null;
};

const setGlobalState = (state: GlobalStorageState): void => {
  const globalState = globalThis as typeof globalThis & Record<symbol, GlobalStorageState | undefined>;
  globalState[STORAGE_STATE_KEY] = state;
};

const clearGlobalState = (): void => {
  const globalState = globalThis as typeof globalThis & Record<symbol, GlobalStorageState | undefined>;
  const existing = globalState[STORAGE_STATE_KEY];
  existing?.storage.close();
  delete globalState[STORAGE_STATE_KEY];
};

const boundedMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, WARNING_MESSAGE_LIMIT);
};

const warnPersistenceFailure = (action: string, error: unknown): void => {
  const now = Date.now();
  if (lastPersistenceWarningAt > 0 && now >= lastPersistenceWarningAt && now - lastPersistenceWarningAt < WARNING_INTERVAL_MS) {
    return;
  }

  lastPersistenceWarningAt = now;
  console.warn(`[auth] Failed to ${action} durable login rate-limit state; using the bounded in-memory fallback: ${boundedMessage(error)}`);
};

const createStorage = (): LoginRateLimitStorage => {
  const storage = createLoginRateLimitStorage({
    dbPath: DB_PATH,
    legacyStorePath: configuredLegacyPath,
    maxFailures: MAX_FAILED_ATTEMPTS,
    windowMs: WINDOW_MS,
    blockMs: BLOCK_MS,
    entryTtlMs: ENTRY_TTL_MS,
    maxIdentities: MAX_IDENTITIES,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    pruneInterval: PRUNE_INTERVAL,
    now: Date.now,
  }) as LoginRateLimitStorage;
  if (storage.migrationWarning) {
    console.warn(`[auth] Legacy login rate-limit JSON was preserved but could not be migrated safely; a global block window was activated: ${boundedMessage(storage.migrationWarning)}`);
  }
  return storage;
};

const getStorage = (): LoginRateLimitStorage => {
  const existing = getGlobalState();
  if (existing?.signature === STORAGE_SIGNATURE) {
    existing.storage.verifyPrivateFiles();
    return existing.storage;
  }
  if (existing) {
    clearGlobalState();
  }

  const storage = createStorage();
  setGlobalState({ signature: STORAGE_SIGNATURE, storage });
  return storage;
};

const discardStorage = (): void => {
  clearGlobalState();
};

const pruneFallback = (now: number): void => {
  for (const [identity, state] of fallbackAttempts) {
    state.failedAt = state.failedAt.filter((failedAt) => failedAt >= now - WINDOW_MS);
    if (state.blockedUntil <= now && state.failedAt.length === 0 && state.lastFailureAt < now - ENTRY_TTL_MS) {
      fallbackAttempts.delete(identity);
    }
  }
};

const fallbackKnownIdentityCount = (): number => {
  let count = fallbackAttempts.size;
  if (fallbackAttempts.has("unknown")) {
    count -= 1;
  }
  if (fallbackAttempts.has(GLOBAL_SAFETY_IDENTITY)) {
    count -= 1;
  }
  return count;
};

const fallbackIdentity = (requestedIdentity: string, now: number): string => {
  if (requestedIdentity === "unknown" || requestedIdentity === GLOBAL_SAFETY_IDENTITY || fallbackAttempts.has(requestedIdentity)) {
    return requestedIdentity;
  }
  if (fallbackKnownIdentityCount() < MAX_IDENTITIES) {
    return requestedIdentity;
  }

  pruneFallback(now);
  return fallbackKnownIdentityCount() < MAX_IDENTITIES ? requestedIdentity : "unknown";
};

const fallbackStatus = (requestedIdentity: string, now: number): DurableStatus => {
  const safetyBlockUntil = fallbackAttempts.get(GLOBAL_SAFETY_IDENTITY)?.blockedUntil ?? 0;
  if (safetyBlockUntil > now) {
    return {
      identity: GLOBAL_SAFETY_IDENTITY,
      blocked: true,
      blockedUntil: safetyBlockUntil,
      retryAfterSeconds: Math.ceil((safetyBlockUntil - now) / 1000),
    };
  }

  const identity = fallbackIdentity(requestedIdentity, now);
  const blockedUntil = fallbackAttempts.get(identity)?.blockedUntil ?? 0;
  return {
    identity,
    blocked: blockedUntil > now,
    blockedUntil,
    retryAfterSeconds: Math.max(0, Math.ceil((blockedUntil - now) / 1000)),
  };
};

const fallbackRegister = (requestedIdentity: string, now: number): DurableFailedStatus => {
  const safetyStatus = fallbackStatus(requestedIdentity, now);
  if (safetyStatus.identity === GLOBAL_SAFETY_IDENTITY && safetyStatus.blocked) {
    return { ...safetyStatus, attemptsLeft: 0 };
  }

  fallbackMutationsUntilPrune -= 1;
  if (fallbackMutationsUntilPrune <= 0) {
    pruneFallback(now);
    fallbackMutationsUntilPrune = PRUNE_INTERVAL;
  }

  const identity = fallbackIdentity(requestedIdentity, now);
  const state = fallbackAttempts.get(identity) ?? { failedAt: [], blockedUntil: 0, lastFailureAt: now, durableBacked: false };
  fallbackAttempts.set(identity, state);
  if (state.blockedUntil > now) {
    return { ...fallbackStatus(identity, now), attemptsLeft: 0 };
  }

  state.failedAt = state.failedAt.filter((failedAt) => failedAt >= now - WINDOW_MS);
  state.failedAt.push(now);
  state.lastFailureAt = now;
  if (state.failedAt.length >= MAX_FAILED_ATTEMPTS) {
    state.failedAt = [];
    state.blockedUntil = now + BLOCK_MS;
    return { ...fallbackStatus(identity, now), attemptsLeft: 0 };
  }

  state.blockedUntil = 0;
  return { ...fallbackStatus(identity, now), attemptsLeft: MAX_FAILED_ATTEMPTS - state.failedAt.length };
};

const mirrorDurableStatus = (status: DurableStatus, now: number, attemptsLeft?: number): void => {
  const identity = fallbackIdentity(status.identity, now);
  if (status.blocked) {
    fallbackAttempts.set(identity, { failedAt: [], blockedUntil: status.blockedUntil, lastFailureAt: now, durableBacked: true });
    return;
  }
  if (attemptsLeft === undefined) {
    return;
  }

  const failureCount = Math.max(0, MAX_FAILED_ATTEMPTS - attemptsLeft);
  fallbackAttempts.set(identity, { failedAt: Array.from({ length: failureCount }, () => now), blockedUntil: 0, lastFailureAt: now, durableBacked: true });
};

const isUndurableFallback = (identity: string): boolean => fallbackAttempts.get(identity)?.durableBacked === false;

const markFallbackUndurable = (identity: string): void => {
  const state = fallbackAttempts.get(identity);
  if (state) {
    state.durableBacked = false;
  }
};

const publicStatus = ({ blocked, retryAfterSeconds }: DurableStatus): LoginRateLimitStatus => ({ blocked, retryAfterSeconds });
const publicFailedStatus = ({ blocked, retryAfterSeconds, attemptsLeft }: DurableFailedStatus): FailedLoginAttemptStatus => ({ blocked, retryAfterSeconds, attemptsLeft });

export const getLoginRateLimitStatus = async (request: NextRequest): Promise<LoginRateLimitStatus> => {
  const identity = getClientIp(request);
  const now = Date.now();
  const fallback = fallbackStatus(identity, now);
  try {
    const status = getStorage().getStatus(identity, now);
    if (status.blocked) {
      mirrorDurableStatus(status, now);
      return publicStatus(status);
    }
    if (fallback.blocked && isUndurableFallback(fallback.identity)) {
      return publicStatus(fallback);
    }
    if (fallback.blocked) {
      fallbackAttempts.delete(fallback.identity);
    }
    return publicStatus(status);
  } catch (error) {
    discardStorage();
    warnPersistenceFailure("read", error);
    return publicStatus(fallback);
  }
};

export const registerFailedLoginAttempt = async (request: NextRequest): Promise<FailedLoginAttemptStatus> => {
  const identity = getClientIp(request);
  const now = Date.now();
  const fallback = fallbackRegister(identity, now);
  try {
    const status = getStorage().registerFailure(identity, now);
    if (status.blocked) {
      mirrorDurableStatus(status, now, status.attemptsLeft);
      return publicFailedStatus(status);
    }
    if ((fallback.blocked || fallback.attemptsLeft < status.attemptsLeft) && isUndurableFallback(fallback.identity)) {
      return publicFailedStatus(fallback);
    }
    mirrorDurableStatus(status, now, status.attemptsLeft);
    return publicFailedStatus(status);
  } catch (error) {
    discardStorage();
    markFallbackUndurable(fallback.identity);
    warnPersistenceFailure("update", error);
    return publicFailedStatus(fallback);
  }
};

export const clearFailedLoginAttempts = async (request: NextRequest): Promise<void> => {
  const identity = getClientIp(request);
  const now = Date.now();
  try {
    const clearedIdentity = getStorage().clear(identity, now);
    fallbackAttempts.delete(clearedIdentity);
    fallbackAttempts.delete(fallbackIdentity(identity, now));
  } catch (error) {
    discardStorage();
    warnPersistenceFailure("clear", error);
    fallbackAttempts.delete(fallbackIdentity(identity, now));
  }
};

export const resetLoginRateLimitStorageForTests = (): void => {
  clearGlobalState();
  fallbackAttempts.clear();
  fallbackMutationsUntilPrune = PRUNE_INTERVAL;
  lastPersistenceWarningAt = 0;
};
