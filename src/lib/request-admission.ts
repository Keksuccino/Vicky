import { getClientIp, type ClientIpRequest } from "@/lib/client-ip-policy";
import { processSingleton } from "@/lib/process-singleton.mjs";

/**
 * Per-client and global admission control: a sliding request window and a concurrency cap, each
 * per client and for the whole process. Public docs reads and page-view ingestion each own one
 * limiter with their own limits (see public-docs-admission.ts and visitor-ingestion-rate-limit.ts).
 *
 * Clients come from the strict client-IP policy. Without a trustworthy address (`unknown`), only
 * the global limits apply, so visitors are never collapsed into one per-client bucket.
 */

export type AdmissionLimits = {
  clientMaxRequests: number;
  clientMaxConcurrency: number;
  globalMaxRequests: number;
  globalMaxConcurrency: number;
  rateWindowMs: number;
};

export type AdmissionPermit = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number };

export type AdmissionLimiter = {
  acquire: (request: ClientIpRequest | undefined, now?: number) => AdmissionPermit;
  /** Forgets every client and request; for tests that need a fresh limiter in the same process. */
  reset: () => void;
};

/** Start times of the requests that may still be in the window, oldest first from `head`. */
type RequestTimes = { head: number; times: number[] };

type ClientState = { activeRequests: number; lastSeenAt: number; requests: RequestTimes };

type LimiterState = {
  /** In order of the last request, least recent first, so eviction finds an idle client at once. */
  clients: Map<string, ClientState>;
  globalActiveRequests: number;
  globalRequests: RequestTimes;
  lastClientPruneAt: number;
};

const MAX_TRACKED_CLIENTS = 10_000;

/** A positive integer from the environment, capped at `maximum`; anything else gives `fallback`. */
export const parseBoundedPositiveInteger = (value: string | undefined, fallback: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

/**
 * Drops the times that left the window and returns how many remain. Times are appended as the
 * clock advances, so only the oldest few are ever inspected; the dropped prefix is compacted once
 * it is the larger part. (A clock stepped backwards only makes the count conservative for one window.)
 */
const countInWindow = (requests: RequestTimes, now: number, windowMs: number): number => {
  const { times } = requests;
  while (requests.head < times.length && now - times[requests.head] >= windowMs) {
    requests.head += 1;
  }
  if (requests.head > 0 && requests.head * 2 >= times.length) {
    times.splice(0, requests.head);
    requests.head = 0;
  }
  return times.length - requests.head;
};

const retryAfterSeconds = (requests: RequestTimes, now: number, windowMs: number): number => {
  const oldest = requests.times[requests.head];
  return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + windowMs - now) / 1_000));
};

const createState = (): LimiterState => ({ clients: new Map(), globalActiveRequests: 0, globalRequests: { head: 0, times: [] }, lastClientPruneAt: Number.NEGATIVE_INFINITY });

/** `name` keys the process-wide state (see process-singleton.mjs), so every module copy shares one limiter. */
export const createAdmissionLimiter = (name: string, limits: AdmissionLimits): AdmissionLimiter => {
  const state = processSingleton(name, createState);
  const windowMs = limits.rateWindowMs;
  const clientStateTtlMs = windowMs * 2;
  const clientPruneIntervalMs = Math.min(windowMs, 30_000);

  const pruneClients = (now: number): void => {
    if (now - state.lastClientPruneAt < clientPruneIntervalMs) {
      return;
    }
    state.lastClientPruneAt = now;
    for (const [clientId, client] of state.clients) {
      if (countInWindow(client.requests, now, windowMs) === 0 && client.activeRequests === 0 && now - client.lastSeenAt >= clientStateTtlMs) {
        state.clients.delete(clientId);
      }
    }
  };

  const evictLeastRecentIdleClient = (): boolean => {
    for (const [clientId, client] of state.clients) {
      if (client.activeRequests === 0) {
        return state.clients.delete(clientId);
      }
    }
    return false;
  };

  const touchClient = (clientId: string, now: number): ClientState | null => {
    const existing = state.clients.get(clientId);
    if (existing) {
      existing.lastSeenAt = now;
      // Re-inserting moves the client to the end of the Map's order, the most recently seen.
      state.clients.delete(clientId);
      state.clients.set(clientId, existing);
      return existing;
    }
    if (state.clients.size >= MAX_TRACKED_CLIENTS && !evictLeastRecentIdleClient()) {
      return null;
    }
    const created: ClientState = { activeRequests: 0, lastSeenAt: now, requests: { head: 0, times: [] } };
    state.clients.set(clientId, created);
    return created;
  };

  const admit = (now: number, client?: ClientState): AdmissionPermit => {
    state.globalRequests.times.push(now);
    state.globalActiveRequests += 1;
    if (client) {
      client.requests.times.push(now);
      client.activeRequests += 1;
    }
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        state.globalActiveRequests = Math.max(0, state.globalActiveRequests - 1);
        if (client) {
          client.activeRequests = Math.max(0, client.activeRequests - 1);
        }
      },
    };
  };

  return {
    acquire: (request, now = Date.now()) => {
      const globalRequests = countInWindow(state.globalRequests, now, windowMs);
      pruneClients(now);
      if (state.globalActiveRequests >= limits.globalMaxConcurrency) {
        return { allowed: false, retryAfterSeconds: 1 };
      }
      if (globalRequests >= limits.globalMaxRequests) {
        return { allowed: false, retryAfterSeconds: retryAfterSeconds(state.globalRequests, now, windowMs) };
      }

      const clientId = request ? getClientIp(request) : "unknown";
      if (clientId === "unknown") {
        return admit(now);
      }

      const client = touchClient(clientId, now);
      if (!client) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)) };
      }
      const clientRequests = countInWindow(client.requests, now, windowMs);
      if (client.activeRequests >= limits.clientMaxConcurrency) {
        return { allowed: false, retryAfterSeconds: 1 };
      }
      if (clientRequests >= limits.clientMaxRequests) {
        return { allowed: false, retryAfterSeconds: retryAfterSeconds(client.requests, now, windowMs) };
      }
      return admit(now, client);
    },
    reset: () => {
      Object.assign(state, createState());
    },
  };
};
