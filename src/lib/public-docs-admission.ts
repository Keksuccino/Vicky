import { ApiError } from "@/lib/http";
import { getClientIp, type ClientIpRequest } from "@/lib/client-ip-policy";

type ClientAdmissionState = {
  activeRequests: number;
  lastSeenAt: number;
  requestedAt: number[];
};

type PublicDocsAdmissionState = {
  clients: Map<string, ClientAdmissionState>;
  globalActiveRequests: number;
  globalRequestedAt: number[];
  lastClientPruneAt: number;
};

export type PublicDocsAdmissionPermit =
  | { allowed: true; release: () => void }
  | { allowed: false; retryAfterSeconds: number };

const DEFAULT_CLIENT_MAX_REQUESTS = 180;
const DEFAULT_GLOBAL_MAX_REQUESTS = 5_000;
const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_CLIENT_MAX_CONCURRENCY = 12;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 128;
const MAX_TRACKED_CLIENTS = 10_000;
const MAX_REQUEST_LIMIT = 50_000;
const MAX_RATE_WINDOW_SECONDS = 3_600;
const MAX_CONCURRENCY_LIMIT = 512;

const parseBoundedPositiveInteger = (value: string | undefined, fallback: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const CLIENT_MAX_REQUESTS = parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_CLIENT_MAX_REQUESTS, DEFAULT_CLIENT_MAX_REQUESTS, MAX_REQUEST_LIMIT);
const GLOBAL_MAX_REQUESTS = parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_GLOBAL_MAX_REQUESTS, DEFAULT_GLOBAL_MAX_REQUESTS, MAX_REQUEST_LIMIT);
const RATE_WINDOW_MS = parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_RATE_WINDOW_SECONDS, DEFAULT_RATE_WINDOW_SECONDS, MAX_RATE_WINDOW_SECONDS) * 1_000;
const CLIENT_MAX_CONCURRENCY = parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_CLIENT_MAX_CONCURRENCY, DEFAULT_CLIENT_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT);
const GLOBAL_MAX_CONCURRENCY = parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_GLOBAL_MAX_CONCURRENCY, DEFAULT_GLOBAL_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT);
const CLIENT_STATE_TTL_MS = RATE_WINDOW_MS * 2;
const CLIENT_PRUNE_INTERVAL_MS = Math.min(RATE_WINDOW_MS, 30_000);

const PUBLIC_DOCS_ADMISSION_STATE_KEY = Symbol.for("vicky.publicDocs.admissionState");

const getAdmissionState = (): PublicDocsAdmissionState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, PublicDocsAdmissionState | undefined>;
  let state = globalState[PUBLIC_DOCS_ADMISSION_STATE_KEY];
  if (!state) {
    state = { clients: new Map(), globalActiveRequests: 0, globalRequestedAt: [], lastClientPruneAt: Number.NEGATIVE_INFINITY };
    globalState[PUBLIC_DOCS_ADMISSION_STATE_KEY] = state;
  }
  return state;
};

const withinWindow = (timestamp: number, now: number): boolean => now - timestamp < RATE_WINDOW_MS;

const retryAfterFor = (timestamps: number[], now: number): number => {
  const oldest = timestamps[0];
  return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1_000));
};

const pruneAdmissionState = (now: number): void => {
  const admissionState = getAdmissionState();
  admissionState.globalRequestedAt = admissionState.globalRequestedAt.filter((timestamp) => withinWindow(timestamp, now));
  if (now - admissionState.lastClientPruneAt < CLIENT_PRUNE_INTERVAL_MS) {
    return;
  }
  admissionState.lastClientPruneAt = now;

  for (const [clientId, state] of admissionState.clients.entries()) {
    state.requestedAt = state.requestedAt.filter((timestamp) => withinWindow(timestamp, now));
    if (state.activeRequests === 0 && state.requestedAt.length === 0 && now - state.lastSeenAt >= CLIENT_STATE_TTL_MS) {
      admissionState.clients.delete(clientId);
    }
  }
};

const evictOldestInactiveClient = (): boolean => {
  const admissionState = getAdmissionState();
  let oldestClientId: string | null = null;
  let oldestSeenAt = Number.POSITIVE_INFINITY;
  for (const [clientId, state] of admissionState.clients.entries()) {
    if (state.activeRequests === 0 && state.lastSeenAt < oldestSeenAt) {
      oldestClientId = clientId;
      oldestSeenAt = state.lastSeenAt;
    }
  }
  return oldestClientId ? admissionState.clients.delete(oldestClientId) : false;
};

const getOrCreateClientState = (clientId: string, now: number): ClientAdmissionState | null => {
  const admissionState = getAdmissionState();
  const existing = admissionState.clients.get(clientId);
  if (existing) {
    existing.lastSeenAt = now;
    return existing;
  }

  if (admissionState.clients.size >= MAX_TRACKED_CLIENTS && !evictOldestInactiveClient()) {
    return null;
  }

  const created: ClientAdmissionState = { activeRequests: 0, lastSeenAt: now, requestedAt: [] };
  admissionState.clients.set(clientId, created);
  return created;
};

const createAcceptedPermit = (now: number, state?: ClientAdmissionState): PublicDocsAdmissionPermit => {
  const admissionState = getAdmissionState();
  admissionState.globalRequestedAt.push(now);
  admissionState.globalActiveRequests += 1;
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
      admissionState.globalActiveRequests = Math.max(0, admissionState.globalActiveRequests - 1);
      if (state) {
        state.activeRequests = Math.max(0, state.activeRequests - 1);
      }
    },
  };
};

export const acquirePublicDocsAdmissionPermit = (request?: ClientIpRequest, now = Date.now()): PublicDocsAdmissionPermit => {
  pruneAdmissionState(now);
  const admissionState = getAdmissionState();
  if (admissionState.globalActiveRequests >= GLOBAL_MAX_CONCURRENCY) {
    return { allowed: false, retryAfterSeconds: 1 };
  }
  if (admissionState.globalRequestedAt.length >= GLOBAL_MAX_REQUESTS) {
    return { allowed: false, retryAfterSeconds: retryAfterFor(admissionState.globalRequestedAt, now) };
  }

  const clientId = request ? getClientIp(request) : "unknown";
  // Some Next.js server-render paths do not expose a trustworthy address. Global limits
  // remain effective there without collapsing every visitor into one per-client bucket.
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

export const withPublicDocsAdmission = async <T>(request: ClientIpRequest | undefined, work: () => Promise<T>): Promise<T> => {
  const permit = acquirePublicDocsAdmissionPermit(request);
  if (!permit.allowed) {
    throw new ApiError(429, `Too many document requests. Try again in ${permit.retryAfterSeconds} seconds.`, { "Retry-After": String(permit.retryAfterSeconds) });
  }

  try {
    return await work();
  } finally {
    permit.release();
  }
};

export const resetPublicDocsAdmissionForTests = (): void => {
  const admissionState = getAdmissionState();
  admissionState.clients.clear();
  admissionState.globalActiveRequests = 0;
  admissionState.globalRequestedAt = [];
  admissionState.lastClientPruneAt = Number.NEGATIVE_INFINITY;
};
