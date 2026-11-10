import type { NextRequest } from "next/server";

import { createAdmissionLimiter, parseBoundedPositiveInteger, type AdmissionPermit } from "@/lib/request-admission";

export type VisitorIngestionPermit = AdmissionPermit;

const DEFAULT_CLIENT_MAX_REQUESTS = 60;
const DEFAULT_GLOBAL_MAX_REQUESTS = 1_200;
const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_CLIENT_MAX_CONCURRENCY = 4;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 32;
const MAX_CLIENT_REQUEST_LIMIT = 1_000;
const MAX_GLOBAL_REQUEST_LIMIT = 10_000;
const MAX_RATE_WINDOW_SECONDS = 3_600;
const MAX_CONCURRENCY_LIMIT = 256;

/**
 * One permit per recorded page view. Plain `next start` may not expose a trustworthy client
 * address; treating every visitor as one client would discard legitimate analytics, so the bounded
 * global limits are the fallback there (see request-admission.ts).
 */
const limiter = createAdmissionLimiter("visitorIngestion.admissionState", {
  clientMaxRequests: parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS, DEFAULT_CLIENT_MAX_REQUESTS, MAX_CLIENT_REQUEST_LIMIT),
  globalMaxRequests: parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS, DEFAULT_GLOBAL_MAX_REQUESTS, MAX_GLOBAL_REQUEST_LIMIT),
  rateWindowMs: parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_RATE_WINDOW_SECONDS, DEFAULT_RATE_WINDOW_SECONDS, MAX_RATE_WINDOW_SECONDS) * 1_000,
  clientMaxConcurrency: parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_CLIENT_MAX_CONCURRENCY, DEFAULT_CLIENT_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT),
  globalMaxConcurrency: parseBoundedPositiveInteger(process.env.VISITOR_ANALYTICS_GLOBAL_MAX_CONCURRENCY, DEFAULT_GLOBAL_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT),
});

export const acquireVisitorIngestionPermit = (request: NextRequest, now = Date.now()): VisitorIngestionPermit => limiter.acquire(request, now);

export const resetVisitorIngestionRateLimitForTests = (): void => limiter.reset();
