import http from "node:http";
import https from "node:https";
import { randomUUID, X509Certificate } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";

import * as acme from "acme-client";
import next from "next";

import { normalizeCustomDomainInput, normalizeEmailInput } from "./src/lib/domain-normalization.mjs";
import { ACME_HTTP_CHALLENGE_PREFIX, decideRuntimeRequestAction, isHttpsServiceAvailable, routeRuntimeHttpRequest, writeHttpsMaintenanceResponse } from "./src/lib/https-runtime-policy.mjs";
import { ensurePrivateDirectory, ensurePrivateFile, secureAtomicWriteFile } from "./src/lib/runtime-file-security.mjs";
import { validateRuntimeSecretsOrExit } from "./src/lib/runtime-secret-startup.mjs";
import { serveRuntimeSslStatusRequest } from "./src/lib/runtime-ssl-status.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
validateRuntimeSecretsOrExit();

const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "wiki-store.json");
const STORE_PATH = process.env.WIKI_STORE_FILE_PATH ?? DEFAULT_STORE_PATH;
const SSL_STORAGE_DIR = process.env.WIKI_SSL_STORAGE_DIR ?? path.join(process.cwd(), "data", "ssl");
const LISTEN_HOST = process.env.HOST ?? "0.0.0.0";
const HTTP_PORT = parsePort(process.env.HTTP_PORT ?? process.env.PORT ?? "3000", 3000);
const HTTPS_PORT = parsePort(process.env.HTTPS_PORT ?? "443", 443);
const SSL_CHECK_INTERVAL_MS = parsePositiveInteger(process.env.SSL_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
const SSL_RENEW_BEFORE_MS = parsePositiveInteger(process.env.SSL_RENEW_BEFORE_MS, 30 * 24 * 60 * 60 * 1000);
const LETS_ENCRYPT_STAGING = parseBoolean(process.env.LETS_ENCRYPT_STAGING);
const SSL_STORE_WATCH_DEBOUNCE_MS = parsePositiveInteger(process.env.SSL_STORE_WATCH_DEBOUNCE_MS, 1500);
const SSL_ISSUE_RETRY_BASE_MS = parsePositiveInteger(process.env.SSL_ISSUE_RETRY_BASE_MS, 15 * 60 * 1000);
const SSL_ISSUE_RETRY_MAX_MS = parsePositiveInteger(process.env.SSL_ISSUE_RETRY_MAX_MS, 24 * 60 * 60 * 1000);
const SERVER_CLOSE_GRACE_MS = parsePositiveInteger(process.env.SERVER_CLOSE_GRACE_MS, 5000);
const SSL_STATUS_ENDPOINT_PATH = normalizeStatusEndpointPath(
  process.env.SSL_STATUS_ENDPOINT_PATH ?? "/.well-known/vicky/ssl-status",
);
const SSL_STATUS_BEARER_TOKEN = String(process.env.SSL_STATUS_BEARER_TOKEN ?? "").trim();
const SSL_STATUS_FILE_PATH = process.env.SSL_STATUS_FILE_PATH ?? path.join(SSL_STORAGE_DIR, "runtime-ssl-status.json");
const SSL_RUNTIME_INSTANCE_ID = randomUUID();
const IS_DEV = process.env.NODE_ENV !== "production";
const DAY_MS = 24 * 60 * 60 * 1000;
const INTERNAL_CLIENT_IP_HEADER = "x-vicky-client-ip";
const GITHUB_LOCALIZATION_UPLOAD_SHUTDOWN_KEY = Symbol.for("vicky.githubLocalization.uploadQueue.shutdown");

process.env.VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER = "true";
// The admin route may run in a Next worker, so an inherited process environment value is
// the reliable way to distinguish this server's live snapshot from a stale file or start:next.
process.env.VICKY_INTERNAL_SSL_RUNTIME_INSTANCE_ID = SSL_RUNTIME_INSTANCE_ID;

const challengeResponses = new Map();

let activeDomainState = {
  customDomain: "",
  letsEncryptEmail: "",
  enabled: false,
};

let httpsTrafficState = {
  certificateDomain: "",
  certificateValidFromMs: 0,
  certificateExpiresAtMs: 0,
};

let certificateRetryState = createCertificateRetryState("");

const sslRuntimeState = {
  phase: "starting",
  lastRefreshReason: "",
  lastRefreshStartedAtMs: 0,
  lastRefreshSucceededAtMs: 0,
  lastRefreshFailedAtMs: 0,
  lastRefreshErrorMessage: "",
  certificateExpiresAtMs: 0,
  certificateLastCheckedAtMs: 0,
  certificateLastRenewalReason: "",
  certificateLastIssuedAtMs: 0,
  certificateLastIssueFailedAtMs: 0,
  certificateLastIssueErrorMessage: "",
};

let refreshPromise = null;
let queuedRefreshReason = null;
let httpsServer = null;
let httpServer = null;
let sslCheckTimer = null;
let certificateRetryTimer = null;
let storeWatcher = null;
let storeWatchDebounceTimer = null;
let statusPersistTimer = null;
let statusPersistQueue = Promise.resolve();
let shutdownPromise = null;
let shuttingDown = false;

const app = next({
  dev: IS_DEV,
  hostname: LISTEN_HOST,
  port: HTTP_PORT,
});

const log = (message) => {
  console.log(`[vicky-https] ${new Date().toISOString()} ${message}`);
};

const warn = (message, error) => {
  if (!error) {
    console.warn(`[vicky-https] ${new Date().toISOString()} ${message}`);
    return;
  }

  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  console.warn(`[vicky-https] ${new Date().toISOString()} ${message}\n${detail}`);
};

class CertificateBackoffError extends Error {
  constructor(message, nextAttemptAtMs) {
    super(message);
    this.name = "CertificateBackoffError";
    this.nextAttemptAtMs = nextAttemptAtMs;
  }
}

function createCertificateRetryState(domain) {
  return {
    domain,
    failureCount: 0,
    nextAttemptAtMs: 0,
    lastFailureAtMs: 0,
    lastErrorMessage: "",
  };
}

function parsePort(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

function parsePositiveInteger(rawValue, fallback) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(rawValue) {
  const normalized = String(rawValue ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeStatusEndpointPath(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed) {
    return "/.well-known/vicky/ssl-status";
  }

  const withoutQuery = trimmed.split("?")[0].split("#")[0];
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const normalized = path.posix.normalize(withLeadingSlash);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function toPemString(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function toIsoTimestamp(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

function isActiveDomainHttpsAvailable(nowMs = Date.now()) {
  const availability = {
    configuredDomain: activeDomainState.enabled ? activeDomainState.customDomain : "",
    httpsListening: Boolean(httpsServer?.listening),
    certificateDomain: httpsTrafficState.certificateDomain,
    certificateValidFromMs: httpsTrafficState.certificateValidFromMs,
    certificateExpiresAtMs: httpsTrafficState.certificateExpiresAtMs,
    nowMs,
  };
  return isHttpsServiceAvailable(availability);
}

function getCustomDomainHttpPolicy(nowMs = Date.now()) {
  if (!activeDomainState.enabled) {
    return "application";
  }

  return isActiveDomainHttpsAvailable(nowMs) ? "redirect" : "maintenance";
}

function buildRuntimeStatusSnapshot() {
  const nowMs = Date.now();
  const httpsAvailable = isActiveDomainHttpsAvailable(nowMs);

  return {
    schemaVersion: 1,
    runtimeInstanceId: SSL_RUNTIME_INSTANCE_ID,
    updatedAt: new Date().toISOString(),
    phase: sslRuntimeState.phase,
    settings: {
      storePath: STORE_PATH,
      sslStorageDir: SSL_STORAGE_DIR,
      statusFilePath: SSL_STATUS_FILE_PATH,
      statusEndpointPath: SSL_STATUS_ENDPOINT_PATH,
      listenHost: LISTEN_HOST,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      checkIntervalMs: SSL_CHECK_INTERVAL_MS,
      renewBeforeMs: SSL_RENEW_BEFORE_MS,
      letsEncryptStaging: LETS_ENCRYPT_STAGING,
      watchDebounceMs: SSL_STORE_WATCH_DEBOUNCE_MS,
      retryBaseMs: SSL_ISSUE_RETRY_BASE_MS,
      retryMaxMs: SSL_ISSUE_RETRY_MAX_MS,
    },
    domain: {
      customDomain: activeDomainState.customDomain,
      enabled: activeDomainState.enabled,
    },
    servers: {
      httpListening: Boolean(httpServer?.listening),
      httpsListening: Boolean(httpsServer?.listening),
      httpsAvailable,
    },
    traffic: {
      customDomainHttpPolicy: getCustomDomainHttpPolicy(nowMs),
    },
    refresh: {
      lastReason: sslRuntimeState.lastRefreshReason,
      lastStartedAt: toIsoTimestamp(sslRuntimeState.lastRefreshStartedAtMs),
      lastSucceededAt: toIsoTimestamp(sslRuntimeState.lastRefreshSucceededAtMs),
      lastFailedAt: toIsoTimestamp(sslRuntimeState.lastRefreshFailedAtMs),
      lastErrorMessage: sslRuntimeState.lastRefreshErrorMessage || null,
    },
    certificate: {
      expiresAt: toIsoTimestamp(sslRuntimeState.certificateExpiresAtMs),
      lastCheckedAt: toIsoTimestamp(sslRuntimeState.certificateLastCheckedAtMs),
      lastRenewalReason: sslRuntimeState.certificateLastRenewalReason || null,
      lastIssuedAt: toIsoTimestamp(sslRuntimeState.certificateLastIssuedAtMs),
      lastIssueFailedAt: toIsoTimestamp(sslRuntimeState.certificateLastIssueFailedAtMs),
      lastIssueErrorMessage: sslRuntimeState.certificateLastIssueErrorMessage || null,
    },
    retry: {
      domain: certificateRetryState.domain || null,
      failureCount: certificateRetryState.failureCount,
      nextAttemptAt: toIsoTimestamp(certificateRetryState.nextAttemptAtMs),
      lastFailureAt: toIsoTimestamp(certificateRetryState.lastFailureAtMs),
      lastErrorMessage: certificateRetryState.lastErrorMessage || null,
    },
  };
}

function queuePersistRuntimeStatus() {
  const payload = JSON.stringify(buildRuntimeStatusSnapshot(), null, 2);

  statusPersistQueue = statusPersistQueue
    .then(async () => {
      await secureAtomicWriteFile(SSL_STATUS_FILE_PATH, payload, "utf8");
    })
    .catch((error) => {
      warn(`Failed to persist SSL runtime status at ${SSL_STATUS_FILE_PATH}.`, error);
    });

  return statusPersistQueue;
}

function schedulePersistRuntimeStatus() {
  if (statusPersistTimer) {
    clearTimeout(statusPersistTimer);
  }

  statusPersistTimer = setTimeout(() => {
    statusPersistTimer = null;
    void queuePersistRuntimeStatus();
  }, 200);
  statusPersistTimer.unref?.();
}

async function flushRuntimeStatus() {
  if (statusPersistTimer) {
    clearTimeout(statusPersistTimer);
    statusPersistTimer = null;
  }

  await queuePersistRuntimeStatus();
}

function formatHttpsAuthority(domain) {
  return HTTPS_PORT === 443 ? domain : `${domain}:${HTTPS_PORT}`;
}

function getSafeRequestTarget(request) {
  try {
    const parsed = new URL(request.url || "/", "http://localhost");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

function redirectToHttps(request, response, domain) {
  const location = `https://${formatHttpsAuthority(domain)}${getSafeRequestTarget(request)}`;
  response.writeHead(308, {
    Location: location,
    "Cache-Control": "no-store",
    "Content-Length": "0",
  });
  response.end();
}

function getRuntimeRequestAction(request, protocol) {
  const requestContext = {
    protocol,
    requestUrl: request.url,
    requestHost: request.headers.host,
    configuredDomain: activeDomainState.enabled ? activeDomainState.customDomain : "",
    httpsAvailable: isActiveDomainHttpsAvailable(),
  };
  return decideRuntimeRequestAction(requestContext);
}

function getRequestPath(request) {
  const rawUrl = request.url || "/";
  const host = request.headers.host || "localhost";

  try {
    return new URL(rawUrl, `http://${host}`).pathname;
  } catch {
    return rawUrl.split("?")[0] || "/";
  }
}

function setInternalClientIpHeader(request) {
  delete request.headers[INTERNAL_CLIENT_IP_HEADER];

  const remoteAddress = request.socket?.remoteAddress || request.connection?.remoteAddress;
  if (typeof remoteAddress === "string" && remoteAddress.trim()) {
    request.headers[INTERNAL_CLIENT_IP_HEADER] = remoteAddress.trim();
  }
}

function tryServeRuntimeStatus(request, response) {
  if (getRequestPath(request) !== SSL_STATUS_ENDPOINT_PATH) {
    return false;
  }

  // The detailed snapshot contains local paths and provider diagnostics. With no explicit
  // token the endpoint is absent, while a configured endpoint exposes only a narrow health view.
  serveRuntimeSslStatusRequest(request, response, { bearerToken: SSL_STATUS_BEARER_TOKEN, snapshot: buildRuntimeStatusSnapshot() });
  return true;
}

function getChallengeToken(requestUrl) {
  if (!requestUrl.startsWith(ACME_HTTP_CHALLENGE_PREFIX)) {
    return null;
  }

  const rawToken = requestUrl.slice(ACME_HTTP_CHALLENGE_PREFIX.length).split("?")[0];
  if (!rawToken) {
    return null;
  }

  try {
    return decodeURIComponent(rawToken);
  } catch {
    return rawToken;
  }
}

function tryServeChallenge(request, response) {
  const token = getChallengeToken(request.url || "/");

  if (!token) {
    return false;
  }

  const keyAuthorization = challengeResponses.get(token);
  if (!keyAuthorization) {
    response.writeHead(404, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Challenge token not found.");
    return true;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(keyAuthorization);
  return true;
}

function getIssueRetryDelayMs(failureCount) {
  const exponent = Math.max(0, failureCount - 1);
  const exponentialDelay = SSL_ISSUE_RETRY_BASE_MS * 2 ** exponent;
  const cappedDelay = Math.min(Math.max(SSL_ISSUE_RETRY_BASE_MS, SSL_ISSUE_RETRY_MAX_MS), exponentialDelay);
  const jitterMax = Math.min(60_000, Math.floor(cappedDelay * 0.2));
  const jitter = Math.floor(Math.random() * (jitterMax + 1));
  return Math.min(Math.max(SSL_ISSUE_RETRY_BASE_MS, SSL_ISSUE_RETRY_MAX_MS), cappedDelay + jitter);
}

function clearCertificateRetryTimer() {
  if (!certificateRetryTimer) {
    return;
  }

  clearTimeout(certificateRetryTimer);
  certificateRetryTimer = null;
}

function scheduleCertificateRetry(nextAttemptAtMs) {
  clearCertificateRetryTimer();
  if (shuttingDown || !Number.isFinite(nextAttemptAtMs) || nextAttemptAtMs <= 0) {
    return;
  }

  // Node clamps oversized timeout values to 1ms. Cap each wait and re-check the target
  // timestamp so unusually large operator-configured backoffs cannot become retry loops.
  const delayMs = Math.min(Math.max(1, nextAttemptAtMs - Date.now()), 2_147_483_647);
  certificateRetryTimer = setTimeout(() => {
    certificateRetryTimer = null;
    if (shuttingDown) {
      return;
    }

    if (Date.now() < nextAttemptAtMs) {
      scheduleCertificateRetry(nextAttemptAtMs);
      return;
    }

    void refreshDomainState("issuance-retry");
  }, delayMs);
  certificateRetryTimer.unref?.();
}

function shouldFallbackToExistingCertificate(keyPem, certPem, domain) {
  const certInfo = readCertificateInfo(certPem, domain);
  if (!isCertificateInfoUsable(certInfo) || !isCertificateBundleLoadable(keyPem, certPem)) {
    return false;
  }

  sslRuntimeState.certificateExpiresAtMs = certInfo.validToMs;
  return true;
}

function setRetryDomain(domain) {
  if (certificateRetryState.domain === domain) {
    return;
  }

  certificateRetryState = createCertificateRetryState(domain);
}

function isScheduledCertificateCheck(reason) {
  return (
    reason === "startup" ||
    reason === "periodic" ||
    reason === "issuance-retry" ||
    reason.startsWith("queued:startup") ||
    reason.startsWith("queued:periodic") ||
    reason.startsWith("queued:issuance-retry")
  );
}

function shouldRunHttpsRefresh(reason, domainSettingsChanged) {
  return isScheduledCertificateCheck(reason) || domainSettingsChanged || !activeDomainState.enabled || !httpsServer;
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let forceCloseTimer = null;
    let hardCloseTimer = null;

    const settle = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (forceCloseTimer) {
        clearTimeout(forceCloseTimer);
      }
      if (hardCloseTimer) {
        clearTimeout(hardCloseTimer);
      }

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    forceCloseTimer = setTimeout(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    }, SERVER_CLOSE_GRACE_MS);
    forceCloseTimer.unref?.();

    hardCloseTimer = setTimeout(() => {
      warn(`Server did not close within ${SERVER_CLOSE_GRACE_MS}ms; continuing shutdown.`);
      settle();
    }, SERVER_CLOSE_GRACE_MS + 1000);
    hardCloseTimer.unref?.();

    server.close((error) => {
      if (error) {
        settle(error);
        return;
      }

      settle();
    });

    server.closeIdleConnections?.();
  });
}

async function stopGitHubLocalizationUploadQueue() {
  const shutdownQueue = globalThis[GITHUB_LOCALIZATION_UPLOAD_SHUTDOWN_KEY];
  if (typeof shutdownQueue !== "function") {
    return;
  }

  let timeout = null;
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve();
    }, SERVER_CLOSE_GRACE_MS);
  });

  try {
    await Promise.race([Promise.resolve().then(() => shutdownQueue()), timeoutPromise]);
    if (timedOut) {
      warn(`GitHub localization uploads did not settle within ${SERVER_CLOSE_GRACE_MS}ms; continuing shutdown.`);
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readTextFileIfExists(filePath) {
  try {
    await ensurePrivateFile(filePath);
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function getCertificatePaths(domain) {
  const folder = path.join(SSL_STORAGE_DIR, domain);
  return {
    folder,
    privateKey: path.join(folder, "privkey.pem"),
    certificate: path.join(folder, "fullchain.pem"),
    accountKey: path.join(SSL_STORAGE_DIR, "account.key.pem"),
  };
}

function readCertificateInfo(certPem, domain) {
  try {
    const cert = new X509Certificate(certPem);
    const validFromMs = Date.parse(cert.validFrom);
    const validToMs = Date.parse(cert.validTo);
    const hostMatch = cert.checkHost(domain);

    return {
      validFromMs: Number.isFinite(validFromMs) ? validFromMs : null,
      validToMs: Number.isFinite(validToMs) ? validToMs : null,
      hostMatches: Boolean(hostMatch),
    };
  } catch {
    return {
      validFromMs: null,
      validToMs: null,
      hostMatches: false,
    };
  }
}

function isCertificateInfoUsable(certInfo, nowMs = Date.now()) {
  return Boolean(
    certInfo.hostMatches &&
      Number.isFinite(certInfo.validFromMs) &&
      certInfo.validFromMs <= nowMs &&
      Number.isFinite(certInfo.validToMs) &&
      certInfo.validToMs > nowMs,
  );
}

function isCertificateBundleLoadable(keyPem, certPem) {
  try {
    tls.createSecureContext({ key: keyPem, cert: certPem, minVersion: "TLSv1.2" });
    return true;
  } catch {
    return false;
  }
}

function getRenewalDecision(certPem, domain) {
  const certInfo = readCertificateInfo(certPem, domain);

  if (!certInfo.validToMs) {
    return { renew: true, reason: "Certificate validity could not be parsed." };
  }

  if (!certInfo.validFromMs || certInfo.validFromMs > Date.now()) {
    return { renew: true, reason: "Certificate is not valid yet." };
  }

  if (!certInfo.hostMatches) {
    return { renew: true, reason: `Certificate SAN does not match ${domain}.` };
  }

  const msRemaining = certInfo.validToMs - Date.now();
  if (msRemaining <= 0) {
    return { renew: true, reason: "Certificate has expired." };
  }

  if (msRemaining <= SSL_RENEW_BEFORE_MS) {
    const daysLeft = Math.max(1, Math.ceil(msRemaining / DAY_MS));
    return { renew: true, reason: `Certificate expires in ${daysLeft} day(s).` };
  }

  return {
    renew: false,
    reason: "Certificate is still valid.",
    validToMs: certInfo.validToMs,
  };
}

async function loadDomainStateFromStore() {
  const storeRaw = await readTextFileIfExists(STORE_PATH);
  if (!storeRaw) {
    return {
      customDomain: "",
      letsEncryptEmail: "",
      enabled: false,
    };
  }

  const parsed = JSON.parse(storeRaw);
  const domainSettings = parsed?.settings?.domain ?? {};
  const customDomain = normalizeCustomDomainInput(domainSettings.customDomain);
  const letsEncryptEmail = normalizeEmailInput(domainSettings.letsEncryptEmail);

  return {
    customDomain,
    letsEncryptEmail,
    enabled: Boolean(customDomain && letsEncryptEmail),
  };
}

async function ensureAccountKey(accountKeyPath) {
  const current = await readTextFileIfExists(accountKeyPath);
  if (current) {
    return current;
  }

  const generated = await acme.crypto.createPrivateKey();
  const pem = toPemString(generated);
  await secureAtomicWriteFile(accountKeyPath, pem, "utf8");
  return pem;
}

async function issueCertificate(domainState, paths, reason) {
  const accountKey = await ensureAccountKey(paths.accountKey);
  const directoryUrl = LETS_ENCRYPT_STAGING
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  const client = new acme.Client({
    directoryUrl,
    accountKey,
  });

  const [privateKey, csr] = await acme.crypto.createCsr({
    commonName: domainState.customDomain,
    altNames: [domainState.customDomain],
  });

  log(
    `Requesting certificate for ${domainState.customDomain} (${LETS_ENCRYPT_STAGING ? "staging" : "production"}) because: ${reason}`,
  );

  challengeResponses.clear();

  try {
    const certificate = await client.auto({
      csr,
      email: domainState.letsEncryptEmail,
      termsOfServiceAgreed: true,
      challengePriority: ["http-01"],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        challengeResponses.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        challengeResponses.delete(challenge.token);
      },
    });

    const keyPem = toPemString(privateKey);
    const certPem = toPemString(certificate);
    const certInfo = readCertificateInfo(certPem, domainState.customDomain);
    if (!isCertificateInfoUsable(certInfo) || !isCertificateBundleLoadable(keyPem, certPem)) {
      throw new Error(`The certificate authority returned an unusable certificate for ${domainState.customDomain}.`);
    }

    await ensurePrivateDirectory(paths.folder);
    await secureAtomicWriteFile(paths.privateKey, keyPem, "utf8");
    await secureAtomicWriteFile(paths.certificate, certPem, "utf8");

    return {
      key: keyPem,
      cert: certPem,
    };
  } finally {
    challengeResponses.clear();
  }
}

async function issueCertificateWithBackoff(domainState, paths, reason) {
  setRetryDomain(domainState.customDomain);

  const now = Date.now();
  if (certificateRetryState.nextAttemptAtMs > now) {
    const nextRetryAt = toIsoTimestamp(certificateRetryState.nextAttemptAtMs);
    scheduleCertificateRetry(certificateRetryState.nextAttemptAtMs);
    throw new CertificateBackoffError(
      `Certificate issuance for ${domainState.customDomain} is in backoff until ${nextRetryAt}.`,
      certificateRetryState.nextAttemptAtMs,
    );
  }

  sslRuntimeState.certificateLastCheckedAtMs = now;
  sslRuntimeState.certificateLastRenewalReason = reason;
  schedulePersistRuntimeStatus();

  try {
    const bundle = await issueCertificate(domainState, paths, reason);
    const certInfo = readCertificateInfo(bundle.cert, domainState.customDomain);

    certificateRetryState = createCertificateRetryState(domainState.customDomain);
    clearCertificateRetryTimer();

    sslRuntimeState.certificateLastIssuedAtMs = Date.now();
    sslRuntimeState.certificateLastIssueFailedAtMs = 0;
    sslRuntimeState.certificateLastIssueErrorMessage = "";
    sslRuntimeState.certificateExpiresAtMs = certInfo.validToMs ?? 0;
    schedulePersistRuntimeStatus();

    return bundle;
  } catch (error) {
    const failedAt = Date.now();
    certificateRetryState.failureCount += 1;
    certificateRetryState.lastFailureAtMs = failedAt;
    certificateRetryState.lastErrorMessage = getErrorMessage(error);
    certificateRetryState.nextAttemptAtMs = failedAt + getIssueRetryDelayMs(certificateRetryState.failureCount);
    scheduleCertificateRetry(certificateRetryState.nextAttemptAtMs);

    sslRuntimeState.certificateLastIssueFailedAtMs = failedAt;
    sslRuntimeState.certificateLastIssueErrorMessage = certificateRetryState.lastErrorMessage;
    schedulePersistRuntimeStatus();

    warn(
      `Certificate issuance failed for ${domainState.customDomain}; backing off until ${toIsoTimestamp(certificateRetryState.nextAttemptAtMs)}.`,
      error,
    );

    throw new CertificateBackoffError(
      `Certificate issuance failed for ${domainState.customDomain}; next retry at ${toIsoTimestamp(certificateRetryState.nextAttemptAtMs)}.`,
      certificateRetryState.nextAttemptAtMs,
    );
  }
}

async function ensureCertificate(domainState) {
  const paths = getCertificatePaths(domainState.customDomain);
  await ensurePrivateDirectory(SSL_STORAGE_DIR);
  await ensurePrivateDirectory(paths.folder);

  const existingKey = await readTextFileIfExists(paths.privateKey);
  const existingCert = await readTextFileIfExists(paths.certificate);

  if (existingKey && existingCert) {
    const decision = isCertificateBundleLoadable(existingKey, existingCert)
      ? getRenewalDecision(existingCert, domainState.customDomain)
      : { renew: true, reason: "Stored certificate and private key could not be loaded together." };
    sslRuntimeState.certificateLastCheckedAtMs = Date.now();
    sslRuntimeState.certificateLastRenewalReason = decision.reason;
    if (decision.validToMs) {
      sslRuntimeState.certificateExpiresAtMs = decision.validToMs;
    }
    schedulePersistRuntimeStatus();

    if (!decision.renew) {
      const expiresAt = new Date(decision.validToMs).toISOString();
      log(`Using existing certificate for ${domainState.customDomain}; expires at ${expiresAt}.`);
      return {
        key: existingKey,
        cert: existingCert,
      };
    }

    try {
      return await issueCertificateWithBackoff(domainState, paths, decision.reason);
    } catch (error) {
      if (error instanceof CertificateBackoffError && shouldFallbackToExistingCertificate(existingKey, existingCert, domainState.customDomain)) {
        log(
          `Renewal deferred for ${domainState.customDomain}; continuing with existing certificate until ${toIsoTimestamp(sslRuntimeState.certificateExpiresAtMs)}.`,
        );
        return {
          key: existingKey,
          cert: existingCert,
        };
      }

      throw error;
    }
  }

  return issueCertificateWithBackoff(domainState, paths, "No existing certificate was found.");
}

async function ensureHttpsServer(domainState) {
  if (HTTP_PORT === HTTPS_PORT) {
    throw new Error("HTTP and HTTPS ports must differ. Set HTTP_PORT and HTTPS_PORT to different values.");
  }

  const bundle = await ensureCertificate(domainState);
  const certInfo = readCertificateInfo(bundle.cert, domainState.customDomain);
  if (!isCertificateInfoUsable(certInfo) || !isCertificateBundleLoadable(bundle.key, bundle.cert)) {
    throw new Error(`Refusing to activate an unusable certificate for ${domainState.customDomain}.`);
  }

  if (shuttingDown) {
    throw new Error("HTTPS activation was cancelled because the server is shutting down.");
  }

  if (!httpsServer) {
    const candidateServer = https.createServer(
      {
        key: bundle.key,
        cert: bundle.cert,
        minVersion: "TLSv1.2",
      },
      (request, response) => {
        if (tryServeRuntimeStatus(request, response)) {
          return;
        }

        const action = getRuntimeRequestAction(request, "https");
        if (action === "redirect") {
          redirectToHttps(request, response, activeDomainState.customDomain);
          return;
        }

        if (action === "maintenance") {
          writeHttpsMaintenanceResponse(response);
          return;
        }

        void handleRequest(request, response);
      },
    );

    await listen(candidateServer, HTTPS_PORT, LISTEN_HOST);
    if (shuttingDown) {
      await closeServer(candidateServer);
      throw new Error("HTTPS activation was cancelled because the server is shutting down.");
    }

    httpsServer = candidateServer;
    httpsTrafficState = {
      certificateDomain: domainState.customDomain,
      certificateValidFromMs: certInfo.validFromMs,
      certificateExpiresAtMs: certInfo.validToMs,
    };
    log(`HTTPS server is listening on https://${LISTEN_HOST}:${HTTPS_PORT}.`);
    return;
  }

  httpsServer.setSecureContext({
    key: bundle.key,
    cert: bundle.cert,
  });
  httpsTrafficState = {
    certificateDomain: domainState.customDomain,
    certificateValidFromMs: certInfo.validFromMs,
    certificateExpiresAtMs: certInfo.validToMs,
  };

  log(`Reloaded HTTPS certificate for ${domainState.customDomain}.`);
}

async function deactivateHttpsServer(reason = "automatic SSL is disabled in Domain Settings") {
  if (!httpsServer) {
    httpsTrafficState = { certificateDomain: "", certificateValidFromMs: 0, certificateExpiresAtMs: 0 };
    return;
  }

  await closeServer(httpsServer);
  httpsServer = null;
  httpsTrafficState = { certificateDomain: "", certificateValidFromMs: 0, certificateExpiresAtMs: 0 };
  log(`HTTPS server stopped because ${reason}.`);
}

function scheduleRefreshFromStoreWatcher(eventType) {
  if (storeWatchDebounceTimer) {
    clearTimeout(storeWatchDebounceTimer);
  }

  storeWatchDebounceTimer = setTimeout(() => {
    storeWatchDebounceTimer = null;
    void refreshDomainState(`store-change:${eventType}`);
  }, SSL_STORE_WATCH_DEBOUNCE_MS);
  storeWatchDebounceTimer.unref?.();
}

async function startStoreWatcher() {
  if (storeWatcher || shuttingDown) {
    return;
  }

  const storeDir = path.dirname(STORE_PATH);
  const storeFile = path.basename(STORE_PATH);

  await ensurePrivateDirectory(storeDir);
  if (shuttingDown) {
    return;
  }

  storeWatcher = watch(storeDir, (eventType, filename) => {
    const changedFile = typeof filename === "string" ? filename : filename?.toString();
    if (!changedFile || changedFile === storeFile) {
      scheduleRefreshFromStoreWatcher(eventType || "change");
    }
  });

  storeWatcher.on("error", (error) => {
    warn("Store watcher stopped unexpectedly.", error);
  });

  log(`Watching ${STORE_PATH} for domain setting changes.`);
}

function stopStoreWatcher() {
  if (storeWatchDebounceTimer) {
    clearTimeout(storeWatchDebounceTimer);
    storeWatchDebounceTimer = null;
  }

  if (storeWatcher) {
    storeWatcher.close();
    storeWatcher = null;
  }
}

async function refreshDomainState(reason) {
  if (shuttingDown) {
    return;
  }

  if (refreshPromise) {
    queuedRefreshReason = reason;
    return refreshPromise;
  }

  refreshPromise = (async () => {
    sslRuntimeState.phase = "refreshing";
    sslRuntimeState.lastRefreshReason = reason;
    sslRuntimeState.lastRefreshStartedAtMs = Date.now();
    schedulePersistRuntimeStatus();

    const desired = await loadDomainStateFromStore();
    const customDomainChanged = desired.customDomain !== activeDomainState.customDomain;
    const domainSettingsChanged = customDomainChanged || desired.letsEncryptEmail !== activeDomainState.letsEncryptEmail;
    if (domainSettingsChanged) {
      certificateRetryState = createCertificateRetryState(desired.customDomain);
      clearCertificateRetryTimer();
    }

    if (customDomainChanged) {
      sslRuntimeState.certificateExpiresAtMs = 0;
      sslRuntimeState.certificateLastCheckedAtMs = 0;
      sslRuntimeState.certificateLastRenewalReason = "";
      sslRuntimeState.certificateLastIssuedAtMs = 0;
      sslRuntimeState.certificateLastIssueFailedAtMs = 0;
      sslRuntimeState.certificateLastIssueErrorMessage = "";
    }

    if (!desired.enabled) {
      activeDomainState = desired;
      clearCertificateRetryTimer();
      if (httpsServer) {
        await deactivateHttpsServer();
      }

      sslRuntimeState.phase = "http-only";
      sslRuntimeState.lastRefreshSucceededAtMs = Date.now();
      sslRuntimeState.lastRefreshErrorMessage = "";
      schedulePersistRuntimeStatus();
      log(`Automatic SSL check (${reason}) complete: SSL is disabled.`);
      return;
    }

    activeDomainState = desired;

    // A listener for the previous domain, or one whose installed certificate has just
    // expired, must not remain capable of forwarding application content during recovery.
    if (httpsServer && !isActiveDomainHttpsAvailable()) {
      await deactivateHttpsServer(customDomainChanged ? "the configured custom domain changed" : "its installed certificate is no longer valid");
    }

    if (!shouldRunHttpsRefresh(reason, domainSettingsChanged)) {
      sslRuntimeState.phase = "https-ready";
      sslRuntimeState.lastRefreshSucceededAtMs = Date.now();
      sslRuntimeState.lastRefreshErrorMessage = "";
      schedulePersistRuntimeStatus();
      log(`Automatic SSL check (${reason}) skipped: domain settings unchanged for ${activeDomainState.customDomain}.`);
      return;
    }

    await ensureHttpsServer(desired);
    // Listener activation failures share the bounded retry scheduler with issuance. Clear
    // those resolved runtime retries, but preserve a pending renewal retry when the listener
    // deliberately stayed online with its still-valid previous certificate.
    if (!sslRuntimeState.certificateLastIssueFailedAtMs) {
      certificateRetryState = createCertificateRetryState(desired.customDomain);
      clearCertificateRetryTimer();
    }

    sslRuntimeState.phase = "https-ready";
    sslRuntimeState.lastRefreshSucceededAtMs = Date.now();
    sslRuntimeState.lastRefreshErrorMessage = "";
    schedulePersistRuntimeStatus();

    log(`Automatic SSL check (${reason}) complete for ${activeDomainState.customDomain}.`);
  })().catch(async (error) => {
    if (shuttingDown) {
      return;
    }

    sslRuntimeState.lastRefreshFailedAtMs = Date.now();
    sslRuntimeState.lastRefreshErrorMessage = getErrorMessage(error);
    sslRuntimeState.phase = error instanceof CertificateBackoffError ? "backoff" : "error";

    if (!(error instanceof CertificateBackoffError) && activeDomainState.enabled && !isActiveDomainHttpsAvailable()) {
      const failedAt = Date.now();
      setRetryDomain(activeDomainState.customDomain);
      certificateRetryState.failureCount += 1;
      certificateRetryState.lastFailureAtMs = failedAt;
      certificateRetryState.lastErrorMessage = getErrorMessage(error);
      certificateRetryState.nextAttemptAtMs = failedAt + getIssueRetryDelayMs(certificateRetryState.failureCount);
      scheduleCertificateRetry(certificateRetryState.nextAttemptAtMs);
    }

    if (activeDomainState.enabled && httpsServer && !isActiveDomainHttpsAvailable()) {
      try {
        await deactivateHttpsServer("valid HTTPS is unavailable");
      } catch (closeError) {
        warn("Failed to stop an unavailable HTTPS listener.", closeError);
      }
    }

    schedulePersistRuntimeStatus();

    if (error instanceof CertificateBackoffError) {
      log(error.message);
      return;
    }

    warn("Automatic SSL refresh failed.", error);
  });

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }

  if (queuedRefreshReason && !shuttingDown) {
    const nextReason = queuedRefreshReason;
    queuedRefreshReason = null;
    await refreshDomainState(`queued:${nextReason}`);
  }
}

async function handleRequest(request, response) {
  const requestHandler = app.getRequestHandler();

  try {
    setInternalClientIpHeader(request);
    await requestHandler(request, response);
  } catch (error) {
    warn("Next.js request handler failed.", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    if (!response.writableEnded) {
      response.end("Internal Server Error");
    }
  }
}

async function start() {
  await ensurePrivateDirectory(SSL_STORAGE_DIR);
  await app.prepare();
  activeDomainState = await loadDomainStateFromStore();

  httpServer = http.createServer((request, response) => {
    const requestContext = {
      requestUrl: request.url,
      requestHost: request.headers.host,
      configuredDomain: activeDomainState.enabled ? activeDomainState.customDomain : "",
      httpsAvailable: isActiveDomainHttpsAvailable(),
      serveChallenge: () => tryServeChallenge(request, response),
      serveRedirect: () => redirectToHttps(request, response, activeDomainState.customDomain),
      serveMaintenance: () => writeHttpsMaintenanceResponse(response),
      serveRuntimeStatus: () => tryServeRuntimeStatus(request, response),
      serveApplication: () => void handleRequest(request, response),
    };
    routeRuntimeHttpRequest(requestContext);
  });

  await listen(httpServer, HTTP_PORT, LISTEN_HOST);
  log(`HTTP server is listening on http://${LISTEN_HOST}:${HTTP_PORT}.`);

  await refreshDomainState("startup");
  if (shuttingDown) {
    return;
  }

  await startStoreWatcher();
  await flushRuntimeStatus();

  if (shuttingDown) {
    return;
  }

  sslCheckTimer = setInterval(() => {
    void refreshDomainState("periodic");
  }, SSL_CHECK_INTERVAL_MS);
  sslCheckTimer.unref?.();
}

async function performShutdown(signal) {
  log(`Received ${signal}, shutting down.`);
  shuttingDown = true;
  queuedRefreshReason = null;
  challengeResponses.clear();

  if (sslCheckTimer) {
    clearInterval(sslCheckTimer);
    sslCheckTimer = null;
  }

  clearCertificateRetryTimer();

  stopStoreWatcher();

  sslRuntimeState.phase = "stopped";

  const operations = [];
  operations.push(stopGitHubLocalizationUploadQueue().catch((error) => warn("Failed to stop the GitHub localization upload queue.", error)));
  if (httpsServer) {
    operations.push(
      closeServer(httpsServer)
        .then(() => {
          httpsServer = null;
          httpsTrafficState = { certificateDomain: "", certificateValidFromMs: 0, certificateExpiresAtMs: 0 };
        })
        .catch((error) => warn("Failed to close HTTPS server.", error)),
    );
  }

  if (httpServer) {
    operations.push(
      closeServer(httpServer)
        .then(() => {
          httpServer = null;
        })
        .catch((error) => warn("Failed to close HTTP server.", error)),
    );
  }

  await Promise.all(operations);
  await flushRuntimeStatus();
  process.exit(0);
}

function shutdown(signal) {
  // npm can forward a terminal signal that the child already received directly. Reuse one shutdown operation to avoid closing servers twice.
  shutdownPromise ??= performShutdown(signal);
  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

start().catch(async (error) => {
  warn("Startup failed.", error);
  sslRuntimeState.phase = "error";
  sslRuntimeState.lastRefreshFailedAtMs = Date.now();
  sslRuntimeState.lastRefreshErrorMessage = getErrorMessage(error);
  try {
    await flushRuntimeStatus();
  } catch (statusError) {
    warn("Failed to persist status during startup failure.", statusError);
  }
  process.exit(1);
});
