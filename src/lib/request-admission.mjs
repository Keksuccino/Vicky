import { getClientIp } from "./client-ip-policy.mjs";
import { processSingleton } from "./process-singleton.mjs";

/**
 * Per-client and global admission control: a sliding request window and a concurrency cap, each
 * per client and for the whole process. Public docs reads and page-view ingestion each own one
 * limiter with their own limits (see public-docs-admission.mjs and visitor-ingestion-rate-limit.ts).
 * Plain JavaScript, so the included server can admit docs page requests before Next renders them.
 *
 * Clients come from the strict client-IP policy. Without a trustworthy address (`unknown`), only
 * the global limits apply, so visitors are never collapsed into one per-client bucket.
 */

/**
 * @typedef {{ clientMaxRequests: number, clientMaxConcurrency: number, globalMaxRequests: number, globalMaxConcurrency: number, rateWindowMs: number }} AdmissionLimits
 * @typedef {{ allowed: true, release: () => void } | { allowed: false, retryAfterSeconds: number }} AdmissionPermit
 * @typedef {{ headers: { get: (name: string) => string | null }, ip?: string }} AdmissionRequest
 * @typedef {{ acquire: (request: AdmissionRequest | undefined, now?: number) => AdmissionPermit, reset: () => void }} AdmissionLimiter
 * @typedef {{ head: number, times: number[] }} RequestTimes Start times of the requests that may still be in the window, oldest first from `head`.
 * @typedef {{ activeRequests: number, lastSeenAt: number, requests: RequestTimes }} ClientState
 */

const MAX_TRACKED_CLIENTS = 10_000;

/**
 * A positive integer from the environment, capped at `maximum`; anything else gives `fallback`.
 *
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} maximum
 * @returns {number}
 */
export function parseBoundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

/**
 * Drops the times that left the window and returns how many remain. Times are appended as the
 * clock advances, so only the oldest few are ever inspected; the dropped prefix is compacted once
 * it is the larger part. (A clock stepped backwards only makes the count conservative for one window.)
 *
 * @param {RequestTimes} requests
 * @param {number} now
 * @param {number} windowMs
 * @returns {number}
 */
const countInWindow = (requests, now, windowMs) => {
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

/**
 * @param {RequestTimes} requests
 * @param {number} now
 * @param {number} windowMs
 * @returns {number}
 */
const retryAfterSeconds = (requests, now, windowMs) => {
  const oldest = requests.times[requests.head];
  return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + windowMs - now) / 1_000));
};

const createState = () => ({
  /** @type {Map<string, ClientState>} In order of the last request, least recent first, so eviction finds an idle client at once. */
  clients: new Map(),
  globalActiveRequests: 0,
  /** @type {RequestTimes} */
  globalRequests: { head: 0, times: [] },
  lastClientPruneAt: Number.NEGATIVE_INFINITY,
});

/**
 * `name` keys the process-wide state (see process-singleton.mjs), so every module copy, the
 * included server's included, shares one limiter.
 *
 * @param {string} name
 * @param {AdmissionLimits} limits
 * @returns {AdmissionLimiter}
 */
export function createAdmissionLimiter(name, limits) {
  const state = processSingleton(name, createState);
  const windowMs = limits.rateWindowMs;
  const clientStateTtlMs = windowMs * 2;
  const clientPruneIntervalMs = Math.min(windowMs, 30_000);

  /** @param {number} now */
  const pruneClients = (now) => {
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

  const evictLeastRecentIdleClient = () => {
    for (const [clientId, client] of state.clients) {
      if (client.activeRequests === 0) {
        return state.clients.delete(clientId);
      }
    }
    return false;
  };

  /**
   * @param {string} clientId
   * @param {number} now
   * @returns {ClientState | null}
   */
  const touchClient = (clientId, now) => {
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
    /** @type {ClientState} */
    const created = { activeRequests: 0, lastSeenAt: now, requests: { head: 0, times: [] } };
    state.clients.set(clientId, created);
    return created;
  };

  /**
   * @param {number} now
   * @param {ClientState} [client]
   * @returns {AdmissionPermit}
   */
  const admit = (now, client) => {
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
}
