import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ensurePrivateFile } from "./runtime-file-security.mjs";

const RUNTIME_PHASES = new Set(["starting", "refreshing", "http-only", "https-ready", "backoff", "error", "stopped"]);

const asRecord = (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {});

const asTimestamp = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const asNonNegativeInteger = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

const digest = (value) => createHash("sha256").update(value, "utf8").digest();

/**
 * Compares the complete Authorization header through fixed-length digests. Comparing
 * digests avoids the token-length branch that a direct timingSafeEqual call would need.
 * An empty configured token always disables endpoint authentication.
 *
 * @param {unknown} authorizationHeader
 * @param {unknown} bearerToken
 * @returns {boolean}
 */
export function isRuntimeSslStatusRequestAuthorized(authorizationHeader, bearerToken) {
  const normalizedToken = typeof bearerToken === "string" ? bearerToken.trim() : "";
  if (!normalizedToken || typeof authorizationHeader !== "string") {
    return false;
  }

  return timingSafeEqual(digest(authorizationHeader), digest(`Bearer ${normalizedToken}`));
}

/**
 * Produces the deliberately narrow network diagnostic shape. The persisted snapshot is
 * private and intentionally more detailed; never return it directly from an HTTP handler.
 *
 * @param {unknown} snapshot
 * @returns {Record<string, unknown>}
 */
export function sanitizeRuntimeSslStatusSnapshot(snapshot) {
  const payload = asRecord(snapshot);
  const domain = asRecord(payload.domain);
  const servers = asRecord(payload.servers);
  const refresh = asRecord(payload.refresh);
  const certificate = asRecord(payload.certificate);
  const retry = asRecord(payload.retry);
  const phase = typeof payload.phase === "string" && RUNTIME_PHASES.has(payload.phase) ? payload.phase : "unknown";

  return {
    schemaVersion: 1,
    updatedAt: asTimestamp(payload.updatedAt),
    phase,
    domain: {
      enabled: domain.enabled === true,
    },
    servers: {
      httpListening: servers.httpListening === true,
      httpsListening: servers.httpsListening === true,
    },
    refresh: {
      lastStartedAt: asTimestamp(refresh.lastStartedAt),
      lastSucceededAt: asTimestamp(refresh.lastSucceededAt),
      lastFailedAt: asTimestamp(refresh.lastFailedAt),
    },
    certificate: {
      expiresAt: asTimestamp(certificate.expiresAt),
      lastCheckedAt: asTimestamp(certificate.lastCheckedAt),
      lastIssuedAt: asTimestamp(certificate.lastIssuedAt),
      lastIssueFailedAt: asTimestamp(certificate.lastIssueFailedAt),
    },
    retry: {
      failureCount: asNonNegativeInteger(retry.failureCount),
      nextAttemptAt: asTimestamp(retry.nextAttemptAt),
      lastFailureAt: asTimestamp(retry.lastFailureAt),
    },
  };
}

/**
 * Prevents a graceful stop, crash remnant, or plain `next start` process from presenting
 * an old on-disk snapshot as live runtime state in the authenticated admin interface.
 *
 * @param {unknown} snapshot
 * @param {unknown} expectedInstanceId
 * @returns {boolean}
 */
export function isCurrentRuntimeSslStatusSnapshot(snapshot, expectedInstanceId) {
  const payload = asRecord(snapshot);
  const instanceId = typeof expectedInstanceId === "string" ? expectedInstanceId.trim() : "";
  return Boolean(instanceId && payload.runtimeInstanceId === instanceId && payload.phase !== "stopped");
}

const writeJsonResponse = (response, statusCode, headers, payload) => {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(payload, null, statusCode === 200 ? 2 : 0));
};

/**
 * Serves a matched runtime-status request. Callers must match the configured pathname
 * before invoking this function so this module cannot accidentally intercept other routes.
 *
 * @param {{ method?: string, headers?: { authorization?: string } }} request
 * @param {{ writeHead: Function, end: Function }} response
 * @param {{ bearerToken: string, snapshot: unknown }} options
 * @returns {void}
 */
export function serveRuntimeSslStatusRequest(request, response, options) {
  const bearerToken = typeof options.bearerToken === "string" ? options.bearerToken.trim() : "";
  if (!bearerToken) {
    writeJsonResponse(response, 404, {}, { error: "Not Found" });
    return;
  }

  if (!isRuntimeSslStatusRequestAuthorized(request.headers?.authorization, bearerToken)) {
    writeJsonResponse(response, 401, { "WWW-Authenticate": 'Bearer realm="vicky-ssl-status"' }, { error: "Unauthorized" });
    return;
  }

  if (request.method !== "GET") {
    writeJsonResponse(response, 405, { Allow: "GET" }, { error: "Method Not Allowed" });
    return;
  }

  writeJsonResponse(response, 200, {}, sanitizeRuntimeSslStatusSnapshot(options.snapshot));
}

/**
 * Reads the detailed snapshot only after its restrictive runtime permissions have been
 * repaired and verified. Invalid or legacy partial JSON is treated as unavailable so the
 * authenticated admin route can fall back to certificate inspection.
 *
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readPrivateRuntimeSslStatusSnapshot(filePath) {
  const exists = await ensurePrivateFile(filePath);
  if (!exists) {
    return null;
  }

  let rawSnapshot;
  try {
    rawSnapshot = await readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const snapshot = JSON.parse(rawSnapshot);
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}
