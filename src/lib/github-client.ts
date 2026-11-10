import { Octokit } from "@octokit/rest";

import { gitHubCredentialFingerprint } from "@/lib/github-cache-identity";
import { ApiError } from "@/lib/http";
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
 * Bulk requests (blob downloads, tree walks, commit-metadata batches) wait behind interactive
 * ones (single reads, saves), so a large refresh never delays an editor save or a cold page read.
 */
export type GitHubRequestPriority = "interactive" | "bulk";

type RequestPolicyOptions = {
  /** Allows retries of a non-GET request whose repetition is harmless, such as a GraphQL query. */
  idempotent?: boolean;
  priority?: GitHubRequestPriority;
  signal?: AbortSignal;
};

type GitHubClientState = {
  activeRequests: number;
  clients: Map<string, Octokit>;
  queues: Record<GitHubRequestPriority, Array<() => void>>;
  /** Earliest time GitHub accepts requests again, by `<credential fingerprint>|<rate-limit resource>`. */
  rateLimitedUntil: Map<string, number>;
};

const clientState = processSingleton("githubClient.state", (): GitHubClientState => ({
  activeRequests: 0,
  clients: new Map(),
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

const parseRetryAfterMs = (value: string | undefined): number | undefined => {
  if (!value?.trim()) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
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
 * responses, the global concurrency cap, and bounded retries. Only requests that are safe to
 * repeat retry after timeouts, connection failures, and 5xx responses; a rate-limited request
 * retries regardless of its method because GitHub rejected it before doing any work.
 */
const sendWithPolicy = async (credentialKey: string, request: OctokitRequest, options: Record<string, unknown>): Promise<unknown> => {
  const method = String(options.method ?? "GET").toUpperCase();
  const policy = (options.request ?? {}) as RequestPolicyOptions;
  const repeatable = method === "GET" || method === "HEAD" || policy.idempotent === true;
  const priority: GitHubRequestPriority = policy.priority === "bulk" ? "bulk" : "interactive";
  const rateLimitKey = `${credentialKey}|${String(options.url ?? "").endsWith("/graphql") ? "graphql" : "core"}`;
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
