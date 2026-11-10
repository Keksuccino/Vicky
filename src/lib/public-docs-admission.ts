import { ApiError } from "@/lib/http";
import type { ClientIpRequest } from "@/lib/client-ip-policy";
import { createAdmissionLimiter, parseBoundedPositiveInteger, type AdmissionPermit } from "@/lib/request-admission";

export type PublicDocsAdmissionPermit = AdmissionPermit;

const DEFAULT_CLIENT_MAX_REQUESTS = 180;
const DEFAULT_GLOBAL_MAX_REQUESTS = 5_000;
const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_CLIENT_MAX_CONCURRENCY = 12;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 128;
const MAX_REQUEST_LIMIT = 50_000;
const MAX_RATE_WINDOW_SECONDS = 3_600;
const MAX_CONCURRENCY_LIMIT = 512;

/** One permit per public document read: page, raw, metadata, and tree requests and every docs page render. */
const limiter = createAdmissionLimiter("publicDocs.admissionState", {
  clientMaxRequests: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_CLIENT_MAX_REQUESTS, DEFAULT_CLIENT_MAX_REQUESTS, MAX_REQUEST_LIMIT),
  globalMaxRequests: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_GLOBAL_MAX_REQUESTS, DEFAULT_GLOBAL_MAX_REQUESTS, MAX_REQUEST_LIMIT),
  rateWindowMs: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_RATE_WINDOW_SECONDS, DEFAULT_RATE_WINDOW_SECONDS, MAX_RATE_WINDOW_SECONDS) * 1_000,
  clientMaxConcurrency: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_CLIENT_MAX_CONCURRENCY, DEFAULT_CLIENT_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT),
  globalMaxConcurrency: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_GLOBAL_MAX_CONCURRENCY, DEFAULT_GLOBAL_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT),
});

/** Some Next.js server-render paths expose no trustworthy address; `request` may then be undefined. */
export const acquirePublicDocsAdmissionPermit = (request?: ClientIpRequest, now = Date.now()): PublicDocsAdmissionPermit => limiter.acquire(request, now);

/** The 429 answer to a rejected permit, with the `Retry-After` the permit names. */
export const publicDocsThrottledError = (retryAfterSeconds: number): ApiError =>
  new ApiError(429, `Too many document requests. Try again in ${retryAfterSeconds} seconds.`, { "Retry-After": String(retryAfterSeconds) });

export const withPublicDocsAdmission = async <T>(request: ClientIpRequest | undefined, work: () => Promise<T>): Promise<T> => {
  const permit = acquirePublicDocsAdmissionPermit(request);
  if (!permit.allowed) {
    throw publicDocsThrottledError(permit.retryAfterSeconds);
  }

  try {
    return await work();
  } finally {
    permit.release();
  }
};

export const resetPublicDocsAdmissionForTests = (): void => limiter.reset();
