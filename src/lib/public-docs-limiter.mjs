import { createAdmissionLimiter, parseBoundedPositiveInteger } from "./request-admission.mjs";
import { isAuthenticatedInternalRequestContext } from "./request-origin-policy.mjs";

/**
 * The public docs admission limiter, shared by the app (public-docs-admission.ts) and the
 * included server, which admits docs page requests before Next renders them: a page render can
 * only answer 404 or 500, so the server is where a throttled visitor gets a real 429 with
 * Retry-After. One permit per public document read: page, raw, metadata, and tree requests and
 * every docs page render.
 */

/**
 * Set by the included server on a docs page request whose permit it holds until the response
 * closes. It only counts together with the server's per-process request-context token: the server
 * removes client-supplied values from every request, and without the server the token is unset.
 */
export const PUBLIC_DOCS_ADMITTED_HEADER = "x-vicky-docs-admitted";

const DEFAULT_CLIENT_MAX_REQUESTS = 180;
const DEFAULT_GLOBAL_MAX_REQUESTS = 5_000;
const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_CLIENT_MAX_CONCURRENCY = 12;
const DEFAULT_GLOBAL_MAX_CONCURRENCY = 128;
const MAX_REQUEST_LIMIT = 50_000;
const MAX_RATE_WINDOW_SECONDS = 3_600;
const MAX_CONCURRENCY_LIMIT = 512;

const limiter = createAdmissionLimiter("publicDocs.admissionState.v2", {
  clientMaxRequests: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_CLIENT_MAX_REQUESTS, DEFAULT_CLIENT_MAX_REQUESTS, MAX_REQUEST_LIMIT),
  globalMaxRequests: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_GLOBAL_MAX_REQUESTS, DEFAULT_GLOBAL_MAX_REQUESTS, MAX_REQUEST_LIMIT),
  rateWindowMs: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_RATE_WINDOW_SECONDS, DEFAULT_RATE_WINDOW_SECONDS, MAX_RATE_WINDOW_SECONDS) * 1_000,
  clientMaxConcurrency: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_CLIENT_MAX_CONCURRENCY, DEFAULT_CLIENT_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT),
  globalMaxConcurrency: parseBoundedPositiveInteger(process.env.PUBLIC_DOCS_GLOBAL_MAX_CONCURRENCY, DEFAULT_GLOBAL_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT),
});

/**
 * Some Next.js server-render paths expose no trustworthy address; `request` may then be undefined.
 *
 * @param {import("./request-admission.mjs").AdmissionRequest} [request]
 * @param {number} [now]
 * @returns {import("./request-admission.mjs").AdmissionPermit}
 */
export function acquirePublicDocsAdmissionPermit(request, now = Date.now()) {
  return limiter.acquire(request, now);
}

export function resetPublicDocsAdmissionForTests() {
  limiter.reset();
}

/**
 * The visitor-facing text of a rejected docs read, from the app and from the included server alike.
 *
 * @param {number} retryAfterSeconds
 * @returns {string}
 */
export function publicDocsThrottledMessage(retryAfterSeconds) {
  return `Too many document requests. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`;
}

/**
 * Whether the included server already holds the permit of the request with these headers.
 *
 * @param {{ get: (name: string) => string | null } | undefined} headers
 * @returns {boolean}
 */
export function isPublicDocsRequestAdmitted(headers) {
  return Boolean(headers && headers.get(PUBLIC_DOCS_ADMITTED_HEADER) === "1" && isAuthenticatedInternalRequestContext(headers));
}

/**
 * Included server only: decides admission for a docs page request (`GET`/`HEAD` of `/docs` or a
 * path below it, raw Markdown rewrites included) before Next sees it, and marks admitted requests.
 * Run it on every request after the server set its private request-context and client-IP headers,
 * which the client address comes from; it also removes client-supplied admission marks. Returns
 * null for every other request. The caller answers a rejection with 429 and releases an accepted
 * permit when the response closes.
 *
 * @param {{ method?: string, headers: Record<string, string | string[] | undefined> }} request
 * @param {string} pathname
 * @returns {import("./request-admission.mjs").AdmissionPermit | null}
 */
export function admitPublicDocsPageRequest(request, pathname) {
  delete request.headers[PUBLIC_DOCS_ADMITTED_HEADER];
  if ((request.method !== "GET" && request.method !== "HEAD") || (pathname !== "/docs" && !pathname.startsWith("/docs/"))) {
    return null;
  }

  const permit = limiter.acquire({
    headers: {
      get: (name) => {
        const value = request.headers[name];
        return typeof value === "string" ? value : null;
      },
    },
  });
  if (permit.allowed) {
    request.headers[PUBLIC_DOCS_ADMITTED_HEADER] = "1";
  }
  return permit;
}
