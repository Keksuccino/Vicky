import http from "node:http";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { watch } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import * as acme from "acme-client";
import next from "next";

import { normalizeCustomDomainInput, normalizeEmailInput } from "./src/lib/domain-normalization.mjs";

const ACME_CHALLENGE_PREFIX = "/.well-known/acme-challenge/";
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
const SSL_STATUS_ENDPOINT_PATH = normalizeStatusEndpointPath(
  process.env.SSL_STATUS_ENDPOINT_PATH ?? "/.well-known/vicky/ssl-status",
);
const SSL_STATUS_BEARER_TOKEN = String(process.env.SSL_STATUS_BEARER_TOKEN ?? "").trim();
const SSL_STATUS_FILE_PATH = process.env.SSL_STATUS_FILE_PATH ?? path.join(SSL_STORAGE_DIR, "runtime-ssl-status.json");
const IS_DEV = process.env.NODE_ENV !== "production";
const DAY_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_PERMISSION_MODE = 0o700;

const challengeResponses = new Map();

let activeDomainState = {
  customDomain: "",
  letsEncryptEmail: "",
  enabled: false,
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
let storeWatcher = null;
let storeWatchDebounceTimer = null;
let statusPersistTimer = null;
let statusPersistQueue = Promise.resolve();

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

function buildRuntimeStatusSnapshot() {
  return {
    schemaVersion: 1,
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

async function ensureSecureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_PERMISSION_MODE });

  try {
    await chmod(directoryPath, DIRECTORY_PERMISSION_MODE);
  } catch (error) {
    if (error && typeof error === "object") {
      const code = error.code;
      if (code === "ENOSYS" || code === "EINVAL" || code === "EPERM") {
        return;
      }
    }
    throw error;
  }
}

