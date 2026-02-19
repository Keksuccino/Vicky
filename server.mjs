import http from "node:http";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import * as acme from "acme-client";
import next from "next";

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
const IS_DEV = process.env.NODE_ENV !== "production";
const DAY_MS = 24 * 60 * 60 * 1000;

const challengeResponses = new Map();

let activeDomainState = {
  customDomain: "",
  letsEncryptEmail: "",
  enabled: false,
};

let refreshPromise = null;
let httpsServer = null;
let httpServer = null;
let sslCheckTimer = null;

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

function toPemString(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function normalizeCustomDomain(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  const maybeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(maybeUrl);

    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return "";
    }

    const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (!hostname || hostname.includes("..")) {
      return "";
    }

    if (!/^[a-z0-9.-]+$/.test(hostname)) {
      return "";
    }

    if (!hostname.includes(".") || !/[a-z]/.test(hostname)) {
      return "";
    }

    return hostname;
  } catch {
    return "";
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
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
    const customDomain = normalizeCustomDomain(domainSettings.customDomain);
    const letsEncryptEmail = normalizeEmail(domainSettings.letsEncryptEmail);

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

  await mkdir(path.dirname(accountKeyPath), { recursive: true });
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

    await mkdir(paths.folder, { recursive: true });
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

async function ensureCertificate(domainState) {
  const paths = getCertificatePaths(domainState.customDomain);
  const existingKey = await readTextFileIfExists(paths.privateKey);
  const existingCert = await readTextFileIfExists(paths.certificate);

  if (existingKey && existingCert) {
    const decision = getRenewalDecision(existingCert, domainState.customDomain);
    if (!decision.renew) {
      const expiresAt = new Date(decision.validToMs).toISOString();
      log(`Using existing certificate for ${domainState.customDomain}; expires at ${expiresAt}.`);
      return {
        key: existingKey,
        cert: existingCert,
      };
    }

    return issueCertificate(domainState, paths, decision.reason);
  }

  return issueCertificate(domainState, paths, "No existing certificate was found.");
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

async function refreshDomainState(reason) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const desired = await loadDomainStateFromStore();
    if (!desired.enabled) {
      if (activeDomainState.enabled || httpsServer) {
        activeDomainState = desired;
        await deactivateHttpsServer();
      } else {
        activeDomainState = desired;
      }
      return;
    }

    await ensureHttpsServer(desired);
    activeDomainState = desired;

    log(`Automatic SSL check (${reason}) complete for ${activeDomainState.customDomain}.`);
  })().catch((error) => {
    warn("Automatic SSL refresh failed.", error);
  });

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
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
  await app.prepare();

  httpServer = http.createServer((request, response) => {
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

  const operations = [];
  if (httpsServer) {
    operations.push(closeServer(httpsServer).catch((error) => warn("Failed to close HTTPS server.", error)));
  }

  if (httpServer) {
    operations.push(closeServer(httpServer).catch((error) => warn("Failed to close HTTP server.", error)));
  }

  await Promise.all(operations);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

start().catch((error) => {
  warn("Startup failed.", error);
  process.exit(1);
});
