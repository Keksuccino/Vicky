import type { NextRequest } from "next/server";

import { getClientIp } from "@/lib/client-ip-policy";

type ClientAdmissionState = {
  activeRequests: number;
  lastSeenAt: number;
  requestedAt: number[];
};

export type VisitorIngestionPermit =
  | {
      allowed: true;
      release: () => void;
    }
  | {
      allowed: false;
      retryAfterSeconds: number;
    };

const DEFAULT_CLIENT_MAX_REQUESTS = 60;
const DEFAULT_GLOBAL_MAX_REQUESTS = 1_200;
const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_CLIENT_MAX_CONCURRENCY = 4;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 32;
const MAX_TRACKED_CLIENTS = 10_000;
const MAX_CLIENT_REQUEST_LIMIT = 1_000;
const MAX_GLOBAL_REQUEST_LIMIT = 10_000;
const MAX_RATE_WINDOW_SECONDS = 3_600;
const MAX_CONCURRENCY_LIMIT = 256;

const parseBoundedPositiveInteger = (value: string | undefined, fallback: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const CLIENT_MAX_REQUESTS = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS, DEFAULT_CLIENT_MAX_REQUESTS, MAX_CLIENT_REQUEST_LIMIT);
const GLOBAL_MAX_REQUESTS = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS, DEFAULT_GLOBAL_MAX_REQUESTS, MAX_GLOBAL_REQUEST_LIMIT);
const RATE_WINDOW_MS = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_RATE_WINDOW_SECONDS, DEFAULT_RATE_WINDOW_SECONDS, MAX_RATE_WINDOW_SECONDS) * 1_000;
const CLIENT_MAX_CONCURRENCY = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_CLIENT_MAX_CONCURRENCY, DEFAULT_CLIENT_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT);
const GLOBAL_MAX_CONCURRENCY = parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_GLOBAL_MAX_CONCURRENCY, DEFAULT_GLOBAL_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT);
const CLIENT_STATE_TTL_MS = RATE_WINDOW_MS * 2;
const CLIENT_PRUNE_INTERVAL_MS = Math.min(RATE_WINDOW_MS, 30_000);

const clients = new Map<string, ClientAdmissionState>();
let globalActiveRequests = 0;
let globalRequestedAt: number[] = [];
let lastClientPruneAt = Number.NEGATIVE_INFINITY;

const withinWindow = (timestamp: number, now: number): boolean => now - timestamp < RATE_WINDOW_MS;

const retryAfterFor = (timestamps: number[], now: number): number => {
  const oldest = timestamps[0];
  return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1_000));
};

const pruneAdmissionState = (now: number): void => {
  globalRequestedAt = globalRequestedAt.filter((timestamp) => withinWindow(timestamp, now));

  if (now - lastClientPruneAt < CLIENT_PRUNE_INTERVAL_MS) {
    return;
  }
  lastClientPruneAt = now;

  for (const [clientId, state] of clients.entries()) {
    state.requestedAt = state.requestedAt.filter((timestamp) => withinWindow(timestamp, now));
    if (state.activeRequests === 0 && state.requestedAt.length === 0 && now - state.lastSeenAt >= CLIENT_STATE_TTL_MS) {
      clients.delete(clientId);
    }
  }
};

const evictOldestInactiveClient = (): boolean => {
  let oldest: { clientId: string; lastSeenAt: number } | null = null;

  for (const [clientId, state] of clients.entries()) {
    if (state.activeRequests > 0 || (oldest && oldest.lastSeenAt <= state.lastSeenAt)) {
      continue;
    }
    oldest = { clientId, lastSeenAt: state.lastSeenAt };
  }

  return oldest ? clients.delete(oldest.clientId) : false;
};

const getOrCreateClientState = (clientId: string, now: number): ClientAdmissionState | null => {
  const existing = clients.get(clientId);
  if (existing) {
    existing.lastSeenAt = now;
    return existing;
  }

  if (clients.size >= MAX_TRACKED_CLIENTS && !evictOldestInactiveClient()) {
    return null;
  }

  const created: ClientAdmissionState = { activeRequests: 0, lastSeenAt: now, requestedAt: [] };
  clients.set(clientId, created);
  return created;
};

const createAcceptedPermit = (now: number, state?: ClientAdmissionState): VisitorIngestionPermit => {
  globalRequestedAt.push(now);
  globalActiveRequests += 1;
  if (state) {
    state.requestedAt.push(now);
    state.activeRequests += 1;
  }
  let released = false;

  return {
    allowed: true,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (state) {
        state.activeRequests = Math.max(0, state.activeRequests - 1);
      }
      globalActiveRequests = Math.max(0, globalActiveRequests - 1);
    },
  };
};

export const acquireVisitorIngestionPermit = (request: NextRequest, now = Date.now()): VisitorIngestionPermit => {
  pruneAdmissionState(now);

  if (globalActiveRequests >= GLOBAL_MAX_CONCURRENCY) {
    return { allowed: false, retryAfterSeconds: 1 };
  }

  if (globalRequestedAt.length >= GLOBAL_MAX_REQUESTS) {
    return { allowed: false, retryAfterSeconds: retryAfterFor(globalRequestedAt, now) };
  }

  const clientId = getClientIp(request);
  // Plain `next start` may not expose a trustworthy client address. Treating every visitor as one
  // client would discard legitimate analytics, so the bounded global limits remain the fallback.
  if (clientId === "unknown") {
    return createAcceptedPermit(now);
  }

  const state = getOrCreateClientState(clientId, now);
  if (!state) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(RATE_WINDOW_MS / 1_000)) };
  }
  state.requestedAt = state.requestedAt.filter((timestamp) => withinWindow(timestamp, now));

  if (state.activeRequests >= CLIENT_MAX_CONCURRENCY) {
    return { allowed: false, retryAfterSeconds: 1 };
  }

  if (state.requestedAt.length >= CLIENT_MAX_REQUESTS) {
    return { allowed: false, retryAfterSeconds: retryAfterFor(state.requestedAt, now) };
  }

  return createAcceptedPermit(now, state);
};

export const resetVisitorIngestionRateLimitForTests = (): void => {
  clients.clear();
  globalActiveRequests = 0;
  globalRequestedAt = [];
  lastClientPruneAt = Number.NEGATIVE_INFINITY;
};