function queuePersistRuntimeStatus() {
  const payload = JSON.stringify(buildRuntimeStatusSnapshot(), null, 2);

  statusPersistQueue = statusPersistQueue
    .then(async () => {
      await ensureSecureDirectory(path.dirname(SSL_STATUS_FILE_PATH));
      await writeFile(SSL_STATUS_FILE_PATH, payload, {
        encoding: "utf8",
        mode: 0o600,
      });
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

function getHostWithoutPort(headerValue) {
  if (!headerValue) {
    return "";
  }

  const first = String(Array.isArray(headerValue) ? headerValue[0] : headerValue)
    .split(",")[0]
    .trim();

  if (!first) {
    return "";
  }

  if (first.startsWith("[")) {
    const index = first.indexOf("]");
    if (index > 1) {
      return first.slice(1, index).toLowerCase();
    }
  }

  return first.split(":")[0].toLowerCase();
}

function formatHttpsAuthority(domain) {
  return HTTPS_PORT === 443 ? domain : `${domain}:${HTTPS_PORT}`;
}

function shouldRedirectToCanonicalHost(request) {
  if (!activeDomainState.enabled) {
    return false;
  }

  const requestedHost = getHostWithoutPort(request.headers.host);
  if (!requestedHost) {
    return false;
  }

  return requestedHost !== activeDomainState.customDomain;
}

function redirectToHttps(request, response, domain) {
  const location = `https://${formatHttpsAuthority(domain)}${request.url || "/"}`;
  response.writeHead(308, {
    Location: location,
    "Cache-Control": "no-store",
  });
  response.end();
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

function isStatusRequestAuthorized(request) {
  if (!SSL_STATUS_BEARER_TOKEN) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return false;
  }

  return authHeader === `Bearer ${SSL_STATUS_BEARER_TOKEN}`;
}

function tryServeRuntimeStatus(request, response) {
  if (request.method !== "GET") {
    return false;
  }

  if (getRequestPath(request) !== SSL_STATUS_ENDPOINT_PATH) {
    return false;
  }

  if (!isStatusRequestAuthorized(request)) {
    response.writeHead(401, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": 'Bearer realm="vicky-ssl-status"',
    });
    response.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(buildRuntimeStatusSnapshot(), null, 2));
  return true;
}

function getChallengeToken(requestUrl) {
  if (!requestUrl.startsWith(ACME_CHALLENGE_PREFIX)) {
    return null;
  }

  const rawToken = requestUrl.slice(ACME_CHALLENGE_PREFIX.length).split("?")[0];
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

function shouldFallbackToExistingCertificate(certPem, domain) {
  const certInfo = readCertificateInfo(certPem, domain);
  if (!certInfo.validToMs || !certInfo.hostMatches) {
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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readTextFileIfExists(filePath) {
  try {
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
    const validToMs = Date.parse(cert.validTo);
    const hostMatch = cert.checkHost(domain);

    return {
      validToMs: Number.isFinite(validToMs) ? validToMs : null,
      hostMatches: Boolean(hostMatch),
    };
  } catch {
    return {
      validToMs: null,
      hostMatches: false,
    };
  }
}

function getRenewalDecision(certPem, domain) {
  const certInfo = readCertificateInfo(certPem, domain);

  if (!certInfo.validToMs) {
    return { renew: true, reason: "Certificate validity could not be parsed." };
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
  try {
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
  } catch (error) {
    warn("Failed to load domain settings from store.", error);
    return {
      customDomain: "",
      letsEncryptEmail: "",
      enabled: false,
    };
  }
}

async function ensureAccountKey(accountKeyPath) {
  const current = await readTextFileIfExists(accountKeyPath);
  if (current) {
    return current;
  }

  await ensureSecureDirectory(path.dirname(accountKeyPath));
  const generated = await acme.crypto.createPrivateKey();
  const pem = toPemString(generated);
  await writeFile(accountKeyPath, pem, { encoding: "utf8", mode: 0o600 });
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

    await ensureSecureDirectory(paths.folder);
    await writeFile(paths.privateKey, keyPem, { encoding: "utf8", mode: 0o600 });
    await writeFile(paths.certificate, certPem, { encoding: "utf8", mode: 0o600 });

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
  await ensureSecureDirectory(SSL_STORAGE_DIR);
  await ensureSecureDirectory(paths.folder);

  const existingKey = await readTextFileIfExists(paths.privateKey);
  const existingCert = await readTextFileIfExists(paths.certificate);

  if (existingKey && existingCert) {
    const decision = getRenewalDecision(existingCert, domainState.customDomain);
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
      if (error instanceof CertificateBackoffError && shouldFallbackToExistingCertificate(existingCert, domainState.customDomain)) {
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

  if (!httpsServer) {
    httpsServer = https.createServer(
      {
        key: bundle.key,
        cert: bundle.cert,
        minVersion: "TLSv1.2",
      },
      (request, response) => {
        if (tryServeRuntimeStatus(request, response)) {
          return;
        }

        if (shouldRedirectToCanonicalHost(request)) {
          redirectToHttps(request, response, activeDomainState.customDomain);
          return;
        }

        void handleRequest(request, response);
      },
    );

    await listen(httpsServer, HTTPS_PORT, LISTEN_HOST);
    log(`HTTPS server is listening on https://${LISTEN_HOST}:${HTTPS_PORT}.`);
    return;
  }

  httpsServer.setSecureContext({
    key: bundle.key,
    cert: bundle.cert,
  });

  log(`Reloaded HTTPS certificate for ${domainState.customDomain}.`);
}

async function deactivateHttpsServer() {
  if (!httpsServer) {
    return;
  }

  await closeServer(httpsServer);
  httpsServer = null;
  log("HTTPS server stopped because automatic SSL is disabled in Domain Settings.");
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
  if (storeWatcher) {
    return;
  }

  const storeDir = path.dirname(STORE_PATH);
  const storeFile = path.basename(STORE_PATH);

  await mkdir(storeDir, { recursive: true });

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
    const domainSettingsChanged =
      desired.customDomain !== activeDomainState.customDomain || desired.letsEncryptEmail !== activeDomainState.letsEncryptEmail;
    if (domainSettingsChanged) {
      certificateRetryState = createCertificateRetryState(desired.customDomain);
    }

    if (!desired.enabled) {
      if (activeDomainState.enabled || httpsServer) {
        activeDomainState = desired;
        await deactivateHttpsServer();
      } else {
        activeDomainState = desired;
      }

      sslRuntimeState.phase = "http-only";
      sslRuntimeState.lastRefreshSucceededAtMs = Date.now();
      sslRuntimeState.lastRefreshErrorMessage = "";
      schedulePersistRuntimeStatus();
      log(`Automatic SSL check (${reason}) complete: SSL is disabled.`);
      return;
    }

    await ensureHttpsServer(desired);
    activeDomainState = desired;

    sslRuntimeState.phase = "https-ready";
    sslRuntimeState.lastRefreshSucceededAtMs = Date.now();
    sslRuntimeState.lastRefreshErrorMessage = "";
    schedulePersistRuntimeStatus();

    log(`Automatic SSL check (${reason}) complete for ${activeDomainState.customDomain}.`);
  })().catch((error) => {
    sslRuntimeState.lastRefreshFailedAtMs = Date.now();
    sslRuntimeState.lastRefreshErrorMessage = getErrorMessage(error);
    sslRuntimeState.phase = error instanceof CertificateBackoffError ? "backoff" : "error";
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

  if (queuedRefreshReason) {
    const nextReason = queuedRefreshReason;
    queuedRefreshReason = null;
    await refreshDomainState(`queued:${nextReason}`);
  }
}

async function handleRequest(request, response) {
  const requestHandler = app.getRequestHandler();

  try {
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
  await ensureSecureDirectory(SSL_STORAGE_DIR);
  await app.prepare();

  httpServer = http.createServer((request, response) => {
    if (tryServeRuntimeStatus(request, response)) {
      return;
    }

    if (tryServeChallenge(request, response)) {
      return;
    }

    if (activeDomainState.enabled) {
      redirectToHttps(request, response, activeDomainState.customDomain);
      return;
    }

    void handleRequest(request, response);
  });

  await listen(httpServer, HTTP_PORT, LISTEN_HOST);
  log(`HTTP server is listening on http://${LISTEN_HOST}:${HTTP_PORT}.`);

  await refreshDomainState("startup");
  await startStoreWatcher();
  await flushRuntimeStatus();

  sslCheckTimer = setInterval(() => {
    void refreshDomainState("periodic");
  }, SSL_CHECK_INTERVAL_MS);
  sslCheckTimer.unref?.();
}

async function shutdown(signal) {
  log(`Received ${signal}, shutting down.`);

  if (sslCheckTimer) {
    clearInterval(sslCheckTimer);
    sslCheckTimer = null;
  }

  stopStoreWatcher();

  sslRuntimeState.phase = "stopped";

  const operations = [];
  if (httpsServer) {
    operations.push(
      closeServer(httpsServer)
        .then(() => {
          httpsServer = null;
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
