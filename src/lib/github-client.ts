import { Octokit } from "@octokit/rest";

import { gitHubCredentialFingerprint } from "@/lib/github-cache-identity";
import { ApiError, parseRetryAfterMs } from "@/lib/http";
import { processSingleton } from "@/lib/process-singleton.mjs";
import type { GitHubRuntimeConfig } from "@/lib/types";

/** Most requests this process sends to GitHub at the same time, across every loader and token. */
const MAX_CONCURRENT_REQUESTS = 8;
/** Per attempt, covering the response headers and the complete body. */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;
/** Longest rate-limit pause one request waits out before it fails with a rate-limit error. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** GitHub asks clients to pause at least a minute after a secondary rate limit without `retry-after`. */
const SECONDARY_RATE_LIMIT_PAUSE_MS = 60_000;
const MAX_CACHED_CLIENTS = 8;
const TIMEOUT_ERROR_NAME = "GitHubRequestTimeoutError";

/**
 * Pacing of bulk requests, from GitHub's documented secondary rate limits ("Rate limits for the
 * REST API" and "Best practices for using the REST API"): at most 900 points per minute for REST
 * endpoints and 2,000 for GraphQL, where a GET/HEAD/OPTIONS request or a GraphQL query costs 1
 * point and a POST/PATCH/PUT/DELETE request 5; at most 80 content-generating requests per minute
 * and 500 per hour; and, for many mutative requests, at least one second between them.
 *
 * Bulk work stays within two thirds of each point budget (bursts of 100 points, then 10 per
 * second for REST), leaving the rest for interactive requests and other users of the token.
 * Bulk writes may burst to 5 (one batch commit), then go one second apart (at most 65 per
 * minute), and are limited to 400 per hour after a burst of 60. Interactive requests never wait
 * for pacing, but their cost is charged to the same budgets, so bulk work slows down while the
 * site is busy.
 */
const PACING = {
  core: { pointsPerMinute: 600, burstPoints: 100 },
  graphql: { pointsPerMinute: 1_200, burstPoints: 100 },
  writePoints: 5,
  writeSpacingMs: 1_000,
  writeSpacingBurst: 5,
  writesPerHour: 400,
  writeBurst: 60,
  /** How far interactive usage may push bulk work back, in bucket capacities. */
  interactiveDebtCapacities: 2,
} as const;

/**
 * Bulk requests (blob downloads, tree walks, commit-metadata batches, background commits) wait
 * behind interactive ones (single reads, saves) and are paced, so a large refresh or stamping
 * run never delays an editor save or a cold page read and never trips GitHub's secondary limits.
 */
export type GitHubRequestPriority = "interactive" | "bulk";

type RequestPolicyOptions = {
  /** Allows retries of a non-GET request whose repetition is harmless, such as a GraphQL query. */
  idempotent?: boolean;
  priority?: GitHubRequestPriority;
  signal?: AbortSignal;
};

/**
 * A rate budget as a generic cell rate algorithm: `tat` is the theoretical time at which the
 * budget is fully replenished. A request of cost c may start once `tat + c·interval − capacity`
 * has passed, which serves waiting callers in order without polling.
 */
type PaceBucket = {
  capacityMs: number;
  intervalMs: number;
  tat: number;
};

type RequestPacing = {
  points: PaceBucket;
  writeSpacing: PaceBucket;
  writes: PaceBucket;
};

type GitHubClientState = {
  activeRequests: number;
  clients: Map<string, Octokit>;
  /** Rate budgets by `<credential fingerprint>|<rate-limit resource>`. */
  pacing: Map<string, RequestPacing>;
  queues: Record<GitHubRequestPriority, Array<() => void>>;
  /** Earliest time GitHub accepts requests again, by `<credential fingerprint>|<rate-limit resource>`. */
  rateLimitedUntil: Map<string, number>;
};

const clientState = processSingleton("githubClient.state.v2", (): GitHubClientState => ({
  activeRequests: 0,
  clients: new Map(),
  pacing: new Map(),
  queues: { bulk: [], interactive: [] },
  rateLimitedUntil: new Map(),
}));

type OctokitRequestError = Error & {
  cause?: unknown;
  response?: { headers?: Record<string, string | number | undefined> };
  status?: number;
};

export const gitHubErrorStatus = (error: unknown): number | undefined => {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

const acquireRequestSlot = (priority: GitHubRequestPriority): Promise<void> => {
  if (clientState.activeRequests < MAX_CONCURRENT_REQUESTS) {
    clientState.activeRequests += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    clientState.queues[priority].push(resolve);
  });
};

type RateLimitResource = "core" | "graphql";

const pacingFor = (rateLimitKey: string, resource: RateLimitResource): RequestPacing => {
  const existing = clientState.pacing.get(rateLimitKey);
  if (existing) {
    return existing;
  }

  const pointIntervalMs = 60_000 / PACING[resource].pointsPerMinute;
  const writeIntervalMs = 3_600_000 / PACING.writesPerHour;
  const pacing: RequestPacing = {
    points: { capacityMs: PACING[resource].burstPoints * pointIntervalMs, intervalMs: pointIntervalMs, tat: 0 },
    writeSpacing: { capacityMs: PACING.writeSpacingBurst * PACING.writeSpacingMs, intervalMs: PACING.writeSpacingMs, tat: 0 },
    writes: { capacityMs: PACING.writeBurst * writeIntervalMs, intervalMs: writeIntervalMs, tat: 0 },
  };
  clientState.pacing.set(rateLimitKey, pacing);
  return pacing;
};

const pacedCosts = (pacing: RequestPacing, write: boolean): Array<[PaceBucket, number]> =>
  write ? [[pacing.points, PACING.writePoints], [pacing.writeSpacing, 1], [pacing.writes, 1]] : [[pacing.points, 1]];

/** Reserves the earliest start at which every budget admits the request; returns how long to wait for it. */
const reserveBulkStart = (costs: Array<[PaceBucket, number]>, now: number): number => {
  let startAt = now;
  for (const [bucket, cost] of costs) {
    startAt = Math.max(startAt, bucket.tat + cost * bucket.intervalMs - bucket.capacityMs);
  }
  for (const [bucket, cost] of costs) {
    bucket.tat = Math.max(bucket.tat, startAt) + cost * bucket.intervalMs;
  }
  return startAt - now;
};

/** Charges an interactive request without delaying it; its usage pushes bulk work back by a bounded amount. */
const chargeInteractiveRequest = (costs: Array<[PaceBucket, number]>, now: number): void => {
  for (const [bucket, cost] of costs) {
    bucket.tat = Math.min(Math.max(bucket.tat, now) + cost * bucket.intervalMs, now + bucket.capacityMs * PACING.interactiveDebtCapacities);
  }
};

const releaseRequestSlot = (): void => {
  const next = clientState.queues.interactive.shift() ?? clientState.queues.bulk.shift();
  if (next) {
    // The slot passes directly to the next waiter, so the active count stays unchanged.
    next();
    return;
  }

  clientState.activeRequests -= 1;
};

const createTimeoutError = (): Error => {
  const error = new Error(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
  error.name = TIMEOUT_ERROR_NAME;
  return error;
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Transport used by every Octokit instance. The body is read here, inside the timeout, because
 * Octokit swallows body read failures of JSON responses and would turn a stalled transfer into an
 * empty successful result. `globalThis.fetch` is resolved per call so tests can stub GitHub.
 */
const fetchWithTimeout = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(createTimeoutError()), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;

  try {
    const response = await globalThis.fetch(input, { ...init, signal });
    const body = NULL_BODY_STATUSES.has(response.status) || init?.method === "HEAD" ? null : await response.arrayBuffer();
    return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
  } catch (error: unknown) {
    if (timeout.signal.aborted && !init?.signal?.aborted) {
      throw createTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const readHeader = (headers: Record<string, string | number | undefined> | undefined, name: string): string | undefined => {
  const value = headers?.[name];
  return value === undefined ? undefined : String(value);
};

const rateLimitResetAtMs = (headers: Record<string, string | number | undefined> | undefined): number | undefined => {
  const reset = Number(readHeader(headers, "x-ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
};

const blockUntil = (rateLimitKey: string, untilMs: number): void => {
  if ((clientState.rateLimitedUntil.get(rateLimitKey) ?? 0) < untilMs) {
    clientState.rateLimitedUntil.set(rateLimitKey, untilMs);
  }
};

const createRateLimitError = (resumeAtMs: number): ApiError => {
  const retryAfterSeconds = Math.max(1, Math.ceil((resumeAtMs - Date.now()) / 1000));
  const resumeAt = new Date(resumeAtMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  return new ApiError(503, `GitHub's API rate limit is used up. Docs can be loaded from GitHub again after ${resumeAt}.`, {
    "Retry-After": String(retryAfterSeconds),
  });
};

/** Returns when GitHub accepts requests again if the error is a primary or secondary rate limit. */
const rateLimitResumeAtMs = (error: OctokitRequestError): number | undefined => {
  const status = error.status;
  const headers = error.response?.headers;
  const retryAfterMs = parseRetryAfterMs(readHeader(headers, "retry-after"));
  const quotaExhausted = readHeader(headers, "x-ratelimit-remaining") === "0";
  const rateLimited = status === 429 || (status === 403 && (quotaExhausted || retryAfterMs !== undefined || /rate limit/i.test(error.message)));
  if (!rateLimited) {
    return undefined;
  }

  if (retryAfterMs !== undefined) {
    return Date.now() + retryAfterMs;
  }

  const resetAtMs = quotaExhausted ? rateLimitResetAtMs(headers) : undefined;
  return resetAtMs ?? Date.now() + SECONDARY_RATE_LIMIT_PAUSE_MS;
};

const retryDelayMs = (attempt: number, error: OctokitRequestError): number => {
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 3 ** (attempt - 1));
  const jittered = exponential * (0.5 + Math.random() * 0.5);
  const retryAfterMs = parseRetryAfterMs(readHeader(error.response?.headers, "retry-after"));
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(jittered, retryAfterMs ?? 0));
};

const isTimeoutError = (error: OctokitRequestError): boolean =>
  error.name === TIMEOUT_ERROR_NAME || (error.cause instanceof Error && error.cause.name === TIMEOUT_ERROR_NAME);

/** Octokit reports a failed connection as status 500 without a response. */
const isNetworkError = (error: OctokitRequestError): boolean => error.status === 500 && !error.response && error.name !== "AbortError";

const isRetryableServerError = (error: OctokitRequestError): boolean =>
  Boolean(error.response) && (error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504);

type OctokitRequest = (options: Record<string, unknown>) => Promise<{ headers: Record<string, string | number | undefined> }>;

/**
 * Applies the request policy shared by every GitHub call: rate-limit pauses known from earlier
 * responses, pacing of bulk requests, the global concurrency cap, and bounded retries. Only
 * requests that are safe to repeat retry after timeouts, connection failures, and 5xx responses;
 * a rate-limited request retries regardless of its method because GitHub rejected it before
 * doing any work. Every attempt is paced, retries included.
 */
const sendWithPolicy = async (credentialKey: string, request: OctokitRequest, options: Record<string, unknown>): Promise<unknown> => {
  const method = String(options.method ?? "GET").toUpperCase();
  const policy = (options.request ?? {}) as RequestPolicyOptions;
  const repeatable = method === "GET" || method === "HEAD" || policy.idempotent === true;
  const priority: GitHubRequestPriority = policy.priority === "bulk" ? "bulk" : "interactive";
  const resource: RateLimitResource = String(options.url ?? "").endsWith("/graphql") ? "graphql" : "core";
  const rateLimitKey = `${credentialKey}|${resource}`;
  // GraphQL requests are POSTs, but this app only sends queries, which GitHub counts as reads.
  const write = resource === "core" && method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const costs = pacedCosts(pacingFor(rateLimitKey, resource), write);
  let rateLimitWaitMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    const resumeAtMs = clientState.rateLimitedUntil.get(rateLimitKey) ?? 0;
    const pauseMs = resumeAtMs - Date.now();
    if (pauseMs > 0) {
      if (rateLimitWaitMs + pauseMs > MAX_RATE_LIMIT_WAIT_MS) {
        throw createRateLimitError(resumeAtMs);
      }
      rateLimitWaitMs += pauseMs;
      await sleep(pauseMs);
    }

    if (priority === "bulk") {
      const pacingMs = reserveBulkStart(costs, Date.now());
      if (pacingMs > 0) {
        await sleep(pacingMs);
      }
    } else {
      chargeInteractiveRequest(costs, Date.now());
    }

    let failure: OctokitRequestError;
    await acquireRequestSlot(priority);
    try {
      const response = await request(options);
      if (readHeader(response.headers, "x-ratelimit-remaining") === "0") {
        const resetAtMs = rateLimitResetAtMs(response.headers);
        if (resetAtMs) {
          blockUntil(rateLimitKey, resetAtMs);
        }
      }
      return response;
    } catch (error: unknown) {
      failure = error as OctokitRequestError;
    } finally {
      releaseRequestSlot();
    }

    if (policy.signal?.aborted || gitHubErrorStatus(failure) === 304) {
      throw failure;
    }

    const rateLimitedUntilMs = rateLimitResumeAtMs(failure);
    if (rateLimitedUntilMs !== undefined) {
      blockUntil(rateLimitKey, rateLimitedUntilMs);
      if (attempt < MAX_ATTEMPTS && rateLimitWaitMs + (rateLimitedUntilMs - Date.now()) <= MAX_RATE_LIMIT_WAIT_MS) {
        continue;
      }
      throw createRateLimitError(rateLimitedUntilMs);
    }

    const timedOut = isTimeoutError(failure);
    const transient = timedOut || isNetworkError(failure) || isRetryableServerError(failure);
    if (transient && repeatable && attempt < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(attempt, failure));
      continue;
    }

    if (timedOut) {
      throw new ApiError(504, "GitHub did not respond in time. Try again shortly.");
    }
    if (isNetworkError(failure)) {
      throw new ApiError(502, "GitHub could not be reached. Try again shortly.");
    }
    throw failure;
  }
};

const createClient = (token: string, credentialKey: string): Octokit => {
  const octokit = new Octokit({ auth: token, request: { fetch: fetchWithTimeout } });
  octokit.hook.wrap("request", (request, options) =>
    sendWithPolicy(credentialKey, request as unknown as OctokitRequest, options as unknown as Record<string, unknown>) as ReturnType<typeof request>,
  );
  return octokit;
};

/**
 * The one GitHub client of the app. Every GitHub call must use it so the concurrency cap,
 * timeouts, retries, and rate-limit pauses hold across all loaders. Instances are reused per
 * credential; a different token always gets its own instance.
 */
export const getGitHubClient = (config: Pick<GitHubRuntimeConfig, "token">): Octokit => {
  const credentialKey = gitHubCredentialFingerprint(config.token);
  const cached = clientState.clients.get(credentialKey);
  if (cached) {
    return cached;
  }

  const client = createClient(config.token, credentialKey);
  clientState.clients.set(credentialKey, client);
  if (clientState.clients.size > MAX_CACHED_CLIENTS) {
    const oldestKey = clientState.clients.keys().next().value;
    if (oldestKey !== undefined) {
      clientState.clients.delete(oldestKey);
    }
  }
  return client;
};
